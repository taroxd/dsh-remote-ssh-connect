// Host half of dsh-remote-ssh-connect: manages SSH connections from ~/.ssh/config,
// persists per-host port/profile settings and synced remote workspaces in storageDomain,
// bridges local TypertGateway RPC/streams to remote DSH instances, exposes /api/remote-ssh-connect/*
// routes for the Web UI, and registers the remote_ssh_connect agent tool.

import {
  RemoteConnectionManager,
  normalizeHostConfig,
  normalizeSyncedWorkspaceRecord,
} from './src/connection-manager.js'

export const name = 'remote-ssh-connect'

const DOMAIN_NAME = 'dsh_remote_ssh_connect'
const DOMAIN_VERSION = 2

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

const syncedWorkspaceSchema = {
  parse(raw) {
    if (raw === null || typeof raw !== 'object') {
      throw new TypeError('synced workspace record must be an object')
    }
    return normalizeSyncedWorkspaceRecord(raw)
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
  compatibleVersions: [0, 1],
  invalidRecords: 'backup-and-skip',
  tables: {
    host_configs: { valueSchema: hostConfigSchema },
    remote_workspaces: { valueSchema: syncedWorkspaceSchema },
  },
}

const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function unwrapCordisService(svc) {
  if (!svc || typeof svc !== 'object') return svc
  try {
    const original = svc[CORDIS_ORIGINAL]
    if (original && typeof original === 'object' && original !== svc) {
      return original
    }
  } catch {}
  return svc
}

function registerRoute(ctx, op, handler) {
  ctx.inject(['connection'], (scope) => {
    const path = `/api/remote-ssh-connect/${op}`
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
    }), `remote-ssh-connect: ${path}`)
  })
}

function registerGatewayFederation(ctx, manager) {
  ctx.inject(['typertGateway'], (scope) => {
    scope.effect(() => {
      const gw = unwrapCordisService(scope.typertGateway)
      if (!gw || typeof gw.dispatchRpc !== 'function' || typeof gw.openWireStream !== 'function') {
        return () => {}
      }

      const wsCtrl = unwrapCordisService(scope.get?.('workspaceController'))
      const sessCtrl = unwrapCordisService(scope.get?.('sessionController'))
      manager.workspaceBridge.attachHostControllers({
        gateway: gw,
        workspaceController: wsCtrl,
        sessionController: sessCtrl,
      })

      const origDispatchRpc = gw.dispatchRpc.bind(gw)
      const origOpenWireStream = gw.openWireStream.bind(gw)

      gw.dispatchRpc = async (endpoint, payload, signal, peer) => {
        const intercepted = await manager.workspaceBridge.interceptRpc(
          endpoint,
          payload,
          signal,
          peer,
          origDispatchRpc,
        )
        if (intercepted !== undefined) return intercepted
        return origDispatchRpc(endpoint, payload, signal, peer)
      }

      gw.openWireStream = async (endpoint, payload, uplink, peer, signal, control, uplinkWindow) => {
        const intercepted = manager.workspaceBridge.interceptStream(
          endpoint,
          payload,
          uplink,
          peer,
          signal,
          control,
          uplinkWindow,
          origOpenWireStream,
        )
        if (intercepted !== undefined) return await intercepted
        return origOpenWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
      }

      return () => {
        gw.dispatchRpc = origDispatchRpc
        gw.openWireStream = origOpenWireStream
        manager.workspaceBridge.detachHostControllers({ gateway: true, workspaceController: false, sessionController: false })
      }
    }, 'remote-ssh-connect: typertGateway federation')
  })

  ctx.inject(['workspaceController'], (scope) => {
    scope.effect(() => {
      const wsCtrl = unwrapCordisService(scope.workspaceController)
      manager.workspaceBridge.attachHostControllers({ workspaceController: wsCtrl })
      return () => {
        manager.workspaceBridge.detachHostControllers({ gateway: false, workspaceController: true, sessionController: false })
      }
    }, 'remote-ssh-connect: workspaceController federation')
  })

  ctx.inject(['sessionController'], (scope) => {
    scope.effect(() => {
      const sessCtrl = unwrapCordisService(scope.sessionController)
      manager.workspaceBridge.attachHostControllers({ sessionController: sessCtrl })
      return () => {
        manager.workspaceBridge.detachHostControllers({ gateway: false, workspaceController: false, sessionController: true })
      }
    }, 'remote-ssh-connect: sessionController federation')
  })

  // `connection/request` is a waterfall that client-connection runs only after `connection.admit(req)`
  // has accepted the request (Host/Origin fence plus browser auth cookie), so this proxy only ever
  // sees authenticated same-origin API requests. Requests for local sessions fall through to `next()`.
  ctx.inject(['connection'], (scope) => {
    if (typeof scope.on === 'function') {
      scope.effect(() => scope.on('connection/request', async (req, res, next) => {
        try {
          const handled = await manager.workspaceBridge.tryProxyRawHttpRequest(req, res)
          if (handled) return
        } catch {}
        return next()
      }), 'remote-ssh-connect: binary upload proxy')
    }
  })
}

const TOOL_NAME = 'remote_ssh_connect'

/** Actions that only read local or remote state; every other action needs a runtime user approval. */
const READ_ONLY_TOOL_ACTIONS = new Set([
  'list_hosts',
  'get_status',
  'list_local_plugins',
  'list_remote_workspaces',
  'list_synced_workspaces',
])

/**
 * Describe a side-effecting `remote_ssh_connect` call for the approval prompt.
 * Returns `null` for read-only actions, which run without approval.
 * @param {object} args - parsed tool arguments
 * @returns {{ reason: string, displayReason: { en: string, zh: string } } | null}
 */
export function describeToolApproval(args) {
  const action = typeof args?.action === 'string' ? args.action : ''
  if (READ_ONLY_TOOL_ACTIONS.has(action)) return null
  const host = typeof args?.host === 'string' && args.host ? args.host : '?'
  const port = Number.isInteger(args?.remotePort) ? String(args.remotePort) : 'configured'
  switch (action) {
    case 'kill_remote_port':
      return {
        reason: `remote_ssh_connect: terminate the process listening on remote port ${port} of host "${host}" (kill -TERM, then kill -KILL)`,
        displayReason: {
          en: `Terminate the process listening on port ${port} of remote host "${host}"`,
          zh: `终止远程主机“${host}”上占用端口 ${port} 的进程`,
        },
      }
    case 'sync_plugin': {
      const plugin = typeof args?.pluginName === 'string' ? args.pluginName : '?'
      const force = args?.force === true
      return {
        reason: `remote_ssh_connect: install local plugin "${plugin}" on host "${host}"${force ? ', overwriting a higher remote version' : ''}`,
        displayReason: force
          ? {
            en: `Install plugin "${plugin}" on remote host "${host}", overwriting its higher remote version`,
            zh: `将插件“${plugin}”安装到远程主机“${host}”，并覆盖远端更高的版本`,
          }
          : {
            en: `Install plugin "${plugin}" on remote host "${host}"`,
            zh: `将插件“${plugin}”安装到远程主机“${host}”`,
          },
      }
    }
    case 'configure_host':
      return {
        reason: `remote_ssh_connect: change saved connection settings of host "${host}"`,
        displayReason: {
          en: `Change the saved connection settings of remote host "${host}"`,
          zh: `修改远程主机“${host}”的连接配置`,
        },
      }
    case 'connect':
      return {
        reason: `remote_ssh_connect: open an SSH connection to "${host}" and install/start DSH on it`,
        displayReason: {
          en: `Connect to remote host "${host}" over SSH and install/start DSH there`,
          zh: `通过 SSH 连接远程主机“${host}”，并在其上安装/启动 DSH`,
        },
      }
    case 'disconnect':
      return {
        reason: `remote_ssh_connect: disconnect host "${host}" and stop its remote DSH`,
        displayReason: {
          en: `Disconnect remote host "${host}" and stop its remote DSH`,
          zh: `断开远程主机“${host}”并停止其远端 DSH`,
        },
      }
    case 'open_browser':
      return {
        reason: `remote_ssh_connect: open the remote DSH of host "${host}" in the default browser`,
        displayReason: {
          en: `Open the remote DSH of "${host}" in the default browser`,
          zh: `在默认浏览器中打开“${host}”的远端 DSH`,
        },
      }
    case 'sync_workspace':
      return {
        reason: `remote_ssh_connect: synchronize a remote workspace of host "${host}" into the local sidebar (may create the remote directory)`,
        displayReason: {
          en: `Synchronize a remote workspace of "${host}" into the local Workspaces list`,
          zh: `将“${host}”上的远程工作区同步到本地工作区列表`,
        },
      }
    case 'remove_workspace': {
      const id = typeof args?.localWorkspaceId === 'string' ? args.localWorkspaceId : '?'
      return {
        reason: `remote_ssh_connect: remove synchronized workspace "${id}" from the local sidebar`,
        displayReason: {
          en: `Remove synchronized workspace "${id}" from the local Workspaces list`,
          zh: `从本地工作区列表移除已同步的工作区“${id}”`,
        },
      }
    }
    default:
      return {
        reason: `remote_ssh_connect: run action "${action}"`,
        displayReason: {
          en: `Run remote SSH action "${action}"`,
          zh: `执行远程 SSH 操作“${action}”`,
        },
      }
  }
}

export function registerAgentTool(ctx, manager) {
  // Every side-effecting action asks the user through the DSH approval service before the tool body
  // runs. The ask fails closed: without an approval answerer (or with the `never` policy) it is denied.
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.on('tools/pre-execute', (exec, next) => {
      if (exec?.name !== TOOL_NAME) return next()
      const approval = describeToolApproval(exec.arguments)
      if (!approval) return next()
      return Promise.resolve({ kind: 'ask', ...approval })
    }), 'remote-ssh-connect: tool approval gate')
  })

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: TOOL_NAME,
      description: 'Manage SSH remote DSH connections configured in ~/.ssh/config: list hosts and their connection statuses, configure per-host remotePort/localPort/profile, connect or disconnect a host, open a connected remote DSH in the default browser, terminate a conflicting process occupying the remote port, sync a local plugin to a connected remote host, or list/sync/remove remote workspaces. Every action other than the list_*/get_status reads asks the user for approval before it runs. Interactive password/OTP entry remains user-only in the SSH Connections UI.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_hosts',
              'get_status',
              'configure_host',
              'connect',
              'disconnect',
              'open_browser',
              'kill_remote_port',
              'list_local_plugins',
              'sync_plugin',
              'list_remote_workspaces',
              'sync_workspace',
              'remove_workspace',
              'list_synced_workspaces',
            ],
            description: 'Operation to perform.',
          },
          host: {
            type: 'string',
            description: 'SSH host alias from ~/.ssh/config (required for host-specific actions).',
          },
          pluginName: {
            type: 'string',
            description: 'For sync_plugin: exact package name of the local plugin to synchronize to the remote host.',
          },
          force: {
            type: 'boolean',
            description: 'For sync_plugin: overwrite a higher remote plugin version. The approval prompt states the overwrite; set it only when the user asked for it.',
          },
          remoteWorkspaceId: {
            type: 'string',
            description: 'For sync_workspace: remote workspace ID from list_remote_workspaces.',
          },
          workspacePath: {
            type: 'string',
            description: 'For sync_workspace: remote directory path to create/adopt and synchronize.',
          },
          workspaceTitle: {
            type: 'string',
            description: 'For sync_workspace: optional display title for the synchronized remote workspace.',
          },
          localWorkspaceId: {
            type: 'string',
            description: 'For remove_workspace: local workspace ID (e.g. "remote:<host>:<remoteWorkspaceId>") to remove.',
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
          case 'list_local_plugins': {
            const res = await manager.listLocalPlugins()
            return JSON.stringify(res, null, 2)
          }
          case 'sync_plugin': {
            if (!args?.host) throw new Error('Parameter "host" is required for sync_plugin')
            if (!args?.pluginName) throw new Error('Parameter "pluginName" is required for sync_plugin')
            const res = await manager.syncPluginToHost(args.host, {
              pluginName: args.pluginName,
              force: args.force === true,
            })
            return JSON.stringify(res, null, 2)
          }
          case 'list_remote_workspaces': {
            if (!args?.host) throw new Error('Parameter "host" is required for list_remote_workspaces')
            const res = await manager.listRemoteWorkspaces(args.host)
            return JSON.stringify(res, null, 2)
          }
          case 'sync_workspace': {
            if (!args?.host) throw new Error('Parameter "host" is required for sync_workspace')
            if (!args?.remoteWorkspaceId && !args?.workspacePath) {
              throw new Error('Parameter "remoteWorkspaceId" or "workspacePath" is required for sync_workspace')
            }
            const res = await manager.syncRemoteWorkspace(args.host, {
              remoteWorkspaceId: args.remoteWorkspaceId,
              path: args.workspacePath,
              title: args.workspaceTitle,
            })
            return JSON.stringify(res, null, 2)
          }
          case 'remove_workspace': {
            if (!args?.localWorkspaceId) throw new Error('Parameter "localWorkspaceId" is required for remove_workspace')
            const res = await manager.removeSyncedWorkspace(args.localWorkspaceId)
            return JSON.stringify(res, null, 2)
          }
          case 'list_synced_workspaces': {
            const res = manager.listSyncedWorkspaces()
            return JSON.stringify(res, null, 2)
          }
          default:
            throw new Error(`Unknown action: ${String(action)}`)
        }
      },
    }), 'remote-ssh-connect: tool')
  })
}

export function apply(ctx, config = {}) {
  let hostConfigsTable
  let remoteWorkspacesTable

  const manager = new RemoteConnectionManager({
    ...config,
    onSaveConfig: async (host, hostCfg) => {
      if (hostConfigsTable !== undefined) {
        await hostConfigsTable.put(host, hostCfg)
      }
    },
    onSaveWorkspace: async (localWorkspaceId, record) => {
      if (remoteWorkspacesTable !== undefined) {
        if (record === null || record === undefined) {
          await remoteWorkspacesTable.delete(localWorkspaceId)
        } else {
          await remoteWorkspacesTable.put(localWorkspaceId, record)
        }
      }
    },
    onSaveWorkspaceOrder: async (workspaceOrder) => {
      if (hostConfigsTable !== undefined && Array.isArray(workspaceOrder)) {
        await hostConfigsTable.put('__workspace_order__', normalizeHostConfig({ workspaceOrder }))
      }
    },
  })

  ctx.effect(() => {
    let disposed = false
    const ready = manager.init()
    return async () => {
      disposed = true
      await ready.catch(() => {})
      await manager.dispose()
    }
  }, 'remote-ssh-connect: lifecycle')

  ctx.inject(['storageDomain'], (scope) => {
    scope.effect(() => {
      let domain
      let disposed = false
      const ready = (async () => {
        try {
          domain = await scope.storageDomain.open(domainSpec)
          if (disposed) {
            await domain.close()
            return
          }
          hostConfigsTable = domain.table('host_configs')
          for (const [hostKey, record] of hostConfigsTable.entries()) {
            if (hostKey === '__workspace_order__') {
              if (Array.isArray(record?.workspaceOrder)) {
                manager.workspaceBridge.loadInitialWorkspaceOrder(record.workspaceOrder)
              }
              continue
            }
            if (!manager.hostConfigs.has(hostKey)) {
              manager.hostConfigs.set(hostKey, normalizeHostConfig(record))
            }
          }
          remoteWorkspacesTable = domain.table('remote_workspaces')
          manager.workspaceBridge.loadInitialWorkspaces(remoteWorkspacesTable.entries())
          manager.workspaceBridge.publishAllSyncedWorkspacesToLiveFollowers()
        } catch (err) {
          scope.logger?.warn?.('remote-ssh-connect: storageDomain open failed, using in-memory config', err)
        }
      })()

      return async () => {
        disposed = true
        hostConfigsTable = undefined
        remoteWorkspacesTable = undefined
        await ready.catch(() => {})
        if (domain !== undefined) {
          await domain.close().catch(() => {})
        }
      }
    }, 'remote-ssh-connect: storage')
  })

  registerGatewayFederation(ctx, manager)

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
  registerRoute(ctx, 'local-plugins', () => manager.listLocalPlugins())
  registerRoute(ctx, 'sync-plugin', (body) => manager.syncPluginToHost(body.host, {
    pluginName: body.pluginName,
    force: Boolean(body.force),
  }))
  registerRoute(ctx, 'remote-workspaces', (body) => manager.listRemoteWorkspaces(body.host))
  registerRoute(ctx, 'sync-workspace', (body) => manager.syncRemoteWorkspace(body.host, {
    remoteWorkspaceId: body.remoteWorkspaceId,
    path: body.path,
    title: body.title,
  }))
  registerRoute(ctx, 'remove-workspace', (body) => manager.removeSyncedWorkspace(
    body.localWorkspaceId ?? body.workspaceId,
  ))
  registerRoute(ctx, 'ack-invalid-workspace', (body) => manager.removeSyncedWorkspace(
    body.localWorkspaceId ?? body.workspaceId,
  ))
  registerRoute(ctx, 'synced-workspaces', () => manager.listSyncedWorkspaces())
  registerRoute(ctx, 'compare-plugins', (body) => manager.compareHostPlugins(body.host))
  registerRoute(ctx, 'model-catalog', (body) => manager.getRemoteModelCatalog(body))
  registerRoute(ctx, 'session-host', (body) => manager.getSessionHost(body.sessionId))
  registerRoute(ctx, 'auth-submit', (body) => manager.submitAuth(body.host, {
    promptId: body.promptId,
    value: body.value,
  }))
  registerRoute(ctx, 'auth-cancel', (body) => manager.cancelAuth(body.host, {
    promptId: body.promptId,
  }))

  registerAgentTool(ctx, manager)

  return manager
}

export {
  RemoteConnectionManager,
  RemoteWorkspaceBridge,
  makeLocalWorkspaceId,
  normalizeHostConfig,
  normalizeSyncedWorkspaceRecord,
  parseLocalWorkspaceId,
  resolveLocalDshVersion,
  acquireLocalPort,
  validateHostAlias,
  validateHostConfigInput,
} from './src/connection-manager.js'
export {
  MinimalWsClient,
  RemoteHostGatewayClient,
  REMOTE_WS_PREFIX,
  extractSessionIdFromArgs,
  normalizeProjectionFrame,
  createRemoteGatewayError,
} from './src/remote-workspace-bridge.js'
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
  NODE_TARBALL_SHA256,
} from './src/remote-script.js'
export {
  openUrlInDefaultBrowser,
} from './src/browser-opener.js'
export {
  comparePluginVersions,
  classifyInstallSource,
  listLocalPlugins,
  packLocalPluginDirectory,
} from './src/plugin-sync.js'
