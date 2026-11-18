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
  buildKillRemotePortScript,
  buildRemoteBootstrapScript,
  hostBlockMatches,
  isConcreteHostPattern,
  loadSshConfigHosts,
  normalizeHostConfig,
  openUrlInDefaultBrowser,
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
    const { script, supervisorJs, sshCommand } = buildRemoteBootstrapScript({
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
    assert.equal(sshCommand.startsWith("sh -c 'eval "), true)

    const killCmd = buildKillRemotePortScript(3080)
    assert.equal(killCmd.startsWith("sh -c 'eval "), true)
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

  console.log('All unit and integration assertions passed!')
}

await runTests()
