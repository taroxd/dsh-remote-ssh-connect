// Unit and integration tests for dsh-remote-ssh-connect using strictly synthetic RFC 5737 test fixtures.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  makeLocalWorkspaceId,
  MinimalWsClient,
  normalizeHostConfig,
  normalizeSyncedWorkspaceRecord,
  openUrlInDefaultBrowser,
  packLocalPluginDirectory,
  parseLocalWorkspaceId,
  parseSshConfigText,
  resolveHostsFromBlocks,
  validateHostAlias,
  validateHostConfigInput,
} from '../index.js'
import { AskpassCoordinator, classifyAuthPrompt } from '../src/askpass-server.js'
import { EVENT_PREFIX } from '../src/remote-script.js'

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await predicate()
    if (val) return val
    await new Promise((r) => setTimeout(r, 15))
  }
  return predicate()
}

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
    assert.equal(supervisorJs.includes('callRemotePluginManager'), true)
    assert.equal(supervisorJs.includes('removeBundle'), true)
    assert.equal(supervisorJs.includes('installBundle'), true)
    assert.equal(script.includes('MAX_VERSIONS=3'), true)
    assert.equal(script.includes('bash -lic'), true)
    assert.equal(script.includes('.bashrc'), true)
    assert.equal(typeof encodedScript, 'string')
    assert.ok(encodedScript.length > 100)
    assert.equal(sshCommand.startsWith('mkdir -p ~/.dsh-remote-ssh-connect && IFS= read -r B'), true)
    assert.ok(sshCommand.length < 250, 'sshCommand must stay compact to avoid ENAMETOOLONG on Windows')

    const { Script } = await import('node:vm')
    assert.doesNotThrow(() => new Script(supervisorJs), 'supervisorJs must be valid JavaScript syntax')

    const killCmd = buildKillRemotePortScript(3080)
    assert.equal(killCmd.startsWith('mkdir -p ~/.dsh-remote-ssh-connect && printf %s '), true)
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

      // Wait for server to register prompt
      const pending = await waitFor(() => coordinator.getPendingPromptForHost('test-host'))
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
        fetchImpl: async () => new Response(null, { status: 404 }),
        openBrowser: async (url) => ({ opened: false, url, fallbackRequired: true, reason: 'Headless test environment' }),
      })

      await manager.init()
      try {
        await manager.configureHost('otp-node', { remotePort: 3080, localPort: 0, profile: 'custom-prof' })

        // Start attempt 1 without blocking so we can answer both Password and OTP prompts
        await manager.connectHost('otp-node', { waitForReady: false })

        // Wait for Password prompt
        let st = await waitFor(async () => {
          const cur = await manager.getHostStatus('otp-node')
          return cur.authPrompt?.kind === 'password' ? cur : null
        })
        assert.equal(st.phase, 'awaiting_auth')
        assert.equal(st.authPrompt?.kind, 'password')
        manager.submitAuth('otp-node', { promptId: st.authPrompt.id, value: 'hunter2' })

        // Wait for OTP prompt
        st = await waitFor(async () => {
          const cur = await manager.getHostStatus('otp-node')
          return cur.authPrompt?.kind === 'otp' ? cur : null
        })
        assert.equal(st.phase, 'awaiting_auth')
        assert.equal(st.authPrompt?.kind, 'otp')
        manager.submitAuth('otp-node', { promptId: st.authPrompt.id, value: '654321' })

        // Wait for attempt 1 to settle with REMOTE_PORT_IN_USE
        st = await waitFor(async () => {
          const cur = await manager.getHostStatus('otp-node')
          return cur.status === 'error' ? cur : null
        })
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
        let st = await waitFor(async () => {
          const cur = await manager.getHostStatus('cancel-node')
          return cur.authPrompt ? cur : null
        })
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

      // Also verify that packLocalPluginDirectory excludes .pnpm-store, tmp, and .tgz artifacts
      await mkdir(join(localPluginDir, '.pnpm-store', 'v11'), { recursive: true })
      await writeFile(join(localPluginDir, '.pnpm-store', 'v11', 'blob'), 'ignored', 'utf8')
      await writeFile(join(localPluginDir, 'my-local-bundle-1.0.0.tgz'), 'ignored-tgz', 'utf8')

      const discovered = await listLocalPlugins({ profileDir })
      assert.equal(discovered.plugins.length, 3)

      const packedBuf = await packLocalPluginDirectory(localPluginDir)
      assert.ok(packedBuf.length > 0)
      const { gunzipSync } = await import('node:zlib')
      const unpackedPayload = JSON.parse(gunzipSync(packedBuf).toString('utf8'))
      assert.equal(
        unpackedPayload.files.some((f) => f.path.includes('.pnpm-store') || f.path.endsWith('.tgz')),
        false,
        'packLocalPluginDirectory must exclude .pnpm-store and .tgz files',
      )

      // Simulated remote plugin state (including cross-source: my-local-bundle installed from npm on remote at older v1.0.0)
      const remotePluginsState = new Map([
        ['demo-npm-bundle', { installed: true, remoteVersion: '1.9.0', remoteSourceKind: 'npm' }], // remote <= local (auto reinstall)
        ['demo-gh-bundle', { installed: true, remoteVersion: '3.0.0', remoteSourceKind: 'npm' }],  // remote > local (confirm required)
        ['my-local-bundle', { installed: true, remoteVersion: '1.0.0', remoteSourceKind: 'npm' }], // remote has older npm version, local is local source!
      ])
      const installCalls = []
      let sshSpawnCount = 0

      // Mock remote DSH HTTP server to verify tunnel pluginManager RPC calls (removeBundle / setBundleEnabled)
      const { createServer: createHttpServer } = await import('node:http')
      const remoteRpcCalls = []
      const mockRemoteDshServer = createHttpServer((req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET' && u.pathname === '/' && u.searchParams.get('token') === 't') {
          res.writeHead(303, {
            'set-cookie': 'dsh-auth-mock=v1.mock.sig; Path=/; HttpOnly',
            location: './',
          })
          res.end()
          return
        }
        if (req.method === 'POST' && u.pathname.startsWith('/api/pluginManager/')) {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            const parsed = JSON.parse(body)
            remoteRpcCalls.push({
              method: parsed.method,
              args: parsed.payload?.args,
              cookie: req.headers.cookie,
            })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: {
                ok: true,
                value: {
                  changed: true,
                  application: 'applied',
                  stage: parsed.method.endsWith('removeBundle') ? 'remove' : 'enable',
                  target: parsed.payload?.args?.name || '',
                },
              },
            }))
          })
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise((resolve) => mockRemoteDshServer.listen(0, '127.0.0.1', resolve))
      const mockDshPort = mockRemoteDshServer.address().port

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
          child.stdout.write(`${EVENT_PREFIX}{"type":"ready","url":"http://127.0.0.1:${mockDshPort}/?token=t","remotePort":3080,"localPort":${mockDshPort},"profile":"web","pid":1111}\n`)
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
                    remoteSourceKind: st.remoteSourceKind ?? null,
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

        // Case A: Installed on remote from npm (v1.0.0) while local is local directory source (v1.2.0) ->
        // unloads & removes remote npm copy via live PluginManager, streams local archive, and enables new local bundle
        const resLocal = await manager.syncPluginToHost('sync-box', { pluginName: 'my-local-bundle' })
        assert.equal(resLocal.status, 'synced')
        assert.equal(resLocal.sourceKind, 'local')
        assert.equal(resLocal.reinstalled, true)
        assert.equal(resLocal.previousRemoteVersion, '1.0.0')
        assert.ok(installCalls.at(-1).payloadLen > 0)
        assert.equal(
          remoteRpcCalls.some((c) => c.method === 'pluginManager/removeBundle' && c.args?.name === 'my-local-bundle'),
          true,
          'Must invoke live remote pluginManager/removeBundle before cross-source reinstall',
        )
        assert.equal(
          remoteRpcCalls.some((c) => c.method === 'pluginManager/setBundleEnabled' && c.args?.name === 'my-local-bundle' && c.args?.enabled === true),
          true,
          'Must invoke live remote pluginManager/setBundleEnabled after CLI fallback install',
        )

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
        await new Promise((resolve) => mockRemoteDshServer.close(resolve))
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
    assert.equal(injectedCallbacks.some((c) => c.deps.includes('typertGateway')), true)

    // Verify Cordis Service proxy unwrapping when target has Symbol.for('cordis.tracker') own symbol
    // and Proxy exposes the raw service via Symbol.for('cordis.original')
    const rawGateway = {
      [Symbol.for('cordis.tracker')]: { associate: 'typertGateway', property: 'ctx' },
      dispatchRpc: async () => ({ ok: true, value: 'original-rpc' }),
      openWireStream: async () => 'original-stream',
    }
    const proxiedGateway = new Proxy(rawGateway, {
      get(target, prop, receiver) {
        if (prop === Symbol.for('cordis.original')) return target
        return Reflect.get(target, prop, receiver)
      },
    })
    const gwInjectEntry = injectedCallbacks.find((c) => c.deps.includes('typertGateway'))
    assert.ok(gwInjectEntry)
    gwInjectEntry.fn({
      typertGateway: proxiedGateway,
      get() { return undefined },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    })
    assert.equal(mgr.workspaceBridge.attachedGateway, rawGateway, 'Must unwrap Cordis Service proxy via Symbol.for("cordis.original"), not Symbol.for("cordis.tracker")')

    // Wait briefly for async init, then run all effect disposers
    await new Promise((r) => setTimeout(r, 30))
    for (const cleanup of cleanups) {
      await cleanup()
    }
  }

  // 12. Remote Workspace synchronization, session federation (connected vs disconnected), remote deletion detection, and plugin diffing
  {
    assert.equal(makeLocalWorkspaceId('prod-box', 'ws-123'), 'remote:prod-box:ws-123')
    assert.deepEqual(parseLocalWorkspaceId('remote:prod-box:ws-123'), {
      host: 'prod-box',
      remoteWorkspaceId: 'ws-123',
    })
    assert.equal(parseLocalWorkspaceId('local-uuid-1234'), null)

    const normRec = normalizeSyncedWorkspaceRecord({
      host: 'prod-box',
      remoteWorkspaceId: 'ws-123',
      remotePath: '/home/ubuntu/backend',
      title: 'backend (prod-box) (prod-box)',
    })
    assert.equal(normRec.localWorkspaceId, 'remote:prod-box:ws-123')
    assert.equal(normRec.title, 'backend (prod-box) (prod-box)', 'Stored titles must be preserved verbatim')
    assert.equal(normRec.invalidated, false)

    const cfgWithCollapsed = normalizeHostConfig({ remotePort: 3080, localPort: 0, profile: 'web', pluginDiffCollapsed: true })
    assert.equal(cfgWithCollapsed.pluginDiffCollapsed, true)
    assert.deepEqual(validateHostConfigInput({ pluginDiffCollapsed: true }), { pluginDiffCollapsed: true })

    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-wsbridge-test-'))
    try {
      const sshConfigPath = join(tmpRoot, 'ssh_config')
      await writeFile(
        sshConfigPath,
        [
          'Host ws-box',
          '  HostName 198.51.100.88',
          '  User ubuntu',
        ].join('\n'),
        'utf8',
      )

      const profileDir = join(tmpRoot, 'profile')
      const localPluginDir = join(profileDir, 'node_modules', 'local-only-plugin')
      await mkdir(localPluginDir, { recursive: true })
      await writeFile(
        join(localPluginDir, 'package.json'),
        JSON.stringify({
          name: 'local-only-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'utf8',
      )
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          name: 'dsh-profile-ws',
          private: true,
          dsh: { profile: { bundles: ['local-only-plugin', 'dsh-remote-ssh-connect'] } },
          dependencies: {
            'local-only-plugin': '1.0.0',
            'dsh-remote-ssh-connect': '1.0.0',
          },
        }),
        'utf8',
      )

      // Simulated remote workspaces & sessions state
      let remoteWorkspacesList = [
        {
          workspaceId: 'rws-alpha',
          path: '/home/ubuntu/alpha-service',
          title: 'alpha-service',
          sessionIds: ['session-remote-1', 'session-remote-2'],
          createdAt: '2026-11-18T10:00:00.000Z',
          updatedAt: '2026-11-18T12:00:00.000Z',
        },
        {
          workspaceId: 'rws-beta',
          path: '/home/ubuntu/beta-worker',
          title: 'beta-worker',
          sessionIds: ['session-remote-unwatched'],
          createdAt: '2026-11-18T09:00:00.000Z',
          updatedAt: '2026-11-18T11:00:00.000Z',
        },
      ]

      const remoteSessionsMap = new Map([
        ['session-remote-1', {
          sessionId: 'session-remote-1',
          title: 'Fix memory leak',
          cwd: '/home/ubuntu/alpha-service',
          running: false,
          blank: false,
          updatedAt: 1700000002000,
        }],
        ['session-remote-2', {
          sessionId: 'session-remote-2',
          title: 'Add metrics endpoint',
          cwd: '/home/ubuntu/alpha-service',
          running: true,
          blank: false,
          updatedAt: 1700000005000,
        }],
        ['session-remote-unwatched', {
          sessionId: 'session-remote-unwatched',
          title: 'Unwatched beta session',
          cwd: '/home/ubuntu/beta-worker',
          running: false,
          blank: false,
          updatedAt: 1700000009000,
        }],
      ])

      const remotePromptsReceived = []

      // Mock WebSocket factory for RemoteHostGatewayClient so we test the full stream + RPC federation deterministically
      class MockWs extends EventEmitter {
        constructor() {
          super()
          this.readyState = 0
          setTimeout(() => {
            this.readyState = 1
            this.emit('open')
          }, 5)
        }

        send(raw) {
          const msg = JSON.parse(raw)
          if (msg.type === 'open') {
            if (msg.endpoint === 'workspace/follow') {
              setTimeout(() => {
                this.emit('message', {
                  data: JSON.stringify({
                    type: 'item',
                    streamId: msg.streamId,
                    value: {
                      type: 'baseline',
                      value: {
                        items: remoteWorkspacesList,
                        archivedSessionIds: [],
                        pinnedSessionIds: ['session-remote-2'],
                      },
                    },
                  }),
                })
              }, 5)
            } else if (msg.endpoint === 'session/control') {
              setTimeout(() => {
                this.emit('message', {
                  data: JSON.stringify({
                    type: 'item',
                    streamId: msg.streamId,
                    value: {
                      type: 'baseline',
                      value: {
                        projections: {
                          'session-remote-1': { asOfSeq: 4, values: { title: 'Fix memory leak' } },
                        },
                      },
                    },
                  }),
                })
              }, 5)
            } else if (msg.endpoint === '$events') {
              setTimeout(() => {
                this.emit('message', {
                  data: JSON.stringify({
                    type: 'item',
                    streamId: msg.streamId,
                    value: {
                      type: 'ready',
                      clientId: 'remote-client-1',
                      host: { home: '/home/ubuntu' },
                    },
                  }),
                })
              }, 5)
            } else if (msg.endpoint === 'session/follow') {
              const sid = msg.payload?.args?.address?.sessionId || msg.payload?.args?.sessionId
              setTimeout(() => {
                this.emit('message', {
                  data: JSON.stringify({
                    type: 'item',
                    streamId: msg.streamId,
                    value: {
                      type: 'snapshot',
                      sessionId: sid,
                      events: [{ seq: 0, type: 'user/message', text: 'Hello remote session' }],
                    },
                  }),
                })
                this.emit('message', {
                  data: JSON.stringify({
                    type: 'end',
                    streamId: msg.streamId,
                  }),
                })
              }, 5)
            }
          }
        }

        close() {
          this.readyState = 3
          this.emit('close', 1000, '')
        }
      }

      const mockFetch = async (urlStr, init = {}) => {
        const u = new URL(urlStr)
        if (init.method === 'GET' && u.pathname === '/') {
          return new Response(null, {
            status: 303,
            headers: { 'set-cookie': 'dsh-auth-ws=v1.mock.sig; Path=/; HttpOnly' },
          })
        }
        if (init.method === 'POST' && u.pathname.startsWith('/api/')) {
          const body = JSON.parse(init.body)
          const endpoint = body.method
          const args = body.payload?.args ?? {}

          let value = null
          if (endpoint === 'session/list') {
            value = { items: [...remoteSessionsMap.values()] }
          } else if (endpoint === 'session/create') {
            const req = args.request ?? args
            const newId = 'session-remote-created-3'
            const newSummary = {
              sessionId: newId,
              title: 'New remote session',
              cwd: '/home/ubuntu/alpha-service',
              running: false,
              blank: true,
              updatedAt: Date.now(),
            }
            remoteSessionsMap.set(newId, newSummary)
            const ws = remoteWorkspacesList.find((w) => w.workspaceId === req.workspaceId)
            if (ws) ws.sessionIds = [newId, ...ws.sessionIds]
            value = { sessionId: newId }
          } else if (endpoint === 'session/prompt') {
            const req = args.request ?? args
            remotePromptsReceived.push(req)
            value = { accepted: true }
          } else if (endpoint === 'session/modelCatalog') {
            value = {
              default: { provider: 'remote-provider', model: 'remote-model-v1' },
              routableProviders: ['remote-provider'],
              groups: [
                {
                  id: 'remote-provider',
                  name: 'Remote Provider',
                  models: [{ id: 'remote-model-v1', name: 'Remote Model v1' }],
                },
              ],
              failures: [],
            }
          } else if (endpoint === 'customLocalOnly/someAction') {
            return Response.json({
              type: 'server-response',
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'gateway/invocation-unavailable',
                  message: 'no active Remote method exports this endpoint',
                  details: {},
                },
              },
            })
          } else if (endpoint === 'customLocalOnly/list') {
            return Response.json({
              type: 'server-response',
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'gateway/invocation-unavailable',
                  message: 'no active Remote method exports this endpoint',
                  details: {},
                },
              },
            })
          }

          return Response.json({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value },
          })
        }
        return new Response('not found', { status: 404 })
      }

      const mockSpawn = () => {
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
          child.stdout.write(`${EVENT_PREFIX}{"type":"ready","url":"http://127.0.0.1:43210/?token=wstok","remotePort":3080,"localPort":43210,"profile":"web","pid":2222}\n`)
        }, 10)

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
            if (cmd.startsWith('RPC:')) {
              const req = JSON.parse(cmd.slice('RPC:'.length))
              if (req.method === 'list_plugins') {
                child.stdout.write(`${EVENT_PREFIX}${JSON.stringify({
                  type: 'rpc_result',
                  id: req.id,
                  ok: true,
                  value: {
                    plugins: [
                      {
                        name: 'remote-only-plugin',
                        version: '2.1.0',
                        title: { zh: '远端专属插件', en: 'Remote Only Plugin' },
                        enabled: true,
                        hasClientUi: true,
                        sourceKind: 'npm',
                      },
                    ],
                  },
                })}\n`)
              }
            }
          }
        })

        return child
      }

      const savedWorkspacesInStorage = new Map()
      let savedWorkspaceOrder = null
      const manager = new RemoteConnectionManager({
        sshConfigPath,
        localProfileDir: profileDir,
        dshVersion: '0.2.2-rc.3',
        spawnProcess: mockSpawn,
        fetchImpl: mockFetch,
        createWs: () => new MockWs(),
        onSaveWorkspace: async (id, rec) => {
          if (rec === null) savedWorkspacesInStorage.delete(id)
          else savedWorkspacesInStorage.set(id, rec)
        },
        onSaveWorkspaceOrder: async (order) => {
          savedWorkspaceOrder = [...order]
        },
      })

      await manager.init()
      try {
        // Connect to ws-box
        await manager.connectHost('ws-box', { waitForReady: true })

        // 1. List remote workspaces & verify plugin diffing (local-only-plugin vs remote-only-plugin, dsh-remote-ssh-connect excluded)
        const remoteWsRes = await manager.listRemoteWorkspaces('ws-box')
        assert.equal(remoteWsRes.workspaces.length, 2)
        assert.equal(remoteWsRes.workspaces[0].remoteWorkspaceId, 'rws-alpha')
        assert.equal(remoteWsRes.workspaces[0].synced, false)
        assert.deepEqual(
          remoteWsRes.pluginDiff.missingOnRemote.map((p) => p.name),
          ['local-only-plugin'],
        )
        assert.deepEqual(
          remoteWsRes.pluginDiff.missingOnLocal.map((p) => p.name),
          ['remote-only-plugin'],
        )

        // 2. Sync remote workspace `rws-alpha` to local
        const syncRes = await manager.syncRemoteWorkspace('ws-box', { remoteWorkspaceId: 'rws-alpha' })
        assert.equal(syncRes.synced, true)
        assert.equal(syncRes.workspace.localWorkspaceId, 'remote:ws-box:rws-alpha')
        assert.equal(savedWorkspacesInStorage.has('remote:ws-box:rws-alpha'), true)

        // Connected state: projected WorkspaceView must expose the remote workspace's sessionIds
        assert.deepEqual(syncRes.view.sessionIds, ['session-remote-1', 'session-remote-2'])

        // Verify session/list RPC interception merges only sessions belonging to the synced workspace (not unwatched rws-beta)
        const listRpcRes = await manager.workspaceBridge.interceptRpc(
          'session/list',
          { args: {} },
          undefined,
          {},
          async () => ({
            ok: true,
            value: {
              items: [{ sessionId: 'local-session-1', title: 'Local task', updatedAt: 1700000001000 }],
            },
          }),
        )
        assert.equal(listRpcRes.ok, true)
        assert.deepEqual(
          listRpcRes.value.items.map((i) => i.sessionId),
          ['session-remote-2', 'session-remote-1', 'local-session-1'],
          'Only sessions from synced remote workspaces + local sessions should appear in session/list',
        )

        // Verify creating a new session in the synced remote workspace executes on the remote host
        const createRpcRes = await manager.workspaceBridge.interceptRpc(
          'session/create',
          { args: { request: { workspaceId: 'remote:ws-box:rws-alpha' } } },
          undefined,
          {},
          async () => { throw new Error('Should not call local session/create for remote workspace') },
        )
        assert.equal(createRpcRes.ok, true)
        assert.equal(createRpcRes.value.sessionId, 'session-remote-created-3')

        // Verify prompting the remote session forwards to the remote host
        const promptRpcRes = await manager.workspaceBridge.interceptRpc(
          'session/prompt',
          {
            args: {
              request: {
                sessionId: 'session-remote-created-3',
                content: [{ type: 'text', text: 'Run remote build' }],
                mode: 'queue',
              },
            },
          },
          undefined,
          {},
          async () => { throw new Error('Should not call local session/prompt for remote session') },
        )
        assert.equal(promptRpcRes.ok, true)
        assert.equal(remotePromptsReceived.length, 1)
        assert.equal(remotePromptsReceived[0].sessionId, 'session-remote-created-3')

        // Verify streaming session/follow for a remote session bridges from the remote WebSocket
        const streamIterable = await manager.workspaceBridge.interceptStream(
          'session/follow',
          { args: { address: { kind: 'session', sessionId: 'session-remote-1' } } },
          undefined,
          {},
          undefined,
          new AbortController(),
          undefined,
          async () => { throw new Error('Should not open local session/follow for remote session') },
        )
        const streamFrames = []
        for await (const frame of streamIterable) {
          streamFrames.push(frame)
        }
        assert.equal(streamFrames.length, 1)
        assert.equal(streamFrames[0].type, 'snapshot')
        assert.equal(streamFrames[0].sessionId, 'session-remote-1')

        // Verify graceful fallback when a local-only plugin calls a non-existent remote `/list` endpoint
        const fallbackListRes = await manager.workspaceBridge.interceptRpc(
          'customLocalOnly/list',
          { args: { sessionId: 'session-remote-1' } },
          undefined,
          {},
          async () => ({ ok: false }),
        )
        assert.deepEqual(fallbackListRes, { ok: true, value: [] })

        // Verify remote model catalog resolution for remote host & remote session while keeping local modelCatalog purely local
        const localCatalogIntercept = await manager.workspaceBridge.interceptRpc(
          'session/modelCatalog',
          { args: {} },
          undefined,
          {},
          async () => ({ ok: true, value: 'local-catalog' }),
        )
        assert.equal(localCatalogIntercept, undefined, 'Local session/modelCatalog must delegate to local Host without merging remote models')

        const remoteSessionHost = manager.getSessionHost('session-remote-1')
        assert.equal(remoteSessionHost.host, 'ws-box')

        const remoteCatalogBySession = await manager.getRemoteModelCatalog({ sessionId: 'session-remote-1' })
        assert.equal(remoteCatalogBySession.host, 'ws-box')
        assert.equal(remoteCatalogBySession.catalog.default.model, 'remote-model-v1')
        assert.deepEqual(
          remoteCatalogBySession.catalog.groups.map((g) => g.id),
          ['remote-provider'],
        )

        // Verify interleaved drag-and-drop reordering between local and remote workspaces via workspace/insertBefore
        manager.workspaceBridge.localWorkspaceBaseline.items = [
          { workspaceId: 'local-ws-1', path: '/local/1', title: 'Local 1', sessionIds: [], createdAt: '', updatedAt: '' },
          { workspaceId: 'local-ws-2', path: '/local/2', title: 'Local 2', sessionIds: [], createdAt: '', updatedAt: '' },
        ]
        manager.workspaceBridge.loadInitialWorkspaceOrder(['local-ws-1', 'local-ws-2', 'remote:ws-box:rws-alpha'])

        const reorderRes = await manager.workspaceBridge.interceptRpc(
          'workspace/insertBefore',
          {
            args: {
              request: {
                workspaceId: 'remote:ws-box:rws-alpha',
                beforeWorkspaceId: 'local-ws-2',
              },
            },
          },
          undefined,
          {},
          async () => ({ ok: true, value: { workspaceIds: ['local-ws-1', 'local-ws-2'] } }),
        )
        assert.equal(reorderRes.ok, true)
        assert.deepEqual(
          reorderRes.value.workspaceIds,
          ['local-ws-1', 'remote:ws-box:rws-alpha', 'local-ws-2'],
          'Remote and local workspaces must support free interleaved drag-and-drop ordering',
        )
        assert.deepEqual(
          savedWorkspaceOrder,
          ['local-ws-1', 'remote:ws-box:rws-alpha', 'local-ws-2'],
        )

        // 3. Disconnect host -> remote workspace stays in Workspaces list, but its sessionIds become [] (sessions hidden)
        await manager.disconnectHost('ws-box')
        const viewsWhileDisconnected = manager.workspaceBridge.getProjectedWorkspaceViews()
        assert.equal(viewsWhileDisconnected.length, 1)
        assert.equal(viewsWhileDisconnected[0].workspaceId, 'remote:ws-box:rws-alpha')
        assert.deepEqual(
          viewsWhileDisconnected[0].sessionIds,
          [],
          'When remote host is disconnected, sessions under the remote workspace must not be viewable',
        )

        // 4. Simulate remote workspace `rws-alpha` being deleted on the remote host, then reconnect
        remoteWorkspacesList = [
          {
            workspaceId: 'rws-beta',
            path: '/home/ubuntu/beta-worker',
            title: 'beta-worker',
            sessionIds: [],
            createdAt: '2026-11-18T09:00:00.000Z',
            updatedAt: '2026-11-18T11:00:00.000Z',
          },
        ]
        await manager.connectHost('ws-box', { waitForReady: true })
        await new Promise((r) => setTimeout(r, 30))

        const hostListAfterDelete = await manager.listHosts()
        assert.equal(
          hostListAfterDelete.invalidatedWorkspaces.length,
          1,
          'Deleted remote workspace must be flagged in invalidatedWorkspaces to notify the user',
        )
        assert.equal(hostListAfterDelete.invalidatedWorkspaces[0].localWorkspaceId, 'remote:ws-box:rws-alpha')
        assert.equal(hostListAfterDelete.invalidatedWorkspaces[0].invalidationReason, 'deleted_on_remote')

        // User confirms removal of invalidated remote workspace
        const rmRes = await manager.removeSyncedWorkspace('remote:ws-box:rws-alpha')
        assert.equal(rmRes.removed, true)
        assert.equal(savedWorkspacesInStorage.has('remote:ws-box:rws-alpha'), false)
        assert.equal(manager.workspaceBridge.getProjectedWorkspaceViews().length, 0)

        await manager.disconnectHost('ws-box')
      } finally {
        await manager.dispose()
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  // 13. MinimalWsClient real loopback RFC 6455 handshake & frame exchange test
  {
    const { createServer: createHttpServer } = await import('node:http')
    const { createHash } = await import('node:crypto')

    const receivedServerMessages = []
    let receivedCookieHeader = null

    const wsSockets = new Set()
    const wsServer = createHttpServer()
    wsServer.on('upgrade', (req, socket) => {
      wsSockets.add(socket)
      socket.on('close', () => wsSockets.delete(socket))
      receivedCookieHeader = req.headers.cookie
      const key = req.headers['sec-websocket-key']
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'))

      // Send an unmasked server-to-client text frame right after handshake
      const greeting = Buffer.from(JSON.stringify({ hello: 'from-server' }), 'utf8')
      const outFrame = Buffer.allocUnsafe(2 + greeting.length)
      outFrame[0] = 0x81
      outFrame[1] = greeting.length
      greeting.copy(outFrame, 2)
      socket.write(outFrame)

      socket.on('data', (buf) => {
        if (buf.length < 6) return
        const opcode = buf[0] & 0x0f
        if (opcode === 0x01) {
          const len = buf[1] & 0x7f
          const mask = buf.subarray(2, 6)
          const payload = Buffer.allocUnsafe(len)
          for (let i = 0; i < len; i += 1) {
            payload[i] = buf[6 + i] ^ mask[i & 3]
          }
          receivedServerMessages.push(payload.toString('utf8'))
        }
      })
    })

    await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve))
    const port = wsServer.address().port
    try {
      const clientMessages = []
      const wsClient = new MinimalWsClient(`ws://127.0.0.1:${port}/api/remote.mux`, {
        headers: { Cookie: 'dsh-auth-test=123' },
      })

      await new Promise((resolve, reject) => {
        wsClient.once('open', resolve)
        wsClient.once('error', reject)
      })
      wsClient.on('message', (ev) => clientMessages.push(ev.data))
      wsClient.send(JSON.stringify({ type: 'open', streamId: 's1' }))

      await new Promise((r) => setTimeout(r, 40))
      assert.equal(receivedCookieHeader, 'dsh-auth-test=123')
      assert.equal(clientMessages.length, 1)
      assert.deepEqual(JSON.parse(clientMessages[0]), { hello: 'from-server' })
      assert.equal(receivedServerMessages.length, 1)
      assert.deepEqual(JSON.parse(receivedServerMessages[0]), { type: 'open', streamId: 's1' })
      wsClient.close()
    } finally {
      for (const s of wsSockets) s.destroy()
      await new Promise((resolve) => wsServer.close(resolve))
    }
  }

  // 14. Client bundle (`client.js`) registration and slot mounting verification
  {
    const clientCode = await readFile(join(process.cwd(), 'client.js'), 'utf8')
    let registeredModule = null
    const prevWindow = globalThis.window
    globalThis.window = {
      __ModuleLoader__: {
        load(def) {
          registeredModule = def
        },
      },
    }
    try {
      const fn = new Function(clientCode)
      fn()
      assert.ok(registeredModule, 'client.js must register with window.__ModuleLoader__.load')
      assert.equal(registeredModule.id, 'dsh-remote-ssh-connect')
      assert.equal(typeof registeredModule.factory, 'function')

      const mockReact = {
        Fragment: Symbol('Fragment'),
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {},
        useCallback: (cb) => cb,
        useRef: (init) => ({ current: init }),
      }
      const pluginExport = registeredModule.factory((spec) => {
        if (spec === 'react') return mockReact
        if (spec === 'react-dom') return { createPortal: (el) => el }
        throw new Error(`Unexpected require: ${spec}`)
      })
      assert.ok(pluginExport)
      assert.equal(typeof pluginExport.apply, 'function')

      const registeredSlots = []
      let registeredDicts = null
      const mockClientCtx = {
        effect: (cb) => cb(),
        locale: {
          register: (_ns, dicts) => {
            registeredDicts = dicts
            return () => {}
          },
          bind: () => (k) => k,
        },
        slots: {
          inject: (_slot, cb) => {
            const res = cb()
            if (res && typeof res[Symbol.iterator] === 'function') {
              for (const _ of res) { /* drain generator */ }
            }
            return () => {}
          },
          register: (spec, comp) => {
            registeredSlots.push({ spec, comp })
            return () => {}
          },
        },
        get: () => undefined,
      }
      pluginExport.apply(mockClientCtx)
      assert.deepEqual(
        registeredSlots.map((s) => s.spec.name),
        [
          'contextMenu.icon',
          'contextMenu.icon',
          'contextMenu.icon',
          'shell.overlay',
          'conversation.session.header.actions',
          'main',
          'sidebar.panellist',
        ],
      )
      assert.equal(registeredDicts?.en?.syncWorkspaceLabel, 'Remote workspace')
      assert.equal(registeredDicts?.zh?.syncWorkspaceLabel, '远程工作区')
      assert.equal(registeredDicts?.en?.btnCollapseDiff, 'Collapse')
      assert.equal(registeredDicts?.en?.btnExpandDiff, 'Expand')
      assert.equal(registeredDicts?.zh?.btnCollapseDiff, '收起')
      assert.equal(registeredDicts?.zh?.btnExpandDiff, '展开')
      assert.equal(clientCode.includes('dsh-rc-eye-btn'), true, 'AuthModal must use an inline eye icon button')
      assert.equal(
        clientCode.includes('[data-row-key^="workspace:remote:"] > span:first-child::after'),
        true,
        'Remote workspaces in Workspaces list must render the VS Code-style remote corner badge',
      )
      assert.equal(validateHostAlias('prod-gpu'), 'prod-gpu')
      assert.throws(() => validateHostAlias('-oProxyCommand=evil'), /cannot start with "-"/)
      assert.throws(() => validateHostAlias('bad:host'), /forbidden characters/)
      assert.throws(() => validateHostAlias('bad host'), /forbidden characters/)
    } finally {
      if (prevWindow === undefined) delete globalThis.window
      else globalThis.window = prevWindow
    }
  }

  console.log('All unit and integration assertions passed!')
}

await runTests()
