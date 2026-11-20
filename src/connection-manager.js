// Manages SSH connections, local port allocation, interactive auth prompts,
// remote Node/DSH provisioning, port-conflict recovery, and process lifecycle.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { AskpassCoordinator } from './askpass-server.js'
import { openUrlInDefaultBrowser } from './browser-opener.js'
import {
  comparePluginVersions,
  listLocalPlugins,
  packLocalPluginDirectory,
} from './plugin-sync.js'
import { buildKillRemotePortScript, buildRemoteBootstrapScript, EVENT_PREFIX } from './remote-script.js'
import {
  RemoteWorkspaceBridge,
  makeLocalWorkspaceId,
  normalizeSyncedWorkspaceRecord,
  parseLocalWorkspaceId,
} from './remote-workspace-bridge.js'
import { loadSshConfigHosts } from './ssh-config.js'

export const DEFAULT_REMOTE_PORT = 3080
export const DEFAULT_LOCAL_PORT = 0
export const DEFAULT_PROFILE = 'web'

/**
 * Resolve the running local DSH version string (e.g. "0.2.2-rc.3").
 * @returns {string}
 */
export function resolveLocalDshVersion() {
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  }
  try {
    const req = createRequire(import.meta.url)
    candidates.push(req.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    /* ignore */
  }
  if (process.execPath) {
    const resourcesDir = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh')
    candidates.push(join(resourcesDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    candidates.push(join(resourcesDir, 'package.json'))
  }
  for (const manifestPath of candidates) {
    try {
      if (existsSync(manifestPath)) {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof parsed?.version === 'string' && parsed.version.trim() !== '') {
          return parsed.version.trim()
        }
      }
    } catch {
      /* continue */
    }
  }
  return '0.2.2-rc.3'
}

/**
 * Allocate a free local TCP port on 127.0.0.1, or verify that a specific local port is available.
 * @param {number} [requestedPort=0]
 * @returns {Promise<number>}
 */
export function acquireLocalPort(requestedPort = 0) {
  const port = Number(requestedPort ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error(`Invalid local port: ${String(requestedPort)}`))
  }
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', (err) => {
      reject(err)
    })
    srv.listen(port, '127.0.0.1', () => {
      const address = srv.address()
      const assigned = typeof address === 'object' && address ? address.port : port
      srv.close((closeErr) => {
        if (closeErr) reject(closeErr)
        else resolve(assigned)
      })
    })
  })
}

export function normalizeHostConfig(raw = {}) {
  const remotePortNum = raw.remotePort !== undefined ? Number(raw.remotePort) : DEFAULT_REMOTE_PORT
  const localPortNum = raw.localPort !== undefined ? Number(raw.localPort) : DEFAULT_LOCAL_PORT
  const profileStr = typeof raw.profile === 'string' && raw.profile.trim() !== '' ? raw.profile.trim() : DEFAULT_PROFILE

  return {
    remotePort: Number.isInteger(remotePortNum) && remotePortNum >= 1 && remotePortNum <= 65535
      ? remotePortNum
      : DEFAULT_REMOTE_PORT,
    localPort: Number.isInteger(localPortNum) && localPortNum >= 0 && localPortNum <= 65535
      ? localPortNum
      : DEFAULT_LOCAL_PORT,
    profile: profileStr,
    ...(typeof raw.pluginDiffCollapsed === 'boolean' ? { pluginDiffCollapsed: raw.pluginDiffCollapsed } : {}),
    ...(Array.isArray(raw.workspaceOrder)
      ? { workspaceOrder: raw.workspaceOrder.filter((id) => typeof id === 'string') }
      : {}),
  }
}

export function validateHostAlias(host) {
  const trimmed = typeof host === 'string' ? host.trim() : ''
  if (!trimmed) {
    throw new Error('Host alias is required.')
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid host alias "${trimmed}": cannot start with "-".`)
  }
  if (/[\x00-\x1f\x7f\s:]/.test(trimmed)) {
    throw new Error(`Invalid host alias "${trimmed}": contains forbidden characters.`)
  }
  return trimmed
}

export function validateHostConfigInput(input = {}) {
  const next = {}
  if (input.remotePort !== undefined) {
    const rp = Number(input.remotePort)
    if (!Number.isInteger(rp) || rp < 1 || rp > 65535) {
      throw new Error('Remote port must be an integer between 1 and 65535.')
    }
    next.remotePort = rp
  }
  if (input.localPort !== undefined) {
    const lp = Number(input.localPort)
    if (!Number.isInteger(lp) || lp < 0 || lp > 65535) {
      throw new Error('Local port must be 0 (auto-assign) or an integer between 1 and 65535.')
    }
    next.localPort = lp
  }
  if (input.profile !== undefined) {
    const prof = String(input.profile ?? '').trim()
    if (!prof) {
      throw new Error('Profile name cannot be empty.')
    }
    if (prof.includes('/') || prof.includes('\\') || prof === '.' || prof === '..' || prof === 'node_modules') {
      throw new Error(`Invalid profile name: "${prof}".`)
    }
    if (prof.toLowerCase() === 'desktop') {
      throw new Error('Profile "desktop" is reserved for the Electron desktop app; please use "web" or a custom profile name.')
    }
    next.profile = prof
  }
  if (input.pluginDiffCollapsed !== undefined) {
    next.pluginDiffCollapsed = Boolean(input.pluginDiffCollapsed)
  }
  return next
}

export class RemoteConnectionManager {
  /**
   * @param {object} [options]
   * @param {string} [options.sshConfigPath]
   * @param {string} [options.homeDir]
   * @param {string} [options.dshVersion]
   * @param {string} [options.sshExecutable]
   * @param {string[]} [options.extraSshArgs]
   * @param {boolean} [options.forceInstallNode]
   * @param {string} [options.customDshTarballUrl]
   * @param {(host: string, config: object) => Promise<void>} [options.onSaveConfig]
   * @param {typeof openUrlInDefaultBrowser} [options.openBrowser]
   */
  constructor(options = {}) {
    this.sshConfigPath = options.sshConfigPath
    this.homeDir = options.homeDir
    this.localProfileDir = options.localProfileDir
    this.dshVersion = options.dshVersion ?? resolveLocalDshVersion()
    this.sshExecutable = options.sshExecutable ?? 'ssh'
    this.extraSshArgs = options.extraSshArgs ?? []
    this.forceInstallNode = options.forceInstallNode === true
    this.customDshTarballUrl = options.customDshTarballUrl
    this.onSaveConfig = options.onSaveConfig ?? (async () => {})
    this.onSaveWorkspace = options.onSaveWorkspace ?? (async () => {})
    this.onSaveWorkspaceOrder = options.onSaveWorkspaceOrder ?? (async () => {})
    this.openBrowser = options.openBrowser ?? openUrlInDefaultBrowser
    this.spawnProcess = options.spawnProcess ?? spawn

    /** @type {Map<string, { remotePort: number, localPort: number, profile: string }>} */
    this.hostConfigs = new Map()

    /** @type {Map<string, object>} */
    this.sessions = new Map()

    this.workspaceBridge = new RemoteWorkspaceBridge({
      onSaveWorkspace: (localWsId, record) => this.onSaveWorkspace(localWsId, record),
      onSaveWorkspaceOrder: (order) => this.onSaveWorkspaceOrder(order),
      fetchImpl: options.fetchImpl,
      createWs: options.createWs,
    })

    this.askpass = new AskpassCoordinator({
      onPromptChanged: (host, promptInfo) => {
        const sess = this.sessions.get(host)
        if (!sess) return
        sess.authPrompt = promptInfo
        if (promptInfo && sess.status === 'connecting') {
          sess.phase = 'awaiting_auth'
        } else if (!promptInfo && sess.status === 'connecting' && sess.phase === 'awaiting_auth') {
          sess.phase = 'connecting_ssh'
        }
      },
    })

    this._exitHandler = () => {
      this.killAllSync()
    }
    process.on('exit', this._exitHandler)
  }

  async init(initialConfigs = {}) {
    for (const [host, cfg] of Object.entries(initialConfigs)) {
      this.hostConfigs.set(host, normalizeHostConfig(cfg))
    }
    await this.askpass.start()
  }

  getHostConfig(host) {
    return normalizeHostConfig(this.hostConfigs.get(host))
  }

  async configureHost(host, patch) {
    const hostKey = validateHostAlias(host)
    const validated = validateHostConfigInput(patch)
    const current = this.getHostConfig(hostKey)
    const updated = normalizeHostConfig({ ...current, ...validated })
    this.hostConfigs.set(hostKey, updated)
    await this.onSaveConfig(hostKey, updated)
    return updated
  }

  _serializeSession(host, sshMeta, config) {
    const sess = this.sessions.get(host)
    const authPrompt = this.askpass.getPendingPromptForHost(host) ?? sess?.authPrompt ?? null
    const allSynced = this.workspaceBridge.listSyncedWorkspaces((h) => this.sessions.get(h)?.status ?? 'disconnected')
    const syncedWorkspaces = allSynced.filter((w) => w.host === host)
    return {
      alias: host,
      hostName: sshMeta?.hostName ?? host,
      user: sshMeta?.user ?? null,
      sshPort: sshMeta?.port ?? 22,
      proxyJump: sshMeta?.proxyJump ?? null,
      sourceFile: sshMeta?.sourceFile ?? '~/.ssh/config',
      config,
      status: sess?.status ?? 'disconnected',
      phase: authPrompt ? 'awaiting_auth' : (sess?.phase ?? 'idle'),
      activeLocalPort: sess?.activeLocalPort ?? null,
      activeRemotePort: sess?.activeRemotePort ?? null,
      activeProfile: sess?.activeProfile ?? null,
      dshVersion: sess?.dshVersion ?? this.dshVersion,
      remotePid: sess?.remotePid ?? null,
      initializedFromWeb: sess?.initializedFromWeb ?? false,
      url: sess?.url ?? null,
      connectedAt: sess?.connectedAt ?? null,
      authPrompt,
      error: sess?.error ?? null,
      recentLogs: sess?.recentLogs ? [...sess.recentLogs] : [],
      syncedWorkspaces,
    }
  }

  async listLocalPlugins() {
    const res = await listLocalPlugins({
      profileDir: this.localProfileDir,
      homeDir: this.homeDir,
    })
    return res.plugins
  }

  async listHosts() {
    const [parsed, localPlugins] = await Promise.all([
      loadSshConfigHosts({
        configPath: this.sshConfigPath,
        homeDir: this.homeDir,
      }),
      this.listLocalPlugins().catch(() => []),
    ])
    const items = []
    const seen = new Set()

    for (const h of parsed.hosts) {
      seen.add(h.alias)
      const cfg = this.getHostConfig(h.alias)
      items.push(this._serializeSession(h.alias, h, cfg))
    }

    // Also include any currently active session whose host was removed while connected
    for (const [alias, sess] of this.sessions.entries()) {
      if (!seen.has(alias) && (sess.status === 'connected' || sess.status === 'connecting')) {
        const cfg = this.getHostConfig(alias)
        items.push(this._serializeSession(alias, { alias, hostName: alias, port: 22 }, cfg))
      }
    }

    const syncedWorkspaces = this.workspaceBridge.listSyncedWorkspaces(
      (h) => this.sessions.get(h)?.status ?? 'disconnected',
    )
    const invalidatedWorkspaces = syncedWorkspaces.filter((w) => w.invalidated)

    return {
      configPath: parsed.configPath,
      configExists: parsed.exists,
      dshVersion: this.dshVersion,
      localPlugins,
      syncedWorkspaces,
      invalidatedWorkspaces,
      hosts: items,
    }
  }

  async getHostStatus(host) {
    const list = await this.listHosts()
    const found = list.hosts.find((item) => item.alias === host)
    if (found) return found
    const cfg = this.getHostConfig(host)
    return this._serializeSession(host, { alias: host, hostName: host, port: 22 }, cfg)
  }

  /**
   * Initiate an SSH connection to `host`, install/verify DSH on the remote,
   * forward `localPort -> remotePort`, and launch remote DSH.
   *
   * @param {string} host
   * @param {object} [options]
   * @param {boolean} [options.waitForReady=false] - Wait until connected or failed before resolving.
   * @param {number} [options.overrideRemotePort] - Optional one-time/saved remotePort override.
   */
  async connectHost(host, options = {}) {
    const hostKey = validateHostAlias(host)
    await this.askpass.start()

    if (options.overrideRemotePort !== undefined) {
      await this.configureHost(hostKey, { remotePort: options.overrideRemotePort })
    }

    const existing = this.sessions.get(hostKey)
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
      if (options.waitForReady && existing.readyPromise) {
        await existing.readyPromise.catch(() => {})
      }
      return this.getHostStatus(hostKey)
    }

    const cfg = this.getHostConfig(hostKey)
    let allocatedLocalPort
    try {
      allocatedLocalPort = await acquireLocalPort(cfg.localPort)
    } catch (err) {
      const failedSession = {
        host: hostKey,
        status: 'error',
        phase: 'idle',
        activeLocalPort: null,
        activeRemotePort: cfg.remotePort,
        activeProfile: cfg.profile,
        dshVersion: this.dshVersion,
        remotePid: null,
        initializedFromWeb: false,
        url: null,
        connectedAt: null,
        authPrompt: null,
        recentLogs: [],
        error: {
          code: 'LOCAL_PORT_IN_USE',
          localPort: cfg.localPort,
          remotePort: cfg.remotePort,
          message: `Local port ${cfg.localPort} is already in use on this machine. Please choose another local port or set it to 0 for automatic allocation.`,
        },
      }
      this.sessions.set(hostKey, failedSession)
      return this.getHostStatus(hostKey)
    }

    const { sshCommand, encodedScript } = buildRemoteBootstrapScript({
      dshVersion: this.dshVersion,
      remotePort: cfg.remotePort,
      localPort: allocatedLocalPort,
      profile: cfg.profile,
      forceInstallNode: this.forceInstallNode,
      customDshTarballUrl: this.customDshTarballUrl,
    })

    const askpassSession = this.askpass.createSessionEnv(hostKey)

    let resolveReady
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve
    })

    const session = {
      host: hostKey,
      status: 'connecting',
      phase: 'connecting_ssh',
      activeLocalPort: allocatedLocalPort,
      activeRemotePort: cfg.remotePort,
      activeProfile: cfg.profile,
      dshVersion: this.dshVersion,
      remotePid: null,
      initializedFromWeb: false,
      url: null,
      connectedAt: null,
      authPrompt: null,
      error: null,
      recentLogs: [],
      child: null,
      askpassSession,
      keepaliveTimer: null,
      readyPromise,
      resolveReady,
      userDisconnecting: false,
      pendingRpcs: new Map(),
    }
    this.sessions.set(hostKey, session)

    const rejectAllPendingRpcs = (reason) => {
      for (const [, pending] of session.pendingRpcs.entries()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(reason))
      }
      session.pendingRpcs.clear()
    }

    const appendLog = (line) => {
      if (!line) return
      const sanitized = String(line).replace(/([?&]token=)[^&\s#]+/gi, '$1[REDACTED]')
      session.recentLogs.push(sanitized)
      if (session.recentLogs.length > 30) {
        session.recentLogs.shift()
      }
    }

    const sshArgs = [
      '-T',
      '-o', 'BatchMode=no',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=6',
      '-o', 'TCPKeepAlive=yes',
      '-o', 'ConnectTimeout=20',
      '-L', `127.0.0.1:${allocatedLocalPort}:127.0.0.1:${cfg.remotePort}`,
      ...this.extraSshArgs,
      '--',
      hostKey,
      sshCommand,
    ]

    let child
    try {
      child = this.spawnProcess(this.sshExecutable, sshArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ...askpassSession.env,
        },
      })
    } catch (err) {
      askpassSession.dispose()
      session.status = 'error'
      session.phase = 'idle'
      session.error = {
        code: 'SSH_SPAWN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
      resolveReady(session)
      return this.getHostStatus(hostKey)
    }

    session.child = child
    if (child.stdin?.writable && encodedScript) {
      child.stdin.write(`${encodedScript}\n`)
    }
    session.keepaliveTimer = setInterval(() => {
      if (session.child && !session.child.killed && session.child.stdin?.writable) {
        try {
          session.child.stdin.write('PING\n', () => {})
        } catch {}
      }
    }, 15_000)
    session.keepaliveTimer.unref?.()

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return
      if (ev.type === 'phase') {
        session.phase = ev.phase || session.phase
        if (typeof ev.initializedFromWeb === 'boolean') {
          session.initializedFromWeb = ev.initializedFromWeb
        }
        return
      }
      if (ev.type === 'dsh_ready') {
        appendLog(ev.cached
          ? `DSH ${ev.version} already installed in ~/.dsh-remote-ssh-connect/${ev.version}`
          : `Installed DSH ${ev.version} in ~/.dsh-remote-ssh-connect/${ev.version}`)
        return
      }
      if (ev.type === 'version_pruned') {
        appendLog(`Removed oldest version ~/.dsh-remote-ssh-connect/${ev.version}`)
        return
      }
      if (ev.type === 'port_in_use') {
        const port = ev.port ?? cfg.remotePort
        const pid = ev.pid ?? null
        const command = ev.command || null
        session.status = 'error'
        session.phase = 'idle'
        session.error = {
          code: 'REMOTE_PORT_IN_USE',
          remotePort: port,
          localPort: allocatedLocalPort,
          ...(pid ? { occupantPid: Number(pid) } : {}),
          ...(command ? { occupantCommand: String(command) } : {}),
          message: `Remote port ${port} is already in use${pid ? ` (PID ${pid}${command ? `: ${command}` : ''})` : ''}. Terminate the occupying process or choose another remote port.`,
        }
        resolveReady(session)
        setTimeout(() => {
          try {
            if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
          } catch {}
        }, 300).unref?.()
        return
      }
      if (ev.type === 'ready') {
        session.status = 'connected'
        session.phase = 'ready'
        session.url = ev.url || `http://127.0.0.1:${allocatedLocalPort}/`
        session.remotePid = ev.pid ?? null
        session.connectedAt = session.connectedAt ?? Date.now()
        if (typeof ev.initializedFromWeb === 'boolean') {
          session.initializedFromWeb = ev.initializedFromWeb
        }
        Promise.resolve(this.workspaceBridge.onHostConnected(hostKey, session.url))
          .catch(() => {})
          .finally(() => {
            resolveReady(session)
          })
        return
      }
      if (ev.type === 'error') {
        session.status = 'error'
        session.phase = 'idle'
        session.error = {
          code: 'REMOTE_ERROR',
          remotePort: cfg.remotePort,
          message: ev.message || 'Remote bootstrap error',
        }
        resolveReady(session)
        setTimeout(() => {
          try {
            if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
          } catch {}
        }, 300).unref?.()
        return
      }
      if (ev.type === 'rpc_result' && ev.id) {
        const pending = session.pendingRpcs.get(ev.id)
        if (pending) {
          clearTimeout(pending.timer)
          session.pendingRpcs.delete(ev.id)
          if (ev.ok) {
            pending.resolve(ev.value)
          } else {
            appendLog(`RPC error (${ev.id}): ${ev.error || 'Remote operation failed'}`)
            pending.reject(new Error(ev.error || 'Remote operation failed'))
          }
        }
        return
      }
      if (ev.type === 'log' && ev.line) {
        appendLog(ev.line)
      }
    }

    const parseLine = (line, isStderr = false) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const idx = trimmed.indexOf(EVENT_PREFIX)
      if (idx !== -1) {
        const jsonPart = trimmed.slice(idx + EVENT_PREFIX.length)
        try {
          handleEvent(JSON.parse(jsonPart))
          return
        } catch {
          /* fall through */
        }
      }
      appendLog(trimmed)
      if (isStderr) {
        if (/address already in use|cannot listen to port/i.test(trimmed) && !session.error) {
          session.error = {
            code: 'LOCAL_PORT_IN_USE',
            localPort: allocatedLocalPort,
            remotePort: cfg.remotePort,
            message: `Local port ${allocatedLocalPort} could not be bound for SSH forwarding: ${trimmed}`,
          }
        } else if (/permission denied/i.test(trimmed) && !session.error) {
          session.error = {
            code: 'AUTH_FAILED',
            message: `SSH authentication failed for ${hostKey}: ${trimmed}`,
          }
        }
      }
    }

    createInterface({ input: child.stdout }).on('line', (l) => parseLine(l, false))
    createInterface({ input: child.stderr }).on('line', (l) => parseLine(l, true))

    child.once('error', (err) => {
      if (session.keepaliveTimer) {
        clearInterval(session.keepaliveTimer)
        session.keepaliveTimer = null
      }
      askpassSession.dispose()
      this.workspaceBridge.onHostDisconnected(hostKey)
      rejectAllPendingRpcs(err instanceof Error ? err.message : String(err))
      if (!session.userDisconnecting) {
        session.status = 'error'
        session.phase = 'idle'
        session.error = session.error ?? {
          code: 'SSH_ERROR',
          message: err instanceof Error ? err.message : String(err),
        }
      }
      resolveReady(session)
    })

    child.once('close', (code) => {
      if (session.keepaliveTimer) {
        clearInterval(session.keepaliveTimer)
        session.keepaliveTimer = null
      }
      askpassSession.dispose()
      this.workspaceBridge.onHostDisconnected(hostKey)
      rejectAllPendingRpcs(`SSH connection closed (code ${String(code)})`)
      if (session.userDisconnecting) {
        session.status = 'disconnected'
        session.phase = 'idle'
        session.url = null
        session.remotePid = null
        resolveReady(session)
        return
      }
      if (session.status !== 'error') {
        if (code === 42 && !session.error) {
          session.status = 'error'
          session.phase = 'idle'
          session.error = {
            code: 'REMOTE_PORT_IN_USE',
            remotePort: cfg.remotePort,
            localPort: allocatedLocalPort,
            message: `Remote port ${cfg.remotePort} is already in use on ${hostKey}.`,
          }
        } else {
          session.status = 'error'
          session.phase = 'idle'
          const lastLog = session.recentLogs.at(-1) || `SSH exited with code ${String(code)}`
          session.error = {
            code: 'SSH_DISCONNECTED',
            message: lastLog,
          }
        }
      }
      session.url = null
      session.remotePid = null
      resolveReady(session)
    })

    if (options.waitForReady) {
      await readyPromise
    }

    return this.getHostStatus(hostKey)
  }

  /**
   * Disconnect an active or connecting SSH session and terminate the remote DSH process.
   * @param {string} host
   */
  async disconnectHost(host) {
    const hostKey = String(host || '').trim()
    const session = this.sessions.get(hostKey)
    if (!session) {
      return this.getHostStatus(hostKey)
    }

    session.userDisconnecting = true
    session.status = 'disconnecting'
    session.phase = 'idle'
    if (session.keepaliveTimer) {
      clearInterval(session.keepaliveTimer)
      session.keepaliveTimer = null
    }
    session.askpassSession?.dispose()

    const child = session.child
    if (child && child.exitCode === null && !child.killed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {}
          setTimeout(() => {
            try {
              if (child.exitCode === null) child.kill('SIGKILL')
            } catch {}
            resolve()
          }, 500)
        }, 3000)

        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })

        try {
          if (child.stdin?.writable) {
            child.stdin.write('SHUTDOWN\n')
            setTimeout(() => {
              try {
                if (child.stdin?.writable) child.stdin.end()
              } catch {}
            }, 300).unref?.()
          } else {
            child.kill('SIGTERM')
          }
        } catch {
          try {
            child.kill('SIGTERM')
          } catch {}
        }
      })
    }

    this.workspaceBridge.onHostDisconnected(hostKey)
    this.sessions.delete(hostKey)
    return this.getHostStatus(hostKey)
  }

  /**
   * Submit interactive password / OTP authentication input for a host.
   * @param {string} host
   * @param {object} payload
   * @param {string} [payload.promptId]
   * @param {string} payload.value
   */
  submitAuth(host, payload = {}) {
    const hostKey = String(host || '').trim()
    const rawVal = typeof payload.value === 'string' ? payload.value : ''
    const ok = this.askpass.submitForHost(hostKey, payload.promptId, rawVal)
    return { ok }
  }

  /**
   * Cancel interactive authentication. If `host` is still in the initial login/connecting
   * phase (`status === 'connecting'`), immediately terminate the SSH connection attempt;
   * never disconnect an already-connected host.
   * @param {string} host
   * @param {object} [payload]
   * @param {string} [payload.promptId]
   */
  async cancelAuth(host, payload = {}) {
    const hostKey = String(host || '').trim()
    this.askpass.cancelForHost(hostKey, payload.promptId)
    const sess = this.sessions.get(hostKey)
    if (sess && sess.status === 'connecting') {
      await this.disconnectHost(hostKey)
      return { ok: true, disconnected: true }
    }
    return { ok: true, disconnected: false }
  }

  /**
   * Terminate the process occupying `remotePort` on `host`, optionally reconnecting right after.
   * @param {string} host
   * @param {object} [options]
   * @param {number} [options.remotePort]
   * @param {boolean} [options.reconnect=true]
   * @param {boolean} [options.waitForReady=false]
   */
  async killRemotePortOccupant(host, options = {}) {
    const hostKey = validateHostAlias(host)
    const cfg = this.getHostConfig(hostKey)
    const sess = this.sessions.get(hostKey)
    const targetPort = Number(options.remotePort ?? sess?.error?.remotePort ?? cfg.remotePort)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error(`Invalid remote port: ${String(targetPort)}`)
    }

    await this.askpass.start()
    const askpassSession = this.askpass.createSessionEnv(hostKey)
    const killCmd = buildKillRemotePortScript(targetPort)

    const sshArgs = [
      '-T',
      '-o', 'BatchMode=no',
      '-o', 'ConnectTimeout=15',
      ...this.extraSshArgs,
      '--',
      hostKey,
      killCmd,
    ]

    try {
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.sshExecutable, sshArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            ...askpassSession.env,
          },
        })
        let stderr = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (c) => { stderr += c })
        child.once('error', reject)
        child.once('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `Failed to terminate remote port occupant (exit ${code})`))
        })
      })
    } finally {
      askpassSession.dispose()
    }

    // Clear error state
    if (this.sessions.get(hostKey)?.status === 'error') {
      this.sessions.delete(hostKey)
    }

    if (options.reconnect !== false) {
      return this.connectHost(hostKey, { waitForReady: options.waitForReady === true })
    }
    return this.getHostStatus(hostKey)
  }

  /**
   * Open the mapped local URL of a connected host in the OS default browser.
   * @param {string} host
   */
  async openRemoteDsh(host) {
    const hostKey = String(host || '').trim()
    const sess = this.sessions.get(hostKey)
    if (!sess || sess.status !== 'connected' || !sess.url) {
      throw new Error(`Host "${hostKey}" is not currently connected.`)
    }
    return this.openBrowser(sess.url)
  }

  /**
   * Send a JSON RPC command over the existing long-lived SSH session's stdin to the remote
   * Node supervisor and await its `rpc_result` event on stdout. Reuses the already-authenticated
   * SSH connection so no additional password or OTP prompts are triggered.
   *
   * @param {object} session
   * @param {string} method
   * @param {object} [params]
   * @param {string | null} [base64Payload]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  _sendSessionRpc(session, method, params = {}, base64Payload = null, timeoutMs = 300_000) {
    if (!session || session.status !== 'connected' || !session.child || session.child.killed || !session.child.stdin?.writable) {
      return Promise.reject(new Error(`Host "${session?.host || ''}" does not have an active SSH control channel.`))
    }

    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingRpcs.delete(id)
        reject(new Error(`Remote operation "${method}" timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)

      session.pendingRpcs.set(id, { resolve, reject, timer })

      try {
        if (typeof base64Payload === 'string' && base64Payload.length > 0) {
          const CHUNK_SIZE = 32768
          for (let offset = 0; offset < base64Payload.length; offset += CHUNK_SIZE) {
            const slice = base64Payload.slice(offset, offset + CHUNK_SIZE)
            session.child.stdin.write(`RPC_CHUNK:${JSON.stringify({ id, data: slice })}\n`)
          }
        }
        session.child.stdin.write(`RPC:${JSON.stringify({ id, method, params })}\n`)
      } catch (err) {
        clearTimeout(timer)
        session.pendingRpcs.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Synchronize a locally installed plugin to a connected remote host using the same
   * installation method (`npm`, `github`, or `local`) over the existing long-lived SSH connection.
   *
   * - Reuses the already-authenticated SSH control channel (zero extra SSH connections or auth prompts).
   * - If the plugin is not installed on the remote, installs it directly.
   * - If the plugin is already installed on the remote and `remoteVersion <= localVersion`,
   *   deletes the remote plugin and reinstalls it directly.
   * - If the plugin is already installed on the remote and `remoteVersion > localVersion`:
   *   - When `force !== true`, returns `{ status: 'confirm_required', ... }` so the UI can ask the user for confirmation.
   *   - When `force === true`, deletes the remote plugin and reinstalls it.
   *
   * @param {string} host
   * @param {object} options
   * @param {string} options.pluginName
   * @param {boolean} [options.force=false]
   */
  async syncPluginToHost(host, options = {}) {
    const hostKey = validateHostAlias(host)
    const pluginName = String(options.pluginName || '').trim()
    const force = options.force === true

    if (!pluginName) throw new Error('Plugin name is required.')

    const sess = this.sessions.get(hostKey)
    if (!sess || sess.status !== 'connected') {
      throw new Error(`Host "${hostKey}" must be connected before syncing plugins.`)
    }

    const localPlugins = await this.listLocalPlugins()
    const localPlugin = localPlugins.find((p) => p.name === pluginName)
    if (!localPlugin) {
      throw new Error(`Local plugin "${pluginName}" was not found in the local DSH profile.`)
    }

    const remoteProfile = sess.activeProfile || 'web'

    // Step 1: Check whether the plugin is already installed on the remote profile via the active SSH channel
    const checkResult = await this._sendSessionRpc(sess, 'check_plugin', {
      packageName: localPlugin.name,
    })

    const remoteInstalled = Boolean(checkResult?.installed)
    const remoteVersion = typeof checkResult?.remoteVersion === 'string' && checkResult.remoteVersion.trim() !== ''
      ? checkResult.remoteVersion.trim()
      : null

    // Step 2: Compare versions if already installed on remote
    if (remoteInstalled && remoteVersion !== null) {
      const cmp = comparePluginVersions(remoteVersion, localPlugin.version)
      if (cmp > 0 && !force) {
        return {
          status: 'confirm_required',
          host: hostKey,
          profile: remoteProfile,
          pluginName: localPlugin.name,
          pluginTitle: localPlugin.title,
          sourceKind: localPlugin.sourceKind,
          localVersion: localPlugin.version,
          remoteVersion,
        }
      }
    }

    // Step 3: Prepare base64 payload for local-source plugins
    let base64Payload = null
    let tarballFilename = 'plugin.tgz'
    if (localPlugin.sourceKind === 'local') {
      if (localPlugin.localSubkind === 'tarball') {
        const rawTgz = await readFile(localPlugin.localPath)
        base64Payload = rawTgz.toString('base64')
        tarballFilename = basename(localPlugin.localPath)
      } else {
        const packed = await packLocalPluginDirectory(localPlugin.localPath)
        base64Payload = packed.toString('base64')
      }
    }

    // Step 4: Remove any existing remote copy and install through the remote supervisor, which drives the
    // live remote PluginManager over the active SSH channel. Failures surface as errors.
    const syncedResult = await this._sendSessionRpc(
      sess,
      'install_plugin',
      {
        packageName: localPlugin.name,
        sourceKind: localPlugin.sourceKind,
        localSubkind: localPlugin.localSubkind,
        localLinkPrefix: localPlugin.localLinkPrefix,
        installSpec: localPlugin.installSpec,
        tarballFilename,
        reinstall: remoteInstalled,
      },
      base64Payload,
    )

    return {
      status: 'synced',
      host: hostKey,
      profile: remoteProfile,
      pluginName: localPlugin.name,
      pluginTitle: localPlugin.title,
      sourceKind: localPlugin.sourceKind,
      localVersion: localPlugin.version,
      installedVersion: syncedResult?.installedVersion || localPlugin.version,
      previousRemoteVersion: remoteVersion,
      reinstalled: remoteInstalled,
      restartRequired: Boolean(syncedResult?.restartRequired),
    }
  }

  /**
   * Compare user-installed plugins between the local profile and a connected remote host.
   * Excludes `dsh-remote-ssh-connect` itself (which is a local management plugin).
   * @param {string} host
   */
  async compareHostPlugins(host) {
    const hostKey = String(host || '').trim()
    const sess = this.sessions.get(hostKey)
    if (!sess || sess.status !== 'connected') {
      return {
        missingOnRemote: [],
        missingOnLocal: [],
        versionMismatches: [],
      }
    }

    const [localPlugins, remoteRes] = await Promise.all([
      this.listLocalPlugins().catch(() => []),
      this._sendSessionRpc(sess, 'list_plugins', {}, null, 15_000).catch(() => ({ plugins: [] })),
    ])

    const remotePlugins = Array.isArray(remoteRes?.plugins) ? remoteRes.plugins : []
    const localByName = new Map()
    for (const lp of localPlugins) {
      if (lp.name === 'dsh-remote-ssh-connect') continue
      localByName.set(lp.name, lp)
    }
    const remoteByName = new Map()
    for (const rp of remotePlugins) {
      if (rp.name === 'dsh-remote-ssh-connect') continue
      remoteByName.set(rp.name, rp)
    }

    const missingOnRemote = []
    const missingOnLocal = []
    const versionMismatches = []

    for (const [name, lp] of localByName.entries()) {
      const rp = remoteByName.get(name)
      if (!rp) {
        missingOnRemote.push({
          name: lp.name,
          version: lp.version,
          title: lp.title,
          sourceKind: lp.sourceKind,
        })
      } else if (rp.version && lp.version && comparePluginVersions(lp.version, rp.version) !== 0) {
        versionMismatches.push({
          name: lp.name,
          localVersion: lp.version,
          remoteVersion: rp.version,
          title: lp.title,
          sourceKind: lp.sourceKind,
        })
      }
    }

    for (const [name, rp] of remoteByName.entries()) {
      if (!localByName.has(name)) {
        missingOnLocal.push({
          name: rp.name,
          version: rp.version,
          title: rp.title,
          hasClientUi: Boolean(rp.hasClientUi),
          sourceKind: rp.sourceKind || 'npm',
        })
      }
    }

    return {
      missingOnRemote,
      missingOnLocal,
      versionMismatches,
    }
  }

  /**
   * List remote workspaces on a connected host along with synced status and plugin difference summary.
   * @param {string} host
   */
  async listRemoteWorkspaces(host) {
    const hostKey = String(host || '').trim()
    const sess = this.sessions.get(hostKey)
    if (!sess || sess.status !== 'connected') {
      throw new Error(`Host "${hostKey}" must be connected before listing remote workspaces.`)
    }
    if (!this.workspaceBridge.isHostConnected(hostKey) && sess.url) {
      await this.workspaceBridge.onHostConnected(hostKey, sess.url)
    }
    const [workspaces, pluginDiff] = await Promise.all([
      this.workspaceBridge.listRemoteWorkspaces(hostKey),
      this.compareHostPlugins(hostKey).catch(() => ({
        missingOnRemote: [],
        missingOnLocal: [],
        versionMismatches: [],
      })),
    ])
    const syncedWorkspaces = this.workspaceBridge
      .listSyncedWorkspaces((h) => this.sessions.get(h)?.status ?? 'disconnected')
      .filter((w) => w.host === hostKey)

    return {
      host: hostKey,
      workspaces,
      syncedWorkspaces,
      pluginDiff,
    }
  }

  /**
   * Synchronize a remote workspace to the local DSH so its sessions can be viewed, created,
   * edited, and prompted directly from the local DSH sidebar.
   * @param {string} host
   * @param {object} options
   * @param {string} [options.remoteWorkspaceId]
   * @param {string} [options.path]
   * @param {string} [options.title]
   */
  async syncRemoteWorkspace(host, options = {}) {
    const hostKey = String(host || '').trim()
    const sess = this.sessions.get(hostKey)
    if (!sess || sess.status !== 'connected') {
      throw new Error(`Host "${hostKey}" must be connected before syncing a remote workspace.`)
    }
    if (!this.workspaceBridge.isHostConnected(hostKey) && sess.url) {
      await this.workspaceBridge.onHostConnected(hostKey, sess.url)
    }
    const [syncRes, pluginDiff] = await Promise.all([
      this.workspaceBridge.syncRemoteWorkspace(hostKey, options),
      this.compareHostPlugins(hostKey).catch(() => ({
        missingOnRemote: [],
        missingOnLocal: [],
        versionMismatches: [],
      })),
    ])
    return {
      ...syncRes,
      pluginDiff,
    }
  }

  /**
   * Remove / unsync a remote workspace (or acknowledge & remove an invalidated remote workspace).
   * @param {string} localWorkspaceId
   */
  async removeSyncedWorkspace(localWorkspaceId) {
    return this.workspaceBridge.removeSyncedWorkspace(localWorkspaceId)
  }

  /**
   * List all locally persisted remote workspaces and their current connection/invalidation status.
   */
  listSyncedWorkspaces() {
    const items = this.workspaceBridge.listSyncedWorkspaces(
      (h) => this.sessions.get(h)?.status ?? 'disconnected',
    )
    return {
      syncedWorkspaces: items,
      invalidatedWorkspaces: items.filter((w) => w.invalidated),
    }
  }

  /**
   * Resolve which remote host (if any) owns `sessionId`.
   * @param {string} sessionId
   */
  getSessionHost(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!sid) return { host: null }
    const host = this.workspaceBridge.getHostForSession(sid)
    return { host: host || null }
  }

  /**
   * Fetch the remote `session/modelCatalog` from a connected remote host (resolved by `host` or `sessionId`).
   * @param {object} [options]
   * @param {string} [options.host]
   * @param {string} [options.sessionId]
   */
  async getRemoteModelCatalog(options = {}) {
    const explicitHost = typeof options?.host === 'string' && options.host.trim()
      ? options.host.trim()
      : null
    const sessionHost = !explicitHost && typeof options?.sessionId === 'string' && options.sessionId.trim()
      ? this.workspaceBridge.getHostForSession(options.sessionId.trim())
      : null
    const targetHost = explicitHost || sessionHost
    if (!targetHost) {
      throw new Error('Remote host alias or remote sessionId is required.')
    }
    const sess = this.sessions.get(targetHost)
    if (!sess || sess.status !== 'connected') {
      throw new Error(`Remote host "${targetHost}" is not connected.`)
    }
    if (!this.workspaceBridge.isHostConnected(targetHost) && sess.url) {
      await this.workspaceBridge.onHostConnected(targetHost, sess.url)
    }
    const client = this.workspaceBridge.hostClients.get(targetHost)
    if (!client || client.disposed) {
      throw new Error(`Remote gateway client for "${targetHost}" is not available.`)
    }
    const res = await client.callRpc('session/modelCatalog', {}, undefined, 15_000)
    if (!res?.ok) {
      throw new Error(res?.error?.message || `Failed to load model catalog from remote host "${targetHost}"`)
    }
    return {
      host: targetHost,
      catalog: res.value,
    }
  }

  /**
   * Synchronous best-effort teardown when the local DSH process exits.
   */
  killAllSync() {
    for (const session of this.sessions.values()) {
      session.userDisconnecting = true
      if (session.keepaliveTimer) {
        clearInterval(session.keepaliveTimer)
        session.keepaliveTimer = null
      }
      const child = session.child
      if (child && child.exitCode === null && !child.killed) {
        try {
          if (child.stdin?.writable) {
            child.stdin.write('SHUTDOWN\n')
            child.stdin.end()
          }
        } catch {}
        try {
          child.kill('SIGTERM')
        } catch {}
      }
    }
  }

  async dispose() {
    process.off('exit', this._exitHandler)
    this.workspaceBridge.dispose()
    const hosts = [...this.sessions.keys()]
    await Promise.allSettled(hosts.map((h) => this.disconnectHost(h)))
    await this.askpass.stop()
  }
}

export {
  RemoteWorkspaceBridge,
  makeLocalWorkspaceId,
  normalizeSyncedWorkspaceRecord,
  parseLocalWorkspaceId,
} from './remote-workspace-bridge.js'
