// Host half of dsh-remote-connect: manages SSH connections from ~/.ssh/config,
// persists per-host port/profile settings in storageDomain, exposes /api/remote-connect/*
// routes for the Web UI, and registers the remote_connect agent tool.

import { RemoteConnectionManager, normalizeHostConfig } from './src/connection-manager.js'

export const name = 'remote-connect'

const DOMAIN_NAME = 'dsh_remote_connect'
const DOMAIN_VERSION = 1

const hostConfigSchema = {
  parse(raw) {
    if (raw === null || typeof raw !== 'object') {
      throw new TypeError('host config record must be an object')
    }
    return normalizeHostConfig(raw)
  },
  safeParse(raw) {
    try {
      return { success: true, data: this.parse(raw) }
    } catch (error) {
      return { success: false, error }
    }
  },
}

const domainSpec = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  invalidRecords: 'backup-and-skip',
  tables: {
    hostConfigs: { valueSchema: hostConfigSchema },
  },
}

function registerRoute(ctx, op, handler) {
  ctx.inject(['connection'], (scope) => {
    const path = `/api/remote-connect/${op}`
    scope.effect(() => scope.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: 'Request body must be valid JSON' }, { status: 400 })
        }
        try {
          const value = await handler(body ?? {})
          return Response.json({ ok: true, value: value ?? null })
        } catch (error) {
          scope.logger?.warn?.(`${path} failed`, error)
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 400 })
        }
      },
    }), `remote-connect: ${path}`)
  })
}

function registerAgentTool(ctx, manager) {
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'remote_connect',
      description: 'Manage SSH remote DSH connections configured in ~/.ssh/config: list hosts and their connection statuses, configure per-host remotePort/localPort/profile, connect or disconnect a host, open a connected remote DSH in the default browser, or terminate a conflicting process occupying the remote port. Interactive password/OTP entry remains user-only in the SSH Login UI.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list_hosts', 'get_status', 'configure_host', 'connect', 'disconnect', 'open_browser', 'kill_remote_port'],
            description: 'Operation to perform.',
          },
          host: {
            type: 'string',
            description: 'SSH host alias from ~/.ssh/config (required for all actions except list_hosts).',
          },
          remotePort: {
            type: 'integer',
            description: 'Remote port for DSH (1-65535, default 3080). Used by configure_host, connect, or kill_remote_port.',
          },
          localPort: {
            type: 'integer',
            description: 'Local forwarded port (0 for auto-allocation, or 1-65535). Used by configure_host.',
          },
          profile: {
            type: 'string',
            description: 'Remote DSH profile name (default "web"). Non-existent custom profiles are initialized with --from-default-profile web.',
          },
          waitForReady: {
            type: 'boolean',
            description: 'For connect or kill_remote_port: wait until the remote DSH finishes starting or fails before returning.',
          },
          reconnect: {
            type: 'boolean',
            description: 'For kill_remote_port: whether to automatically reconnect after terminating the occupying process (default true).',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const action = args?.action
        switch (action) {
          case 'list_hosts': {
            const res = await manager.listHosts()
            return JSON.stringify(res, null, 2)
          }
          case 'get_status': {
            if (!args?.host) throw new Error('Parameter "host" is required for get_status')
            const res = await manager.getHostStatus(args.host)
            return JSON.stringify(res, null, 2)
          }
          case 'configure_host': {
            if (!args?.host) throw new Error('Parameter "host" is required for configure_host')
            await manager.configureHost(args.host, {
              ...(args.remotePort !== undefined ? { remotePort: args.remotePort } : {}),
              ...(args.localPort !== undefined ? { localPort: args.localPort } : {}),
              ...(args.profile !== undefined ? { profile: args.profile } : {}),
            })
            const res = await manager.getHostStatus(args.host)
            return JSON.stringify(res, null, 2)
          }
          case 'connect': {
            if (!args?.host) throw new Error('Parameter "host" is required for connect')
            const res = await manager.connectHost(args.host, {
              waitForReady: args.waitForReady !== false,
              ...(args.remotePort !== undefined ? { overrideRemotePort: args.remotePort } : {}),
            })
            return JSON.stringify(res, null, 2)
          }
          case 'disconnect': {
            if (!args?.host) throw new Error('Parameter "host" is required for disconnect')
            const res = await manager.disconnectHost(args.host)
            return JSON.stringify(res, null, 2)
          }
          case 'open_browser': {
            if (!args?.host) throw new Error('Parameter "host" is required for open_browser')
            const res = await manager.openRemoteDsh(args.host)
            return JSON.stringify(res, null, 2)
          }
          case 'kill_remote_port': {
            if (!args?.host) throw new Error('Parameter "host" is required for kill_remote_port')
            const res = await manager.killRemotePortOccupant(args.host, {
              remotePort: args.remotePort,
              reconnect: args.reconnect !== false,
              waitForReady: args.waitForReady !== false,
            })
            return JSON.stringify(res, null, 2)
          }
          default:
            throw new Error(`Unknown action: ${String(action)}`)
        }
      },
    }), 'remote-connect: tool')
  })
}

export function apply(ctx, config = {}) {
  let table

  const manager = new RemoteConnectionManager({
    ...config,
    onSaveConfig: async (host, hostCfg) => {
      if (table !== undefined) {
        await table.put(host, hostCfg)
      }
    },
  })

  ctx.effect(() => {
    let domain
    let disposed = false
    const ready = (async () => {
      const storageDomain = ctx.get?.('storageDomain') ?? ctx.storageDomain
      const initialConfigs = {}
      if (storageDomain) {
        try {
          domain = await storageDomain.open(domainSpec)
          if (disposed) {
            await domain.close()
            return
          }
          table = domain.table('hostConfigs')
          for (const [hostKey, record] of table.entries()) {
            initialConfigs[hostKey] = record
          }
        } catch (err) {
          ctx.logger?.warn?.('remote-connect: storageDomain open failed, using in-memory config', err)
        }
      }
      if (!disposed) {
        await manager.init(initialConfigs)
      }
    })()

    return async () => {
      disposed = true
      table = undefined
      await ready.catch(() => {})
      await manager.dispose()
      if (domain !== undefined) {
        await domain.close().catch(() => {})
      }
    }
  }, 'remote-connect: lifecycle')

  registerRoute(ctx, 'list', () => manager.listHosts())
  registerRoute(ctx, 'status', (body) => manager.getHostStatus(body.host))
  registerRoute(ctx, 'configure', async (body) => {
    await manager.configureHost(body.host, body.config ?? {})
    return manager.getHostStatus(body.host)
  })
  registerRoute(ctx, 'connect', (body) => manager.connectHost(body.host, {
    waitForReady: Boolean(body.waitForReady),
    overrideRemotePort: body.remotePort,
  }))
  registerRoute(ctx, 'disconnect', (body) => manager.disconnectHost(body.host))
  registerRoute(ctx, 'open-browser', (body) => manager.openRemoteDsh(body.host))
  registerRoute(ctx, 'kill-port', (body) => manager.killRemotePortOccupant(body.host, {
    remotePort: body.remotePort,
    reconnect: body.reconnect !== false,
    waitForReady: Boolean(body.waitForReady),
  }))
  registerRoute(ctx, 'auth-submit', (body) => manager.submitAuth(body.host, {
    promptId: body.promptId,
    value: body.value,
    otp: body.otp,
  }))
  registerRoute(ctx, 'auth-cancel', (body) => manager.cancelAuth(body.host, {
    promptId: body.promptId,
  }))

  registerAgentTool(ctx, manager)

  return manager
}

export {
  RemoteConnectionManager,
  normalizeHostConfig,
  resolveLocalDshVersion,
  acquireLocalPort,
  validateHostConfigInput,
} from './src/connection-manager.js'
export {
  loadSshConfigHosts,
  parseSshConfigText,
  resolveHostsFromBlocks,
  isConcreteHostPattern,
  hostBlockMatches,
} from './src/ssh-config.js'
export {
  buildRemoteBootstrapScript,
  buildKillRemotePortScript,
} from './src/remote-script.js'
export {
  openUrlInDefaultBrowser,
} from './src/browser-opener.js'
