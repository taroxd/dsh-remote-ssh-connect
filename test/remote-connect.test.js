// Unit and integration tests for dsh-remote-connect using strictly synthetic RFC 5737 test fixtures.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  RemoteConnectionManager,
  acquireLocalPort,
  apply as applyHostPlugin,
  buildKillRemotePortScript,
  buildRemoteBootstrapScript,
  classifyInstallSource,
  comparePluginVersions,
  hostBlockMatches,
  isConcreteHostPattern,
  listLocalPlugins,
  loadSshConfigHosts,
  normalizeHostConfig,
  openUrlInDefaultBrowser,
  packLocalPluginDirectory,
  parseSshConfigText,
  resolveHostsFromBlocks,
  validateHostConfigInput,
} from '../index.js'
import { AskpassCoordinator, classifyAuthPrompt } from '../src/askpass-server.js'
import { EVENT_PREFIX } from '../src/remote-script.js'

async function runTests() {
  // 1. SSH config parsing & wildcard exclusion (VS Code Remote-SSH rules)
  {
    const sampleConfig = `
# Global defaults
ServerAliveInterval 30
User global-user

Host *
  ForwardAgent yes
  Port 2222

Host alpha-* !alpha-excluded.corp.example.test
  User corp-user
  ProxyJump jump.corp.example.test

Host alpha-dev beta-staging *.wildcard.example.test !negated-host
  HostName %h.corp.example.test
  Port 2200

Host gamma-prod
  HostName=198.51.100.42
  User="prod-admin"
  IdentityFile ~/.ssh/id_ed25519_prod

Match host 203.0.113.*
  User match-ignored-user
`
    const parsed = parseSshConfigText(sampleConfig, '/mock/.ssh/config')
    const hosts = resolveHostsFromBlocks(parsed.concreteHosts, parsed.blocks)

    assert.deepEqual(
      hosts.map((h) => h.alias),
      ['alpha-dev', 'beta-staging', 'gamma-prod'],
      'Wildcard (*, ?) and negated (!) patterns and Match blocks must be excluded from listed hosts',
    )

    const alpha = hosts.find((h) => h.alias === 'alpha-dev')
    assert.equal(alpha.hostName, 'alpha-dev.corp.example.test')
    assert.equal(alpha.port, 2222, 'First matching Host * Port 2222 wins per OpenSSH first-wins rule')
    assert.equal(alpha.user, 'global-user', 'Top-level User before Host blocks applies first')
    assert.equal(alpha.proxyJump, 'jump.corp.example.test')

    const gamma = hosts.find((h) => h.alias === 'gamma-prod')
    assert.equal(gamma.hostName, '198.51.100.42')
    assert.equal(gamma.identityFiles.length, 1)

    assert.equal(isConcreteHostPattern('my-box'), true)
    assert.equal(isConcreteHostPattern('*.example.com'), false)
    assert.equal(isConcreteHostPattern('host-?'), false)
    assert.equal(isConcreteHostPattern('!excluded'), false)
    assert.equal(hostBlockMatches(['*.example.test', '!bad.example.test'], 'good.example.test'), true)
    assert.equal(hostBlockMatches(['*.example.test', '!bad.example.test'], 'bad.example.test'), false)
  }

  // 2. SSH config Include directive expansion
  {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-sshcfg-test-'))
    try {
      const sshDir = join(tmpRoot, '.ssh')
      const confD = join(sshDir, 'config.d')
      await mkdir(confD, { recursive: true })

      await writeFile(
        join(confD, '10-work.conf'),
        [
          'Host work-node-1',
          '  HostName 198.51.100.11',
          '  User alice',
          '  Port 2201',
          '',
          'Host work-*',
          '  ProxyJump bastion-host',
        ].join('\n'),
        'utf8',
      )

      await writeFile(
        join(sshDir, 'config'),
        [
          'Include config.d/*.conf',
          '',
          'Host bastion-host',
          '  HostName 203.0.113.1',
          '  User jumpuser',
        ].join('\n'),
        'utf8',
      )

      const loaded = await loadSshConfigHosts({
        homeDir: tmpRoot,
        sshDir,
        configPath: join(sshDir, 'config'),
      })

      assert.equal(loaded.exists, true)
      assert.deepEqual(
        loaded.hosts.map((h) => h.alias),
        ['work-node-1', 'bastion-host'],
      )
      assert.equal(loaded.hosts[0].hostName, '198.51.100.11')
      assert.equal(loaded.hosts[0].user, 'alice')
      assert.equal(loaded.hosts[0].port, 2201)
      assert.equal(loaded.hosts[0].proxyJump, 'bastion-host')
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  // 3. Host configuration validation & defaults
  {
    const def = normalizeHostConfig({})
    assert.deepEqual(def, { remotePort: 3080, localPort: 0, profile: 'web' })

    const valid = validateHostConfigInput({ remotePort: 4090, localPort: 0, profile: 'custom-team' })
    assert.deepEqual(valid, { remotePort: 4090, localPort: 0, profile: 'custom-team' })

    assert.throws(() => validateHostConfigInput({ remotePort: 0 }), /Remote port/)
    assert.throws(() => validateHostConfigInput({ localPort: -1 }), /Local port/)
    assert.throws(() => validateHostConfigInput({ profile: 'desktop' }), /reserved/)
  }

  // 4. Local port allocation & conflict detection
  {
    const port = await acquireLocalPort(0)
    assert.equal(typeof port, 'number')
    assert.equal(port > 0 && port <= 65535, true)
  }

  // 5. Remote bootstrap & kill script generation
  {
    const { script, supervisorJs, encodedScript, sshCommand } = buildRemoteBootstrapScript({
      dshVersion: '0.2.2-rc.3',
      remotePort: 3080,
      localPort: 54321,
      profile: 'custom-profile',
    })
    assert.equal(script.includes("DSH_VERSION='0.2.2-rc.3'"), true)
    assert.equal(script.includes('REMOTE_PORT=3080'), true)
    assert.equal(script.includes('LOCAL_PORT=54321'), true)
    assert.equal(supervisorJs.includes('--from-default-profile'), true)
    assert.equal(script.includes('MAX_VERSIONS=3'), true)
    assert.equal(script.includes('bash -lic'), true)
    assert.equal(script.includes('.bashrc'), true)
    assert.equal(typeof encodedScript, 'string')
    assert.ok(encodedScript.length > 100)
    assert.equal(sshCommand.startsWith('mkdir -p ~/.dsh-remote-connect && IFS= read -r B'), true)
    assert.ok(sshCommand.length < 250, 'sshCommand must stay compact to avoid ENAMETOOLONG on Windows')

    const killCmd = buildKillRemotePortScript(3080)
    assert.equal(killCmd.startsWith('mkdir -p ~/.dsh-remote-connect && printf %s '), true)
  }

  // 6. Browser opener & fallback URL support
  {
    const headlessLinuxResult = await openUrlInDefaultBrowser('http://127.0.0.1:45678/?token=test', {
      platform: 'linux',
      env: {},
    })
    assert.equal(headlessLinuxResult.opened, false)
    assert.equal(headlessLinuxResult.fallbackRequired, true)
    assert.equal(headlessLinuxResult.url, 'http://127.0.0.1:45678/?token=test')

    let launchCount = 0
    const mockSuccessResult1 = await openUrlInDefaultBrowser('http://127.0.0.1:45678/?token=test', {
      platform: 'win32',
      env: { SESSIONNAME: 'Console' },
      execOpener: async () => {
        launchCount += 1
        return { ok: true }
      },
    })
    const mockSuccessResult2 = await openUrlInDefaultBrowser('http://127.0.0.1:45678/?token=test', {
      platform: 'win32',
      env: { SESSIONNAME: 'Console' },
      execOpener: async () => {
        launchCount += 1
        return { ok: true }
      },
    })
    assert.equal(mockSuccessResult1.opened, true)
    assert.equal(mockSuccessResult2.opened, true)
    assert.equal(launchCount, 2, 'Clicking Open Remote DSH repeatedly must invoke browser opener each time')
  }

  // 7. Askpass prompt classification & coordinator
  {
    assert.equal(classifyAuthPrompt("alice@example's password:"), 'password')
    assert.equal(classifyAuthPrompt('Verification code (OTP):'), 'otp')
    assert.equal(classifyAuthPrompt('Enter passphrase for key /home/alice/.ssh/id_ed25519:'), 'passphrase')
    assert.equal(classifyAuthPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])?'), 'confirm')

    const promptsSeen = []
    const coordinator = new AskpassCoordinator({
      onPromptChanged: (host, p) => promptsSeen.push({ host, p }),
    })
    await coordinator.start()
    try {
      const sessEnv = coordinator.createSessionEnv('test-host')
      assert.equal(typeof sessEnv.env.DSH_RC_ASKPASS_URL, 'string')

      // Simulate askpass HTTP request from ssh
      const askPromise = fetch(sessEnv.env.DSH_RC_ASKPASS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: sessEnv.token, prompt: 'Password:' }),
      }).then((r) => r.json())

      // Wait briefly for server to register prompt
      await new Promise((r) => setTimeout(r, 50))
      const pending = coordinator.getPendingPromptForHost('test-host')
      assert.ok(pending)
      assert.equal(pending.prompt, 'Password:')
      assert.equal(pending.kind, 'password')

      // Submit password + OTP combined
      coordinator.submitForHost('test-host', pending.id, 'myPass123456')
      const response = await askPromise
      assert.deepEqual(response, { ok: true, value: 'myPass123456' })
      sessEnv.dispose()
    } finally {
      await coordinator.stop()
    }
  }

  // 8. Full RemoteConnectionManager lifecycle: Password + OTP auth, port conflict, kill-port, connect, open browser, disconnect
  {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-mgr-test-'))
    try {
      const sshConfigPath = join(tmpRoot, 'config')
      await writeFile(
        sshConfigPath,
        [
          'Host otp-node',
          '  HostName 198.51.100.99',
          '  User devops',
          '  Port 22',
        ].join('\n'),
        'utf8',
      )

      let attempt = 0
      const receivedAuthAnswers = []
      const killedPorts = []

      const mockSpawn = (_cmd, args, opts) => {
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.exitCode = null
        child.killed = false
        child.kill = () => {
          child.killed = true
          child.exitCode = 0
          child.emit('close', 0)
        }

        // Check if this is killRemotePortOccupant or connectHost
        const isTunnel = args.includes('-L')
        if (!isTunnel) {
          killedPorts.push(args)
          setTimeout(() => {
            child.stdout.write(`${EVENT_PREFIX}{"type":"kill_result","ok":true}\n`)
            child.exitCode = 0
            child.emit('close', 0)
          }, 10)
          return child
        }

        attempt += 1
        const currentAttempt = attempt

        ;(async () => {
          // Simulate two-step Password + OTP prompt via Askpass HTTP endpoint
          const askUrl = opts.env.DSH_RC_ASKPASS_URL
          const askToken = opts.env.DSH_RC_ASKPASS_TOKEN

          if (currentAttempt === 1) {
            // Step 1: Password prompt
            const res1 = await fetch(askUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: askToken, prompt: "devops@198.51.100.99's password:" }),
            }).then((r) => r.json())
            receivedAuthAnswers.push(res1.value)

            // Step 2: OTP prompt
            const res2 = await fetch(askUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: askToken, prompt: 'One-time password (OTP):' }),
            }).then((r) => r.json())
            receivedAuthAnswers.push(res2.value)

            // Simulate remote port 3080 already in use on attempt 1
            child.stdout.write(`${EVENT_PREFIX}{"type":"port_in_use","port":3080,"pid":9876,"command":"dsh --profile web"}\n`)
            child.exitCode = 42
            child.emit('close', 42)
            return
          }

          // Attempt 2: succeeds and emits ready
          child.stdout.write(`${EVENT_PREFIX}{"type":"phase","phase":"installing_dsh","version":"0.2.2-rc.3"}\n`)
          child.stdout.write(`${EVENT_PREFIX}{"type":"dsh_ready","version":"0.2.2-rc.3","cached":false}\n`)
          child.stdout.write(`${EVENT_PREFIX}{"type":"version_pruned","version":"0.1.0"}\n`)
          child.stdout.write(`${EVENT_PREFIX}{"type":"ready","url":"http://127.0.0.1:41234/?token=abc","remotePort":3080,"localPort":41234,"profile":"custom-prof","pid":4321,"initializedFromWeb":true}\n`)

          child.stdin.on('data', (chunk) => {
            if (String(chunk).includes('SHUTDOWN')) {
              child.stdout.write(`${EVENT_PREFIX}{"type":"stopped","reason":"client_shutdown"}\n`)
              child.exitCode = 0
              child.emit('close', 0)
            }
          })
        })()

        return child
      }

      const manager = new RemoteConnectionManager({
        sshConfigPath,
        dshVersion: '0.2.2-rc.3',
        spawnProcess: mockSpawn,
        openBrowser: async (url) => ({ opened: false, url, fallbackRequired: true, reason: 'Headless test environment' }),
      })

      await manager.init()
      try {
        await manager.configureHost('otp-node', { remotePort: 3080, localPort: 0, profile: 'custom-prof' })

        // Start attempt 1 without blocking so we can answer both Password and OTP prompts
        await manager.connectHost('otp-node', { waitForReady: false })

        // Wait for Password prompt
        await new Promise((r) => setTimeout(r, 40))
        let st = await manager.getHostStatus('otp-node')
        assert.equal(st.phase, 'awaiting_auth')
        assert.equal(st.authPrompt?.kind, 'password')
        manager.submitAuth('otp-node', { promptId: st.authPrompt.id, value: 'hunter2' })

        // Wait for OTP prompt
        await new Promise((r) => setTimeout(r, 40))
        st = await manager.getHostStatus('otp-node')
        assert.equal(st.phase, 'awaiting_auth')
        assert.equal(st.authPrompt?.kind, 'otp')
        manager.submitAuth('otp-node', { promptId: st.authPrompt.id, value: '654321' })

        // Wait for attempt 1 to settle with REMOTE_PORT_IN_USE
        await new Promise((r) => setTimeout(r, 50))
        st = await manager.getHostStatus('otp-node')
        assert.deepEqual(receivedAuthAnswers, ['hunter2', '654321'])
        assert.equal(st.status, 'error')
        assert.equal(st.error?.code, 'REMOTE_PORT_IN_USE')
        assert.equal(st.error?.occupantPid, 9876)

        // Now resolve port conflict via killRemotePortOccupant + automatic reconnect (Attempt 2)
        st = await manager.killRemotePortOccupant('otp-node', { remotePort: 3080, reconnect: true, waitForReady: true })
        assert.equal(killedPorts.length, 1)
        assert.equal(st.status, 'connected')
        assert.equal(st.initializedFromWeb, true)
        assert.equal(st.remotePid, 4321)

        // Test openRemoteDsh fallback URL
        const openRes = await manager.openRemoteDsh('otp-node')
        assert.equal(openRes.fallbackRequired, true)
        assert.equal(openRes.url, 'http://127.0.0.1:41234/?token=abc')

        // Disconnect and verify state returns to disconnected
        st = await manager.disconnectHost('otp-node')
        assert.equal(st.status, 'disconnected')
        assert.equal(st.remotePid, null)
      } finally {
        await manager.dispose()
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  // 9. Auth cancellation immediately terminates the SSH connection
  {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-cancel-test-'))
    try {
      const sshConfigPath = join(tmpRoot, 'config')
      await writeFile(
        sshConfigPath,
        [
          'Host cancel-node',
          '  HostName 198.51.100.55',
          '  User admin',
        ].join('\n'),
        'utf8',
      )

      let sshKilled = false
      const mockSpawn = (_cmd, _args, opts) => {
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.exitCode = null
        child.killed = false
        child.kill = () => {
          sshKilled = true
          child.killed = true
          child.exitCode = 1
          child.emit('close', 1)
        }
        child.stdin.on('end', () => {
          sshKilled = true
          child.killed = true
          child.exitCode = 0
          child.emit('close', 0)
        })

        ;(async () => {
          await fetch(opts.env.DSH_RC_ASKPASS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: opts.env.DSH_RC_ASKPASS_TOKEN, prompt: 'Password:' }),
          }).catch(() => {})
        })()

        return child
      }

      const manager = new RemoteConnectionManager({
        sshConfigPath,
        dshVersion: '0.2.2-rc.3',
        spawnProcess: mockSpawn,
      })

      await manager.init()
      try {
        await manager.connectHost('cancel-node', { waitForReady: false })
        await new Promise((r) => setTimeout(r, 40))

        let st = await manager.getHostStatus('cancel-node')
        assert.equal(st.status, 'connecting')
        assert.equal(st.phase, 'awaiting_auth')
        assert.ok(st.authPrompt)

        // Cancel auth -> must immediately terminate SSH connection and return to disconnected
        const cancelRes = await manager.cancelAuth('cancel-node', { promptId: st.authPrompt.id })
        assert.equal(cancelRes.ok, true)
        assert.equal(cancelRes.disconnected, true)
        assert.equal(sshKilled, true)

        st = await manager.getHostStatus('cancel-node')
        assert.equal(st.status, 'disconnected')
        assert.equal(st.authPrompt, null)
      } finally {
        await manager.dispose()
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  // 10. Plugin source classification, SemVer comparison, local plugin discovery, and remote sync (<= vs > version confirmation)
  {
    assert.equal(comparePluginVersions('1.0.0', '1.0.0'), 0)
    assert.equal(comparePluginVersions('1.2.0', '1.1.9'), 1)
    assert.equal(comparePluginVersions('1.0.0', '1.0.1'), -1)
    assert.equal(comparePluginVersions('1.0.0', '1.0.0-rc.1'), 1)
    assert.equal(comparePluginVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1)

    const npmSrc = classifyInstallSource('@scope/demo-plugin', '^1.2.3', '/tmp/profile')
    assert.equal(npmSrc.sourceKind, 'npm')

    const ghSrc = classifyInstallSource('gh-plugin', 'github:example-org/gh-plugin#main', '/tmp/profile')
    assert.equal(ghSrc.sourceKind, 'github')
    assert.equal(ghSrc.installSpec, 'github:example-org/gh-plugin#main')

    const localDirSrc = classifyInstallSource('local-dir-plugin', 'link:/tmp/my-local-plugin', '/tmp/profile')
    assert.equal(localDirSrc.sourceKind, 'local')
    assert.equal(localDirSrc.localSubkind, 'directory')

    const localTgzSrc = classifyInstallSource('local-tgz-plugin', 'file:/tmp/my-plugin-1.0.0.tgz', '/tmp/profile')
    assert.equal(localTgzSrc.sourceKind, 'local')
    assert.equal(localTgzSrc.localSubkind, 'tarball')

    // Set up a mock local profile with 3 plugins (npm, github, local) and test syncPluginToHost
    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-pluginsync-test-'))
    try {
      const sshConfigPath = join(tmpRoot, 'ssh_config')
      await writeFile(
        sshConfigPath,
        [
          'Host sync-box',
          '  HostName 198.51.100.77',
          '  User builder',
        ].join('\n'),
        'utf8',
      )

      const profileDir = join(tmpRoot, 'profile')
      const localPluginDir = join(tmpRoot, 'my-local-bundle')
      const npmPluginDir = join(profileDir, 'node_modules', 'demo-npm-bundle')
      const ghPluginDir = join(profileDir, 'node_modules', 'demo-gh-bundle')

      await mkdir(join(localPluginDir, 'locale'), { recursive: true })
      await mkdir(npmPluginDir, { recursive: true })
      await mkdir(ghPluginDir, { recursive: true })

      await writeFile(
        join(localPluginDir, 'package.json'),
        JSON.stringify({
          name: 'my-local-bundle',
          version: '1.2.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'utf8',
      )
      await writeFile(join(localPluginDir, 'cordis.patch.yml'), '[]\n', 'utf8')
      await writeFile(
        join(localPluginDir, 'locale', 'zh.json'),
        JSON.stringify({ meta: { title: '本地测试插件', description: '测试描述' } }),
        'utf8',
      )

      await writeFile(
        join(npmPluginDir, 'package.json'),
        JSON.stringify({
          name: 'demo-npm-bundle',
          version: '2.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'utf8',
      )

      await writeFile(
        join(ghPluginDir, 'package.json'),
        JSON.stringify({
          name: 'demo-gh-bundle',
          version: '1.5.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'utf8',
      )

      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          name: 'dsh-profile-test',
          private: true,
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', 'my-local-bundle', 'demo-npm-bundle', 'demo-gh-bundle'],
            },
          },
          dependencies: {
            'my-local-bundle': `link:${localPluginDir}`,
            'demo-npm-bundle': '2.0.0',
            'demo-gh-bundle': 'github:example/demo-gh-bundle#deadbeef',
          },
        }),
        'utf8',
      )

      const discovered = await listLocalPlugins({ profileDir })
      assert.equal(discovered.plugins.length, 3)

      const packedBuf = await packLocalPluginDirectory(localPluginDir)
      assert.ok(packedBuf.length > 0)

      // Simulated remote plugin state
      const remotePluginsState = new Map([
        ['demo-npm-bundle', { installed: true, remoteVersion: '1.9.0' }], // remote <= local (auto reinstall)
        ['demo-gh-bundle', { installed: true, remoteVersion: '3.0.0' }],  // remote > local (confirm required)
        ['my-local-bundle', { installed: false, remoteVersion: null }],   // not installed on remote
      ])
      const installCalls = []
      let sshSpawnCount = 0

      const mockSpawn = (_cmd, _args) => {
        sshSpawnCount += 1
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.exitCode = null
        child.killed = false
        child.kill = () => {
          child.killed = true
          child.exitCode = 0
          child.emit('close', 0)
        }

        setTimeout(() => {
          child.stdout.write(`${EVENT_PREFIX}{"type":"ready","url":"http://127.0.0.1:43333/?token=t","remotePort":3080,"localPort":43333,"profile":"web","pid":1111}\n`)
        }, 10)

        const chunksById = new Map()
        let lineBuf = ''
        child.stdin.on('data', (chunk) => {
          lineBuf += String(chunk)
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop() ?? ''
          for (const rawLine of lines) {
            const cmd = rawLine.trim()
            if (cmd === 'SHUTDOWN') {
              child.exitCode = 0
              child.emit('close', 0)
              return
            }
            if (cmd.startsWith('RPC_CHUNK:')) {
              const c = JSON.parse(cmd.slice('RPC_CHUNK:'.length))
              if (!chunksById.has(c.id)) chunksById.set(c.id, [])
              chunksById.get(c.id).push(c.data)
              continue
            }
            if (cmd.startsWith('RPC:')) {
              const req = JSON.parse(cmd.slice('RPC:'.length))
              if (req.method === 'check_plugin') {
                const pkgName = req.params.packageName
                const st = remotePluginsState.get(pkgName) || { installed: false, remoteVersion: null }
                child.stdout.write(`${EVENT_PREFIX}${JSON.stringify({
                  type: 'rpc_result',
                  id: req.id,
                  ok: true,
                  value: {
                    packageName: pkgName,
                    installed: st.installed,
                    remoteVersion: st.remoteVersion,
                  },
                })}\n`)
              } else if (req.method === 'install_plugin') {
                const rawB64 = (chunksById.get(req.id) || []).join('')
                chunksById.delete(req.id)
                installCalls.push({
                  pkgName: req.params.packageName,
                  sourceKind: req.params.sourceKind,
                  reinstall: req.params.reinstall,
                  payloadLen: rawB64.length,
                })
                child.stdout.write(`${EVENT_PREFIX}${JSON.stringify({
                  type: 'rpc_result',
                  id: req.id,
                  ok: true,
                  value: {
                    packageName: req.params.packageName,
                    installedVersion: 'synced-ver',
                    sourceKind: req.params.sourceKind,
                    reinstalled: req.params.reinstall,
                  },
                })}\n`)
              }
            }
          }
        })

        return child
      }

      const manager = new RemoteConnectionManager({
        sshConfigPath,
        localProfileDir: profileDir,
        dshVersion: '0.2.2-rc.3',
        spawnProcess: mockSpawn,
      })

      await manager.init()
      try {
        await manager.connectHost('sync-box', { waitForReady: true })
        assert.equal(sshSpawnCount, 1, 'Only 1 SSH connection should be opened')

        // Case A: Not installed on remote (local source) -> installs directly over existing SSH stdin channel
        const resLocal = await manager.syncPluginToHost('sync-box', { pluginName: 'my-local-bundle' })
        assert.equal(resLocal.status, 'synced')
        assert.equal(resLocal.sourceKind, 'local')
        assert.equal(resLocal.reinstalled, false)
        assert.ok(installCalls.at(-1).payloadLen > 0)

        // Case B: Installed on remote with version 1.9.0 <= local 2.0.0 -> deletes & reinstalls directly without confirmation
        const resNpm = await manager.syncPluginToHost('sync-box', { pluginName: 'demo-npm-bundle' })
        assert.equal(resNpm.status, 'synced')
        assert.equal(resNpm.sourceKind, 'npm')
        assert.equal(resNpm.reinstalled, true)
        assert.equal(resNpm.previousRemoteVersion, '1.9.0')

        // Case C: Installed on remote with version 3.0.0 > local 1.5.0 -> returns confirm_required first!
        const resGhAsk = await manager.syncPluginToHost('sync-box', { pluginName: 'demo-gh-bundle', force: false })
        assert.equal(resGhAsk.status, 'confirm_required')
        assert.equal(resGhAsk.remoteVersion, '3.0.0')
        assert.equal(resGhAsk.localVersion, '1.5.0')
        assert.equal(installCalls.some((c) => c.pkgName === 'demo-gh-bundle'), false, 'Must not install before user confirms')

        // Now user confirms (force: true) -> deletes remote and reinstalls!
        const resGhForce = await manager.syncPluginToHost('sync-box', { pluginName: 'demo-gh-bundle', force: true })
        assert.equal(resGhForce.status, 'synced')
        assert.equal(resGhForce.reinstalled, true)
        assert.equal(resGhForce.previousRemoteVersion, '3.0.0')
        assert.equal(installCalls.some((c) => c.pkgName === 'demo-gh-bundle' && c.reinstall === true), true)

        assert.equal(sshSpawnCount, 1, 'Syncing plugins must reuse existing SSH session and never spawn extra SSH processes')

        // Also verify cancelAuth on an already-connected host never disconnects it
        const cancelOnConnected = await manager.cancelAuth('sync-box', {})
        assert.equal(cancelOnConnected.disconnected, false)
        assert.equal((await manager.getHostStatus('sync-box')).status, 'connected')

        await manager.disconnectHost('sync-box')
      } finally {
        await manager.dispose()
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  // 11. Cordis strict Proxy context startup test (must never access uninjected properties like storageDomain directly)
  {
    const cleanups = []
    const injectedCallbacks = []
    const baseCtx = {
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      inject(deps, fn) {
        injectedCallbacks.push({ deps, fn })
      },
      get() {
        return undefined
      },
    }
    const strictCtx = new Proxy(baseCtx, {
      get(target, prop, receiver) {
        if (prop in target || typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })

    const mgr = applyHostPlugin(strictCtx, {})
    assert.ok(mgr)
    assert.equal(injectedCallbacks.some((c) => c.deps.includes('storageDomain')), true)
    assert.equal(injectedCallbacks.some((c) => c.deps.includes('connection')), true)
    assert.equal(injectedCallbacks.some((c) => c.deps.includes('tools')), true)

    // Wait briefly for async init, then run all effect disposers
    await new Promise((r) => setTimeout(r, 30))
    for (const cleanup of cleanups) {
      await cleanup()
    }
  }

  console.log('All unit and integration assertions passed!')
}

await runTests()
