// Client half of dsh-remote-ssh-connect:
// 1. Registers "SSH connect" in the left navigation sidebar and renders the SSH Management Panel.
// 2. Supports listing and synchronizing remote workspaces directly into the built-in DSH Workspaces list,
//    allowing free drag-and-drop mixed ordering of local and remote workspaces and rendering a VS Code-style
//    remote corner badge on remote workspace folder icons.
// 3. Synchronizes each remote workspace's selectable model catalog from its connected remote host.
// 4. Provides collapsible Local & remote plugin difference hints with long-term persisted collapse/expand state,
//    and an inline eye icon toggle on the SSH password/secret authentication input.
// Uses only official --dsw-alias-* theme tokens and React (no private primitive imports).

window.__ModuleLoader__.load({
  id: 'dsh-remote-ssh-connect',
  factory(require) {
    const React = require('react')
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {}
    const h = React.createElement

    const NS = 'dshRemoteSshConnect'
    const PANEL_ID = 'remote-ssh-connect'
    const REMOTE_WS_PREFIX = 'remote:'
    const CORDIS_ORIGINAL = Symbol.for('cordis.original')
    const COLLAPSED_DIFF_STORAGE_KEY = 'dsh.remoteSshConnect.collapsedPluginDiffs.v1'

    function unwrapCordisService(svc) {
      if (!svc || typeof svc !== 'object') return svc
      try {
        const orig = svc[CORDIS_ORIGINAL]
        if (orig && typeof orig === 'object' && orig !== svc) return orig
      } catch {}
      return svc
    }

    function parseLocalWorkspaceId(workspaceId) {
      if (typeof workspaceId !== 'string' || !workspaceId.startsWith(REMOTE_WS_PREFIX)) {
        return null
      }
      const rest = workspaceId.slice(REMOTE_WS_PREFIX.length)
      const idx = rest.indexOf(':')
      if (idx <= 0 || idx === rest.length - 1) return null
      return {
        host: rest.slice(0, idx),
        remoteWorkspaceId: rest.slice(idx + 1),
      }
    }

    function loadPersistedCollapsedDiffs() {
      const map = new Map()
      try {
        const raw = typeof localStorage !== 'undefined'
          ? localStorage.getItem(COLLAPSED_DIFF_STORAGE_KEY)
          : null
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'boolean') map.set(k, v)
            }
          }
        }
      } catch {}
      return map
    }

    function savePersistedCollapsedDiffs(map) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(COLLAPSED_DIFF_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)))
        }
      } catch {}
    }

    const zh = {
      _lang: 'zh',
      panel: 'SSH 连接',
      title: 'SSH 远端连接管理',
      subtitle: '管理 ~/.ssh/config 中的 Linux 主机，通过 SSH 自动部署同版本 DSH、同步本地插件与远程工作区',
      refresh: '刷新列表',
      dshVersionBadge: '目标 DSH 版本：{version}',
      summaryCounts: '共 {total} 台主机 · {connected} 台已连接',
      loading: '正在读取 ~/.ssh/config 主机列表…',
      loadError: '读取主机列表失败：{message}',
      retry: '重试',
      emptyNoConfig: '未找到 ~/.ssh/config 配置文件。请先在 ~/.ssh/config 中添加需要连接的 Linux 主机（排除通配符主机）。',
      emptyNoHosts: '~/.ssh/config 中未解析到具体主机（通配符如 * 已自动排除）。',

      statusConnected: '已连接',
      statusConnecting: '连接中',
      statusDisconnecting: '正在断开',
      statusDisconnected: '未连接',
      statusError: '连接异常',

      phase_connecting_ssh: '正在建立 SSH 连接…',
      phase_awaiting_auth: '等待输入密码 / OTP 认证信息…',
      phase_checking_port: '正在检查远端端口占用情况…',
      phase_checking_node: '正在检查远端 Node.js 与 npm 环境…',
      phase_installing_node: '正在安装 Node.js 到 ~/.dsh-remote-ssh-connect/node…',
      phase_checking_dsh: '正在检查远端 ~/.dsh-remote-ssh-connect/{version}…',
      phase_installing_dsh: '正在安装 DSH {version} 到 ~/.dsh-remote-ssh-connect/{version}…',
      phase_starting_dsh: '正在启动远端 DSH 服务…',
      phase_ready: '远端 DSH 运行中',

      btnConnect: '连接',
      btnDisconnect: '断开连接',
      btnCancelConnect: '取消连接',
      btnOpenRemoteDsh: '打开远端 DSH',
      btnSettings: '连接配置',
      btnHideSettings: '收起配置',
      btnSaveConfig: '保存配置',
      btnSavingConfig: '保存中…',
      configSavedNotice: '配置已保存（从下次连接起生效）',
      btnEnterAuth: '输入认证信息',

      fieldRemotePort: '远端 DSH 端口',
      fieldRemotePortHint: '默认 3080，修改后从下次连接起生效',
      fieldLocalPort: '本地映射端口',
      fieldLocalPortHint: '填 0 表示自动分配空闲端口，也可填写固定端口',
      fieldProfile: '启动 Profile',
      fieldProfileHint: '默认 web；若指定远端不存在的自定义名称，将自动用 --from-default-profile web 初始化',

      tunnelLabel: '端口映射',
      tunnelValue: '本地 127.0.0.1:{localPort} → 远端 127.0.0.1:{remotePort}',
      activeProfileLabel: '当前 Profile',
      activeProfileInitTag: '已从 web 模板自动初始化',
      remoteUrlLabel: '本地访问地址',
      btnCopyUrl: '复制链接',
      urlCopied: '已复制',
      nextConfigNotice: '已修改下次连接配置：远端端口 {remotePort} / 本地端口 {localPort} / Profile {profile}',

      syncPluginLabel: '同步本地插件',
      syncPluginPlaceholder: '选择要同步到远端的本地插件…',
      syncPluginNoLocal: '当前本地 Profile 暂无可同步的第三方或本地插件',
      sourceKind_npm: 'npm 源',
      sourceKind_github: 'GitHub 源',
      sourceKind_local: '本地源',
      btnSyncPlugin: '同步安装到远端',
      btnSyncingPlugin: '正在同步安装…',
      syncSuccessFresh: '已通过 {source} 将插件 {name} (v{version}) 同步安装到远端（Profile: {profile}）',
      syncSuccessReinstalled: '已删除远端原有版本并重新通过 {source} 安装插件 {name} (v{version})',

      syncWorkspaceLabel: '远程工作区',
      syncWorkspaceLoading: '正在读取远端工作区列表…',
      syncWorkspaceEmpty: '远端暂无已创建的工作区',
      syncWorkspaceOptionFmt: '{title} ({path} · {count} 个会话){syncedTag}',
      syncWorkspaceSyncedTag: ' [已同步]',
      btnSyncWorkspace: '同步到本地',
      btnSyncingWorkspace: '正在同步…',
      btnRefreshWorkspaces: '刷新工作区',
      wsSyncedNotice: '已将远程工作区「{title}」同步至左侧导航栏 Workspaces',

      pluginDiffTitle: '本地与远端插件差异提示',
      pluginDiffMissingOnRemote: '以下本地插件尚未安装到远端（如需在远程会话中使用其后台工具，可一键同步）：',
      pluginDiffMissingOnLocal: '远端已安装以下本地未安装的插件（后台工具会自动回退为通用卡片展示；若需其专属定制 UI 可在浏览器打开远端原生界面）：',
      btnSyncDiffPlugin: '同步 {name}',
      btnCollapseDiff: '收起',
      btnExpandDiff: '展开',

      remoteWorkspacesSection: '远程工作区',
      sidebarConnectHost: '连接主机',
      sidebarConnectingHost: '连接中…',
      sidebarConnectHostTooltip: '连接远程主机 {host} 以查看并操作此远程工作区下的会话',
      sidebarNewSessionTooltip: '在“{name}”中新建会话',
      sidebarWorkspaceActionsTooltip: '工作区“{name}”的操作',
      sidebarSessionActionsTooltip: '会话“{name}”的操作',
      sidebarNewSessionTitle: '新会话',
      sidebarUntitledSession: '未命名',
      sidebarShowMoreSessions: '展开其余 {n} 个会话',
      sidebarShowLessSessions: '收起',
      menuConnectHost: '连接远程主机 ({host})',
      menuDisconnectHost: '断开远程主机 ({host})',
      menuOpenRemoteNative: '在浏览器打开远端原生 DSH ({host})',
      menuRenameWorkspace: '重命名工作区',
      menuRemoveWorkspace: '移除远程工作区',
      menuRenameSession: '重命名会话',
      menuPinSession: '置顶会话',
      menuUnpinSession: '取消置顶',
      menuForkSession: '分叉会话',
      menuArchiveSession: '归档会话',
      menuCopySessionId: '复制 Session ID',
      headerRemoteBadge: '远端: {host}',
      headerOpenRemoteNative: '远端原生界面',

      timeNow: '刚刚',
      timeMinutes: '{n}分钟',
      timeHours: '{n}小时',
      timeDays: '{n}天',

      invalidWsModalTitle: '远程工作区已失效',
      invalidWsModalDesc: '远端主机 {host} 上的工作区「{title}」（路径：{path}）已被删除或不存在。确认后将从本地导航栏移除此远程工作区。',
      invalidWsHostLabel: '所属远端主机',
      invalidWsPathLabel: '远端工作区路径',
      btnConfirmRemoveInvalidWs: '确认删除',
      btnRemovingInvalidWs: '正在删除…',

      overwriteModalTitle: '远端插件版本更高 — 确认覆盖安装？',
      overwriteModalDesc: '远端主机 {host}（Profile: {profile}）上已安装插件 {name}，且远端版本（v{remoteVersion}）高于本地版本（v{localVersion}）。确认继续将删除远端已有插件并重新安装本地版本（v{localVersion}）。',
      overwriteRemoteVerLabel: '远端已安装版本',
      overwriteLocalVerLabel: '本地待同步版本',
      overwriteSourceLabel: '同步安装方式',
      btnConfirmOverwrite: '确认删除并重装',
      btnConfirmingOverwrite: '正在重装…',
      btnCancelOverwrite: '取消',

      portConflictTitle: '远端端口 {port} 已被占用',
      portConflictDescWithProcess: '检测到远端主机端口 {port} 已被占用（进程 PID {pid}{cmd}）。为避免破坏已有服务，插件未自动绕过，请选择以下任一处理方式：',
      portConflictDescGeneric: '检测到远端主机端口 {port} 已被占用（可能已有正在运行的 DSH 或其他服务）。请选择终止占用该端口的程序，或更换其他远端端口：',
      btnKillOccupantAndReconnect: '终止占用进程并重连',
      btnKillingOccupant: '正在终止占用进程…',
      quickPortLabel: '快捷更换远端端口：',
      btnChangePortAndReconnect: '更换端口并重连',
      btnChangePortOnly: '仅保存新端口',

      localPortConflictTitle: '本地端口 {port} 已被占用',
      localPortConflictDesc: '本地端口 {port} 无法绑定。请改为 0（自动分配空闲端口）或更换其他本地端口后重试。',
      btnAutoLocalPortAndReconnect: '改为自动分配 (0) 并重连',

      authModalTitle: 'SSH 身份认证 — {host}',
      authModalDesc: '远端主机要求交互式认证，请输入对应信息以继续连接。',
      authPromptLabel: '认证提示',
      authInputPlaceholderPassword: '请输入密码',
      authInputPlaceholderOtp: '请输入 OTP 动态口令 / 验证码',
      authInputPlaceholderPassphrase: '请输入私钥口令 (Passphrase)',
      authInputPlaceholderConfirm: '请输入 yes 或 no',
      authInputPlaceholderGeneric: '请输入认证信息',
      authShowSecret: '显示输入内容',
      authHideSecret: '隐藏输入内容',
      btnAuthSubmit: '确认提交',
      btnAuthCancel: '取消',
    }

    const en = {
      _lang: 'en',
      panel: 'SSH connect',
      title: 'Remote SSH connections',
      subtitle: 'Manage Linux hosts from ~/.ssh/config, provision matching DSH versions over SSH, sync local plugins, and synchronize remote workspaces',
      refresh: 'Refresh',
      dshVersionBadge: 'Target DSH: {version}',
      summaryCounts: '{total} hosts · {connected} connected',
      loading: 'Loading hosts from ~/.ssh/config…',
      loadError: 'Failed to load hosts: {message}',
      retry: 'Retry',
      emptyNoConfig: 'No ~/.ssh/config file was found. Add your remote Linux hosts to ~/.ssh/config to get started (wildcard entries are excluded).',
      emptyNoHosts: 'No concrete host entries found in ~/.ssh/config (wildcard entries such as * are excluded).',

      statusConnected: 'Connected',
      statusConnecting: 'Connecting',
      statusDisconnecting: 'Disconnecting',
      statusDisconnected: 'Disconnected',
      statusError: 'Error',

      phase_connecting_ssh: 'Establishing SSH connection…',
      phase_awaiting_auth: 'Waiting for password / OTP authentication…',
      phase_checking_port: 'Checking remote port availability…',
      phase_checking_node: 'Checking remote Node.js and npm…',
      phase_installing_node: 'Installing Node.js into ~/.dsh-remote-ssh-connect/node…',
      phase_checking_dsh: 'Checking ~/.dsh-remote-ssh-connect/{version}…',
      phase_installing_dsh: 'Installing DSH {version} into ~/.dsh-remote-ssh-connect/{version}…',
      phase_starting_dsh: 'Starting remote DSH service…',
      phase_ready: 'Remote DSH is running',

      btnConnect: 'Connect',
      btnDisconnect: 'Disconnect',
      btnCancelConnect: 'Cancel',
      btnOpenRemoteDsh: 'Open remote DSH',
      btnSettings: 'Settings',
      btnHideSettings: 'Hide settings',
      btnSaveConfig: 'Save settings',
      btnSavingConfig: 'Saving…',
      configSavedNotice: 'Settings saved (effective from next connection)',
      btnEnterAuth: 'Enter credentials',

      fieldRemotePort: 'Remote DSH port',
      fieldRemotePortHint: 'Default 3080; changes take effect on the next connection',
      fieldLocalPort: 'Local forwarded port',
      fieldLocalPortHint: 'Enter 0 to auto-allocate a free port, or specify a fixed port',
      fieldProfile: 'Launch profile',
      fieldProfileHint: 'Default web; non-existent custom profiles are initialized with --from-default-profile web',

      tunnelLabel: 'Port forwarding',
      tunnelValue: 'Local 127.0.0.1:{localPort} → Remote 127.0.0.1:{remotePort}',
      activeProfileLabel: 'Active profile',
      activeProfileInitTag: 'Initialized from web template',
      remoteUrlLabel: 'Local mapped URL',
      btnCopyUrl: 'Copy URL',
      urlCopied: 'Copied',
      nextConfigNotice: 'Next connection settings: remote port {remotePort} / local port {localPort} / profile {profile}',

      syncPluginLabel: 'Sync local plugin',
      syncPluginPlaceholder: 'Select a local plugin to sync…',
      syncPluginNoLocal: 'No user-installed local plugins found in the current profile',
      sourceKind_npm: 'npm source',
      sourceKind_github: 'GitHub source',
      sourceKind_local: 'Local source',
      btnSyncPlugin: 'Sync to remote',
      btnSyncingPlugin: 'Syncing…',
      syncSuccessFresh: 'Synced and installed {name} (v{version}) via {source} on remote profile "{profile}"',
      syncSuccessReinstalled: 'Removed existing remote copy and reinstalled {name} (v{version}) via {source}',

      syncWorkspaceLabel: 'Remote workspace',
      syncWorkspaceLoading: 'Loading remote workspaces…',
      syncWorkspaceEmpty: 'No workspaces found on remote host',
      syncWorkspaceOptionFmt: '{title} ({path} · {count} sessions){syncedTag}',
      syncWorkspaceSyncedTag: ' [Synced]',
      btnSyncWorkspace: 'Sync to local',
      btnSyncingWorkspace: 'Syncing…',
      btnRefreshWorkspaces: 'Refresh',
      wsSyncedNotice: 'Synchronized remote workspace "{title}" to Workspaces in the left sidebar',

      pluginDiffTitle: 'Local & remote plugin differences',
      pluginDiffMissingOnRemote: 'Local plugins not installed on remote (sync them if your remote sessions need their tools):',
      pluginDiffMissingOnLocal: 'Remote plugins not installed locally (backend tools still run on remote with generic card fallback; open remote native DSH if custom UI is needed):',
      btnSyncDiffPlugin: 'Sync {name}',
      btnCollapseDiff: 'Collapse',
      btnExpandDiff: 'Expand',

      remoteWorkspacesSection: 'Remote Workspaces',
      sidebarConnectHost: 'Connect host',
      sidebarConnectingHost: 'Connecting…',
      sidebarConnectHostTooltip: 'Connect to remote host "{host}" to view and control sessions in this workspace',
      sidebarNewSessionTooltip: 'New session in {name}',
      sidebarWorkspaceActionsTooltip: 'Workspace actions for {name}',
      sidebarSessionActionsTooltip: 'Session actions for {name}',
      sidebarNewSessionTitle: 'New Session',
      sidebarUntitledSession: 'Untitled',
      sidebarShowMoreSessions: 'Show {n} more sessions',
      sidebarShowLessSessions: 'Show less',
      menuConnectHost: 'Connect remote host ({host})',
      menuDisconnectHost: 'Disconnect remote host ({host})',
      menuOpenRemoteNative: 'Open remote native DSH in browser ({host})',
      menuRenameWorkspace: 'Rename workspace',
      menuRemoveWorkspace: 'Remove remote workspace',
      menuRenameSession: 'Rename session',
      menuPinSession: 'Pin session',
      menuUnpinSession: 'Unpin session',
      menuForkSession: 'Fork session',
      menuArchiveSession: 'Archive session',
      menuCopySessionId: 'Copy Session ID',
      headerRemoteBadge: 'Remote: {host}',
      headerOpenRemoteNative: 'Remote native UI',

      timeNow: 'now',
      timeMinutes: '{n}min',
      timeHours: '{n}h',
      timeDays: '{n}d',

      invalidWsModalTitle: 'Remote workspace is no longer valid',
      invalidWsModalDesc: 'The workspace "{title}" ({path}) on remote host "{host}" has been deleted on the remote machine. Confirm to remove this remote workspace from your local sidebar.',
      invalidWsHostLabel: 'Remote host',
      invalidWsPathLabel: 'Remote path',
      btnConfirmRemoveInvalidWs: 'Confirm & remove',
      btnRemovingInvalidWs: 'Removing…',

      overwriteModalTitle: 'Remote plugin version is newer — confirm reinstall?',
      overwriteModalDesc: 'Host "{host}" (profile: "{profile}") already has "{name}" installed at version v{remoteVersion}, which is newer than your local version (v{localVersion}). Proceeding will remove the remote copy and reinstall v{localVersion}.',
      overwriteRemoteVerLabel: 'Installed on remote',
      overwriteLocalVerLabel: 'Local version to install',
      overwriteSourceLabel: 'Install method',
      btnConfirmOverwrite: 'Delete & reinstall',
      btnConfirmingOverwrite: 'Reinstalling…',
      btnCancelOverwrite: 'Cancel',

      portConflictTitle: 'Remote port {port} is already in use',
      portConflictDescWithProcess: 'Remote port {port} is already occupied (PID {pid}{cmd}). Choose how to resolve this conflict:',
      portConflictDescGeneric: 'Remote port {port} is already in use on the remote host (an existing DSH or another service may be running). Terminate the occupying process or choose another port:',
      btnKillOccupantAndReconnect: 'Terminate process & reconnect',
      btnKillingOccupant: 'Terminating process…',
      quickPortLabel: 'Quickly change remote port:',
      btnChangePortAndReconnect: 'Change port & reconnect',
      btnChangePortOnly: 'Save port only',

      localPortConflictTitle: 'Local port {port} is already in use',
      localPortConflictDesc: 'Local port {port} could not be bound. Switch to 0 (auto-allocate) or pick another local port.',
      btnAutoLocalPortAndReconnect: 'Use auto port (0) & reconnect',

      authModalTitle: 'SSH authentication — {host}',
      authModalDesc: 'The remote host requested interactive authentication. Enter your credentials to continue.',
      authPromptLabel: 'Server prompt',
      authInputPlaceholderPassword: 'Enter password',
      authInputPlaceholderOtp: 'Enter OTP / verification code',
      authInputPlaceholderPassphrase: 'Enter key passphrase',
      authInputPlaceholderConfirm: 'Enter yes or no',
      authInputPlaceholderGeneric: 'Enter response',
      authShowSecret: 'Show input',
      authHideSecret: 'Hide input',
      btnAuthSubmit: 'Submit',
      btnAuthCancel: 'Cancel',
    }

    const GLOBAL_SIDEBAR_CSS = `
/* VS Code remote-explorer style circular corner badge on remote workspace folder icons */
[data-row-key^="workspace:remote:"] > span:first-child {
  position: relative;
}
[data-row-key^="workspace:remote:"] > span:first-child::before {
  content: "";
  position: absolute;
  right: -2px;
  bottom: 0.5px;
  width: 9.5px;
  height: 9.5px;
  border-radius: 50%;
  background-color: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
  pointer-events: none;
  z-index: 1;
}
[data-row-key^="workspace:remote:"]:hover > span:first-child::before {
  background-color: var(--dsw-alias-interactive-bg-hover);
}
[data-row-key^="workspace:remote:"] > span:first-child::after {
  content: "";
  position: absolute;
  right: -1.5px;
  bottom: 1px;
  width: 8.5px;
  height: 8.5px;
  background-color: currentColor;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Ccircle cx='8' cy='8' r='6.75' stroke='black' stroke-width='1.45'/%3E%3Cpath d='M4.7 7.1L7.2 9.5L4.7 11.9' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M11.3 4.1L8.8 6.5L11.3 8.9' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Ccircle cx='8' cy='8' r='6.75' stroke='black' stroke-width='1.45'/%3E%3Cpath d='M4.7 7.1L7.2 9.5L4.7 11.9' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M11.3 4.1L8.8 6.5L11.3 8.9' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  -webkit-mask-size: 8.5px 8.5px;
  mask-size: 8.5px 8.5px;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  pointer-events: none;
  z-index: 2;
}

/* Display the remote host alias as a visual suffix on the sidebar row without polluting the underlying workspace title */
[data-row-key^="workspace:remote:"] [data-rc-host-label]::after {
  content: " (" attr(data-rc-host-label) ")";
}

/* When a remote workspace's host is disconnected, keep the folder icon visible on hover (no sessions to expand) */
[data-row-key^="workspace:remote:"][data-rc-status="disconnected"]:hover > span:first-child,
[data-row-key^="workspace:remote:"][data-rc-status="connecting"]:hover > span:first-child,
[data-row-key^="workspace:remote:"][data-rc-status="error"]:hover > span:first-child {
  display: inline-flex !important;
}
[data-row-key^="workspace:remote:"][data-rc-status="disconnected"]:hover > span:nth-child(2),
[data-row-key^="workspace:remote:"][data-rc-status="connecting"]:hover > span:nth-child(2),
[data-row-key^="workspace:remote:"][data-rc-status="error"]:hover > span:nth-child(2) {
  display: none !important;
}

/* Hide the built-in New Session button on disconnected remote workspaces and show the Connect Host button instead */
[data-row-key^="workspace:remote:"]:not([data-rc-status="connected"]) > span:last-child > *:not(:first-child):not(.dsh-rc-inline-connect-btn) {
  display: none !important;
}
.dsh-rc-inline-connect-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsh-rc-inline-connect-btn:hover:not(:disabled) {
  background-color: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-brand-primary);
}
.dsh-rc-inline-connect-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.dsh-rc-header-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  text-decoration: none;
  cursor: pointer;
}
.dsh-rc-header-pill:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
`

    const PAGE_CSS = `
.dsh-rc-page {
  --rc-inset: clamp(20px, 4vw, 44px);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  width: 100%;
  padding: 0 var(--rc-inset);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  overflow-y: auto;
}
.dsh-rc-container {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 28px 0 48px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.dsh-rc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.dsh-rc-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-rc-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dsh-rc-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  text-decoration: none;
  box-sizing: border-box;
  white-space: nowrap;
}
.dsh-rc-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-rc-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.dsh-rc-btn-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
.dsh-rc-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary);
  opacity: 0.9;
}
.dsh-rc-btn-danger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  background: transparent;
}
.dsh-rc-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-rc-btn-sm {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 6px;
}
.dsh-rc-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-rc-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-rc-card[data-status="connected"] {
  border-color: var(--dsw-alias-state-success-primary);
}
.dsh-rc-card[data-status="error"] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-rc-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-rc-host-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.dsh-rc-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-state-idle-primary);
}
.dsh-rc-dot[data-status="connected"] {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-rc-dot[data-status="connecting"],
.dsh-rc-dot[data-status="disconnecting"] {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-rc-dot[data-status="error"] {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-rc-host-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dsh-rc-host-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-rc-host-alias {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-status-pill {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-status-pill[data-status="connected"] {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.dsh-rc-status-pill[data-status="connecting"] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
}
.dsh-rc-status-pill[data-status="error"] {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-rc-host-target {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  font-family: monospace;
}
.dsh-rc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-rc-connected-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 12.5px;
}
.dsh-rc-kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-rc-kv-label {
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-kv-val {
  color: var(--dsw-alias-label-primary);
  font-family: monospace;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  word-break: break-all;
}
.dsh-rc-sync-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-rc-sync-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  justify-content: flex-end;
}
.dsh-rc-select {
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  min-width: 220px;
  max-width: 100%;
  box-sizing: border-box;
}
.dsh-rc-select:focus {
  outline: 1.5px solid var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-rc-diff-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
}
.dsh-rc-diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-diff-header-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
  user-select: none;
}
.dsh-rc-diff-count {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-diff-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-rc-diff-chevron {
  transition: transform 0.15s ease;
}
.dsh-rc-diff-chevron[data-collapsed="true"] {
  transform: rotate(-90deg);
}
.dsh-rc-diff-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-diff-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-rc-url-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: underline;
  font-family: monospace;
  word-break: break-all;
}
.dsh-rc-progress-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-log-line {
  font-family: monospace;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-rc-conflict-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-conflict-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-rc-conflict-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-conflict-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 4px;
}
.dsh-rc-quick-port-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-rc-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-rc-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}
.dsh-rc-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dsh-rc-field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-rc-field-hint {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-input {
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  box-sizing: border-box;
}
.dsh-rc-input:focus {
  outline: 1.5px solid var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-rc-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}
.dsh-rc-input-wrap .dsh-rc-input {
  width: 100%;
}
.dsh-rc-input-wrap[data-has-toggle="true"] .dsh-rc-input {
  padding-right: 34px;
}
.dsh-rc-eye-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.dsh-rc-eye-btn:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rc-settings-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-rc-notice {
  font-size: 12px;
  color: var(--dsw-alias-state-success-primary);
}
.dsh-rc-error-inline {
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-rc-empty {
  padding: 36px 24px;
  text-align: center;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px dashed var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 13.5px;
  line-height: 1.6;
}
.dsh-rc-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.48);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.dsh-rc-modal {
  width: 100%;
  max-width: 460px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2);
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary);
  box-sizing: border-box;
}
.dsh-rc-modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.dsh-rc-modal-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rc-prompt-box {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  font-family: monospace;
  font-size: 12.5px;
  word-break: break-word;
}
.dsh-rc-modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
`

    async function callHost(op, payload) {
      const response = await fetch(new URL(`api/remote-ssh-connect/${op}`, document.baseURI).href, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      let json
      try {
        json = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!json || json.ok !== true) {
        throw new Error(json?.error ?? `HTTP ${response.status}`)
      }
      return json.value
    }

    function SshPanelIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('rect', {
        x: 2.2,
        y: 3,
        width: 15.6,
        height: 11,
        rx: 2.2,
        stroke: 'currentColor',
        strokeWidth: 1.5,
      }),
      h('path', {
        d: 'M5.5 6.8L8 8.5L5.5 10.2',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('line', {
        x1: 9.2,
        y1: 10.2,
        x2: 12.8,
        y2: 10.2,
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M6.5 17H13.5M10 14V17',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }))
    }

    function FolderCloseIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M3.63501 7.66614H12.3647',
        stroke: 'currentColor',
      }))
    }

    function FolderOpenIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z',
        fill: 'currentColor',
        opacity: '0.16',
      }),
      h('path', {
        d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z',
        fill: 'currentColor',
      }))
    }

    function TriangleRightIcon({ size = 14, open = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        className: 'dsh-rc-rw-arrow',
        'data-open': open ? 'true' : 'false',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z',
        fill: 'currentColor',
      }))
    }

    function NewChatIcon({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M8 5V11',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M5 8H11',
        stroke: 'currentColor',
      }))
    }

    function MoreHorizontalIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z',
        fill: 'currentColor',
      }))
    }

    function PinSmallIcon({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        strokeWidth: 1,
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z',
        fill: 'currentColor',
        stroke: 'currentColor',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z',
        fill: 'currentColor',
      }))
    }

    function ConnectLinkIcon({ size = 11 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M6.5 9.5L9.5 6.5M5 7L3.5 8.5C2.4 9.6 2.4 11.4 3.5 12.5C4.6 13.6 6.4 13.6 7.5 12.5L9 11M11 9L12.5 7.5C13.6 6.4 13.6 4.6 12.5 3.5C11.4 2.4 9.6 2.4 8.5 3.5L7 5',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }))
    }

    function DisconnectIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M5 7L3.5 8.5C2.4 9.6 2.4 11.4 3.5 12.5C4.6 13.6 6.4 13.6 7.5 12.5L9 11M11 9L12.5 7.5C13.6 6.4 13.6 4.6 12.5 3.5C11.4 2.4 9.6 2.4 8.5 3.5L7 5M2.5 2.5L13.5 13.5',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
      }))
    }

    function ExternalBrowserIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M9.5 2.5H13.5V6.5M13.2 2.8L7.5 8.5M7 3.5H4C3.17 3.5 2.5 4.17 2.5 5V12C2.5 12.83 3.17 13.5 4 13.5H11C11.83 13.5 12.5 12.83 12.5 12V9',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * Open eye icon shown when the password/secret input is visible.
     */
    function EyeOpenIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('circle', {
        cx: 8,
        cy: 8,
        r: 2,
        stroke: 'currentColor',
        strokeWidth: 1.35,
      }))
    }

    /**
     * Closed eye icon shown when the password/secret input is hidden.
     */
    function EyeClosedIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2 6.8C3.5 9.5 5.6 10.8 8 10.8C10.4 10.8 12.5 9.5 14 6.8',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M4.6 9.5L3.4 11.6M8 10.8V13.1M11.4 9.5L12.6 11.6',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function ChevronDownIcon({ size = 12, collapsed = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 12 12',
        fill: 'none',
        className: 'dsh-rc-diff-chevron',
        'data-collapsed': collapsed ? 'true' : 'false',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.5 4.25L6 7.75L9.5 4.25',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function formatRelativeTime(updatedAtMs, nowMs, t) {
      if (!updatedAtMs || !Number.isFinite(updatedAtMs)) return ''
      const diffSec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000))
      if (diffSec < 60) return t('timeNow')
      const diffMin = Math.floor(diffSec / 60)
      if (diffMin < 60) return t('timeMinutes', { n: String(diffMin) })
      const diffHours = Math.floor(diffMin / 60)
      if (diffHours < 24) return t('timeHours', { n: String(diffHours) })
      const diffDays = Math.floor(diffHours / 24)
      return t('timeDays', { n: String(diffDays) })
    }

    function phaseLabel(hostItem, t) {
      const p = hostItem.phase || 'connecting_ssh'
      const key = `phase_${p}`
      return t(key, { version: hostItem.dshVersion || '' })
    }

    function statusLabel(status, t) {
      switch (status) {
        case 'connected': return t('statusConnected')
        case 'connecting': return t('statusConnecting')
        case 'disconnecting': return t('statusDisconnecting')
        case 'error': return t('statusError')
        default: return t('statusDisconnected')
      }
    }

    function sourceKindText(sourceKind, t) {
      if (sourceKind === 'github') return t('sourceKind_github')
      if (sourceKind === 'local') return t('sourceKind_local')
      return t('sourceKind_npm')
    }

    /**
     * Interactive authentication dialog for Password / OTP / Passphrase / Confirmation prompts.
     */
    function AuthModal({ promptInfo, onSubmit, onCancel, t }) {
      const [value, setValue] = React.useState('')
      const [showSecret, setShowSecret] = React.useState(false)
      const [submitting, setSubmitting] = React.useState(false)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        setValue('')
        setShowSecret(false)
        setSubmitting(false)
        const timer = setTimeout(() => {
          inputRef.current?.focus?.()
        }, 30)
        return () => clearTimeout(timer)
      }, [promptInfo?.id])

      React.useEffect(() => {
        const onKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [onCancel])

      if (!promptInfo) return null

      const kind = promptInfo.kind || 'password'
      const isOtp = kind === 'otp'
      const isConfirm = kind === 'confirm'
      const alwaysPlainText = isOtp || isConfirm

      const placeholder = isOtp
        ? t('authInputPlaceholderOtp')
        : kind === 'passphrase'
          ? t('authInputPlaceholderPassphrase')
          : isConfirm
            ? t('authInputPlaceholderConfirm')
            : kind === 'password'
              ? t('authInputPlaceholderPassword')
              : t('authInputPlaceholderGeneric')

      const handleSubmit = async (e) => {
        e.preventDefault()
        if (submitting) return
        setSubmitting(true)
        try {
          await onSubmit({
            host: promptInfo.host,
            promptId: promptInfo.id,
            value,
          })
        } finally {
          setSubmitting(false)
        }
      }

      return h('div', {
        className: 'dsh-rc-modal-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('authModalTitle', { host: promptInfo.host }),
      },
      h('form', { className: 'dsh-rc-modal', onSubmit: handleSubmit },
        h('h3', { className: 'dsh-rc-modal-title' }, t('authModalTitle', { host: promptInfo.host })),
        h('p', { className: 'dsh-rc-modal-desc' }, t('authModalDesc')),
        h('div', { className: 'dsh-rc-field' },
          h('span', { className: 'dsh-rc-field-label' }, t('authPromptLabel')),
          h('div', { className: 'dsh-rc-prompt-box' }, promptInfo.prompt)),
        h('div', { className: 'dsh-rc-field' },
          h('div', {
            className: 'dsh-rc-input-wrap',
            'data-has-toggle': !alwaysPlainText ? 'true' : 'false',
          },
          h('input', {
            ref: inputRef,
            type: alwaysPlainText || showSecret ? 'text' : 'password',
            className: 'dsh-rc-input',
            value,
            placeholder,
            autoComplete: 'off',
            onChange: (e) => setValue(e.target.value),
          }),
          !alwaysPlainText && h('button', {
            type: 'button',
            className: 'dsh-rc-eye-btn',
            title: showSecret ? t('authHideSecret') : t('authShowSecret'),
            'aria-label': showSecret ? t('authHideSecret') : t('authShowSecret'),
            'aria-pressed': showSecret,
            onClick: () => {
              setShowSecret((v) => !v)
              inputRef.current?.focus?.()
            },
          }, showSecret ? h(EyeOpenIcon, { size: 16 }) : h(EyeClosedIcon, { size: 16 })))),
        h('div', { className: 'dsh-rc-modal-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn',
            onClick: onCancel,
          }, t('btnAuthCancel')),
          h('button', {
            type: 'submit',
            className: 'dsh-rc-btn dsh-rc-btn-primary',
            disabled: submitting,
          }, t('btnAuthSubmit')))))
    }

    /**
     * Secondary confirmation dialog when the remote host already has a higher version of the selected plugin installed.
     */
    function PluginOverwriteModal({ confirmInfo, onConfirm, onCancel, t }) {
      const [submitting, setSubmitting] = React.useState(false)

      React.useEffect(() => {
        setSubmitting(false)
      }, [confirmInfo?.host, confirmInfo?.pluginName])

      React.useEffect(() => {
        if (!confirmInfo) return undefined
        const onKeyDown = (e) => {
          if (e.key === 'Escape' && !submitting) {
            e.preventDefault()
            onCancel()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [confirmInfo, submitting, onCancel])

      if (!confirmInfo) return null

      const handleConfirm = async () => {
        if (submitting) return
        setSubmitting(true)
        try {
          await onConfirm(confirmInfo)
        } finally {
          setSubmitting(false)
        }
      }

      return h('div', {
        className: 'dsh-rc-modal-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        onClick: (e) => { if (e.target === e.currentTarget && !submitting) onCancel() },
      },
      h('div', { className: 'dsh-rc-modal' },
        h('h3', { className: 'dsh-rc-modal-title' }, t('overwriteModalTitle')),
        h('p', { className: 'dsh-rc-modal-desc' },
          t('overwriteModalDesc', {
            host: confirmInfo.host,
            profile: confirmInfo.profile || 'web',
            name: confirmInfo.pluginName,
            remoteVersion: confirmInfo.remoteVersion,
            localVersion: confirmInfo.localVersion,
          })),
        h('div', { className: 'dsh-rc-connected-box' },
          h('div', { className: 'dsh-rc-kv-row' },
            h('span', { className: 'dsh-rc-kv-label' }, t('overwriteRemoteVerLabel')),
            h('span', { className: 'dsh-rc-kv-val', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
              `v${confirmInfo.remoteVersion}`)),
          h('div', { className: 'dsh-rc-kv-row' },
            h('span', { className: 'dsh-rc-kv-label' }, t('overwriteLocalVerLabel')),
            h('span', { className: 'dsh-rc-kv-val' }, `v${confirmInfo.localVersion}`)),
          h('div', { className: 'dsh-rc-kv-row' },
            h('span', { className: 'dsh-rc-kv-label' }, t('overwriteSourceLabel')),
            h('span', { className: 'dsh-rc-kv-val' }, sourceKindText(confirmInfo.sourceKind, t)))),
        h('div', { className: 'dsh-rc-modal-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn',
            disabled: submitting,
            onClick: onCancel,
          }, t('btnCancelOverwrite')),
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-danger',
            disabled: submitting,
            onClick: handleConfirm,
          }, submitting ? t('btnConfirmingOverwrite') : t('btnConfirmOverwrite')))))
    }

    /**
     * Notification modal when a synced remote workspace has been deleted on the remote DSH.
     * Upon user confirmation, removes the invalidated remote workspace from local persistence and sidebar.
     */
    function InvalidatedWorkspaceModal({ workspaceInfo, onConfirmRemove, t }) {
      const [removing, setRemoving] = React.useState(false)

      React.useEffect(() => {
        setRemoving(false)
      }, [workspaceInfo?.localWorkspaceId])

      if (!workspaceInfo) return null

      const handleConfirm = async () => {
        if (removing) return
        setRemoving(true)
        try {
          await onConfirmRemove(workspaceInfo.localWorkspaceId)
        } finally {
          setRemoving(false)
        }
      }

      return h('div', {
        className: 'dsh-rc-modal-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('invalidWsModalTitle'),
      },
      h('div', { className: 'dsh-rc-modal' },
        h('h3', { className: 'dsh-rc-modal-title' }, t('invalidWsModalTitle')),
        h('p', { className: 'dsh-rc-modal-desc' },
          t('invalidWsModalDesc', {
            host: workspaceInfo.host,
            title: workspaceInfo.title,
            path: workspaceInfo.remotePath,
          })),
        h('div', { className: 'dsh-rc-connected-box' },
          h('div', { className: 'dsh-rc-kv-row' },
            h('span', { className: 'dsh-rc-kv-label' }, t('invalidWsHostLabel')),
            h('span', { className: 'dsh-rc-kv-val' }, workspaceInfo.host)),
          h('div', { className: 'dsh-rc-kv-row' },
            h('span', { className: 'dsh-rc-kv-label' }, t('invalidWsPathLabel')),
            h('span', { className: 'dsh-rc-kv-val' }, workspaceInfo.remotePath))),
        h('div', { className: 'dsh-rc-modal-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-danger',
            disabled: removing,
            onClick: handleConfirm,
          }, removing ? t('btnRemovingInvalidWs') : t('btnConfirmRemoveInvalidWs')))))
    }

    function HostCard({
      item,
      localPlugins,
      localeId,
      sharedState,
      onConnect,
      onDisconnect,
      onSaveConfig,
      onKillPortAndReconnect,
      onSyncPlugin,
      onOpenAuthModal,
      onRefreshParent,
      t,
    }) {
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [remotePortInput, setRemotePortInput] = React.useState(String(item.config?.remotePort ?? 3080))
      const [localPortInput, setLocalPortInput] = React.useState(String(item.config?.localPort ?? 0))
      const [profileInput, setProfileInput] = React.useState(String(item.config?.profile ?? 'web'))
      const [savingConfig, setSavingConfig] = React.useState(false)
      const [savedBanner, setSavedBanner] = React.useState(false)
      const [configErr, setConfigErr] = React.useState(null)

      const conflictPort = item.error?.remotePort ?? item.config?.remotePort ?? 3080
      const [quickPort, setQuickPort] = React.useState(String(conflictPort === 3080 ? 3081 : conflictPort + 1))
      const [killingPort, setKillingPort] = React.useState(false)
      const [changingPort, setChangingPort] = React.useState(false)
      const [copiedUrl, setCopiedUrl] = React.useState(false)

      const [selectedPlugin, setSelectedPlugin] = React.useState(() => (localPlugins?.[0]?.name ?? ''))
      const [syncingPlugin, setSyncingPlugin] = React.useState(false)
      const [syncNotice, setSyncNotice] = React.useState(null)
      const [syncError, setSyncError] = React.useState(null)

      // Remote workspaces state for this connected host (seeded from sharedState cache)
      const [remoteWorkspaces, setRemoteWorkspaces] = React.useState(
        () => sharedState.remoteWorkspacesByHost.get(item.alias) || [],
      )
      const [loadingWorkspaces, setLoadingWorkspaces] = React.useState(false)
      const [selectedRemoteWsId, setSelectedRemoteWsId] = React.useState('')
      const [syncingWorkspace, setSyncingWorkspace] = React.useState(false)
      const [wsNotice, setWsNotice] = React.useState(null)
      const [wsError, setWsError] = React.useState(null)
      const [pluginDiff, setPluginDiff] = React.useState(
        () => sharedState.pluginDiffByHost.get(item.alias) || null,
      )

      const isConnected = item.status === 'connected'
      const isConnecting = item.status === 'connecting'
      const isDisconnecting = item.status === 'disconnecting'
      const isRemotePortConflict = item.error?.code === 'REMOTE_PORT_IN_USE'
      const isLocalPortConflict = item.error?.code === 'LOCAL_PORT_IN_USE'

      const loadRemoteWorkspaces = React.useCallback(async () => {
        if (!isConnected) return
        setLoadingWorkspaces(true)
        try {
          const res = await callHost('remote-workspaces', { host: item.alias })
          const list = Array.isArray(res?.workspaces) ? res.workspaces : []
          sharedState.remoteWorkspacesByHost.set(item.alias, list)
          setRemoteWorkspaces(list)
          if (res?.pluginDiff) {
            sharedState.pluginDiffByHost.set(item.alias, res.pluginDiff)
            setPluginDiff(res.pluginDiff)
          }
          if (list.length > 0) {
            setSelectedRemoteWsId((prev) => {
              if (prev && list.some((w) => w.remoteWorkspaceId === prev)) return prev
              const firstUnsynced = list.find((w) => !w.synced)
              return (firstUnsynced ?? list[0]).remoteWorkspaceId
            })
          } else {
            setSelectedRemoteWsId('')
          }
        } catch (err) {
          setWsError(err instanceof Error ? err.message : String(err))
        } finally {
          setLoadingWorkspaces(false)
        }
      }, [isConnected, item.alias, sharedState])

      React.useEffect(() => {
        if (isConnected) {
          void loadRemoteWorkspaces()
        } else {
          setRemoteWorkspaces([])
          setPluginDiff(null)
        }
      }, [isConnected, loadRemoteWorkspaces])

      React.useEffect(() => {
        if (!selectedPlugin && localPlugins?.length > 0) {
          setSelectedPlugin(localPlugins[0].name)
        } else if (selectedPlugin && localPlugins?.length > 0 && !localPlugins.some((p) => p.name === selectedPlugin)) {
          setSelectedPlugin(localPlugins[0].name)
        }
      }, [localPlugins, selectedPlugin])

      React.useEffect(() => {
        setRemotePortInput(String(item.config?.remotePort ?? 3080))
        setLocalPortInput(String(item.config?.localPort ?? 0))
        setProfileInput(String(item.config?.profile ?? 'web'))
      }, [item.config?.remotePort, item.config?.localPort, item.config?.profile])

      React.useEffect(() => {
        if (item.error?.code === 'REMOTE_PORT_IN_USE') {
          const p = Number(item.error.remotePort || item.config?.remotePort || 3080)
          setQuickPort(String(p === 65535 ? 3081 : p + 1))
        }
      }, [item.error?.code, item.error?.remotePort])

      const targetDesc = [
        item.user ? `${item.user}@${item.hostName}` : item.hostName,
        item.sshPort && item.sshPort !== 22 ? `:${item.sshPort}` : '',
        item.proxyJump ? ` (via ${item.proxyJump})` : '',
      ].join('')

      const handleSaveConfig = async (e) => {
        if (e) e.preventDefault()
        setConfigErr(null)
        setSavingConfig(true)
        try {
          await onSaveConfig(item.alias, {
            remotePort: Number(remotePortInput),
            localPort: Number(localPortInput),
            profile: profileInput.trim() || 'web',
          })
          setSavedBanner(true)
          setTimeout(() => setSavedBanner(false), 3000)
        } catch (err) {
          setConfigErr(err instanceof Error ? err.message : String(err))
        } finally {
          setSavingConfig(false)
        }
      }

      const handleConnectClick = async () => {
        setConfigErr(null)
        const rp = Number(remotePortInput)
        const lp = Number(localPortInput)
        const prof = profileInput.trim() || 'web'
        if (
          rp !== item.config?.remotePort ||
          lp !== item.config?.localPort ||
          prof !== item.config?.profile
        ) {
          try {
            await onSaveConfig(item.alias, { remotePort: rp, localPort: lp, profile: prof })
          } catch (err) {
            setConfigErr(err instanceof Error ? err.message : String(err))
            return
          }
        }
        await onConnect(item.alias)
      }

      const handleCopyUrl = async () => {
        if (!item.url) return
        try {
          await navigator.clipboard.writeText(item.url)
          setCopiedUrl(true)
          setTimeout(() => setCopiedUrl(false), 2000)
        } catch {}
      }

      const triggerSyncPlugin = async (pluginNameToSync) => {
        if (!pluginNameToSync || syncingPlugin) return
        setSyncingPlugin(true)
        setSyncNotice(null)
        setSyncError(null)
        try {
          const res = await onSyncPlugin(item.alias, pluginNameToSync, false, (confirmedResult) => {
            const srcLabel = sourceKindText(confirmedResult.sourceKind, t)
            setSyncNotice(
              confirmedResult.reinstalled
                ? t('syncSuccessReinstalled', {
                  name: confirmedResult.pluginName,
                  version: confirmedResult.installedVersion || confirmedResult.localVersion,
                  source: srcLabel,
                })
                : t('syncSuccessFresh', {
                  name: confirmedResult.pluginName,
                  version: confirmedResult.installedVersion || confirmedResult.localVersion,
                  source: srcLabel,
                  profile: confirmedResult.profile || 'web',
                }),
            )
            void loadRemoteWorkspaces()
          })
          if (res && res.status === 'synced') {
            const srcLabel = sourceKindText(res.sourceKind, t)
            setSyncNotice(
              res.reinstalled
                ? t('syncSuccessReinstalled', {
                  name: res.pluginName,
                  version: res.installedVersion || res.localVersion,
                  source: srcLabel,
                })
                : t('syncSuccessFresh', {
                  name: res.pluginName,
                  version: res.installedVersion || res.localVersion,
                  source: srcLabel,
                  profile: res.profile || 'web',
                }),
            )
            void loadRemoteWorkspaces()
          }
        } catch (err) {
          setSyncError(err instanceof Error ? err.message : String(err))
        } finally {
          setSyncingPlugin(false)
        }
      }

      const handleSyncWorkspaceClick = async () => {
        if (syncingWorkspace || !selectedRemoteWsId) return
        setSyncingWorkspace(true)
        setWsNotice(null)
        setWsError(null)
        try {
          const res = await callHost('sync-workspace', {
            host: item.alias,
            remoteWorkspaceId: selectedRemoteWsId,
          })
          if (res?.workspace) {
            setWsNotice(t('wsSyncedNotice', { title: res.workspace.title }))
          }
          if (res?.pluginDiff) {
            sharedState.pluginDiffByHost.set(item.alias, res.pluginDiff)
            setPluginDiff(res.pluginDiff)
          }
          await loadRemoteWorkspaces()
          await onRefreshParent()
        } catch (err) {
          setWsError(err instanceof Error ? err.message : String(err))
        } finally {
          setSyncingWorkspace(false)
        }
      }

      const configDiffersFromActive = isConnected && (
        item.config?.remotePort !== item.activeRemotePort ||
        (item.config?.localPort !== 0 && item.config?.localPort !== item.activeLocalPort) ||
        item.config?.profile !== item.activeProfile
      )

      const isZh = String(localeId || '').toLowerCase().startsWith('zh')
      const diffCount = (pluginDiff?.missingOnRemote?.length || 0) + (pluginDiff?.missingOnLocal?.length || 0)
      const hasPluginDiff = Boolean(pluginDiff && diffCount > 0)
      const isDiffCollapsed = sharedState.isPluginDiffCollapsed(item.alias)

      return h('li', {
        className: 'dsh-rc-card',
        'data-ssh-host': item.alias,
        'data-status': item.status,
      },
      h('div', { className: 'dsh-rc-card-top' },
        h('div', { className: 'dsh-rc-host-info' },
          h('span', { className: 'dsh-rc-dot', 'data-status': item.status, 'aria-hidden': 'true' }),
          h('div', { className: 'dsh-rc-host-text' },
            h('div', { className: 'dsh-rc-host-title-row' },
              h('span', { className: 'dsh-rc-host-alias' }, item.alias),
              h('span', { className: 'dsh-rc-status-pill', 'data-status': item.status }, statusLabel(item.status, t))),
            h('span', { className: 'dsh-rc-host-target' }, targetDesc))),
        h('div', { className: 'dsh-rc-actions' },
          item.authPrompt && h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-primary',
            onClick: () => onOpenAuthModal(item.authPrompt),
          }, t('btnEnterAuth')),
          isConnected && h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-danger',
            disabled: isDisconnecting,
            onClick: () => onDisconnect(item.alias),
          }, t('btnDisconnect')),
          isConnecting && h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-danger',
            onClick: () => onDisconnect(item.alias),
          }, t('btnCancelConnect')),
          !isConnected && !isConnecting && !isDisconnecting && h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-primary',
            onClick: handleConnectClick,
          }, t('btnConnect')),
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn',
            onClick: () => setSettingsOpen((v) => !v),
          }, settingsOpen ? t('btnHideSettings') : t('btnSettings')))),

      isConnecting && h('div', { className: 'dsh-rc-progress-box', role: 'status' },
        h('span', null, phaseLabel(item, t)),
        item.recentLogs?.length > 0 && h('span', { className: 'dsh-rc-log-line' }, item.recentLogs.at(-1))),

      isConnected && h('div', { className: 'dsh-rc-connected-box' },
        h('div', { className: 'dsh-rc-kv-row' },
          h('span', { className: 'dsh-rc-kv-label' }, t('tunnelLabel')),
          h('span', { className: 'dsh-rc-kv-val' },
            t('tunnelValue', { localPort: String(item.activeLocalPort), remotePort: String(item.activeRemotePort) }))),
        h('div', { className: 'dsh-rc-kv-row' },
          h('span', { className: 'dsh-rc-kv-label' }, t('activeProfileLabel')),
          h('span', { className: 'dsh-rc-kv-val' },
            item.activeProfile || 'web',
            item.initializedFromWeb && h('span', { className: 'dsh-rc-status-pill' }, t('activeProfileInitTag')))),
        item.url && h('div', { className: 'dsh-rc-kv-row' },
          h('span', { className: 'dsh-rc-kv-label' }, t('remoteUrlLabel')),
          h('span', { className: 'dsh-rc-kv-val' },
            h('a', {
              href: item.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'dsh-rc-url-link',
            }, item.url),
            h('button', {
              type: 'button',
              className: 'dsh-rc-btn dsh-rc-btn-sm',
              onClick: handleCopyUrl,
            }, copiedUrl ? t('urlCopied') : t('btnCopyUrl')))),

        // Sync local plugin row
        h('div', { className: 'dsh-rc-sync-row' },
          h('span', { className: 'dsh-rc-kv-label' }, t('syncPluginLabel')),
          localPlugins && localPlugins.length > 0
            ? h('div', { className: 'dsh-rc-sync-controls' },
              h('select', {
                className: 'dsh-rc-select',
                value: selectedPlugin,
                disabled: syncingPlugin,
                'aria-label': t('syncPluginLabel'),
                onChange: (e) => setSelectedPlugin(e.target.value),
              },
              localPlugins.map((p) => {
                const displayTitle = (isZh ? p.title?.zh : p.title?.en) || p.name
                const labelText = displayTitle !== p.name
                  ? `${displayTitle} (${p.name} v${p.version} · ${sourceKindText(p.sourceKind, t)})`
                  : `${p.name} (v${p.version} · ${sourceKindText(p.sourceKind, t)})`
                return h('option', { key: p.name, value: p.name }, labelText)
              })),
              h('button', {
                type: 'button',
                className: 'dsh-rc-btn dsh-rc-btn-primary dsh-rc-btn-sm',
                disabled: !selectedPlugin || syncingPlugin,
                onClick: () => triggerSyncPlugin(selectedPlugin),
              }, syncingPlugin ? t('btnSyncingPlugin') : t('btnSyncPlugin')))
            : h('span', { className: 'dsh-rc-field-hint' }, t('syncPluginNoLocal'))),

        syncNotice && h('div', { className: 'dsh-rc-notice', role: 'status' }, syncNotice),
        syncError && h('div', { className: 'dsh-rc-error-inline', role: 'alert' }, syncError),

        // Sync remote workspace row (no globe icon, no sync by path button)
        h('div', { className: 'dsh-rc-sync-row', 'data-sync-workspace-row': item.alias },
          h('span', { className: 'dsh-rc-kv-label' }, t('syncWorkspaceLabel')),
          loadingWorkspaces && remoteWorkspaces.length === 0
            ? h('span', { className: 'dsh-rc-field-hint' }, t('syncWorkspaceLoading'))
            : h('div', { className: 'dsh-rc-sync-controls' },
              remoteWorkspaces.length > 0
                ? h(React.Fragment, null,
                  h('select', {
                    className: 'dsh-rc-select',
                    value: selectedRemoteWsId,
                    disabled: syncingWorkspace,
                    'aria-label': t('syncWorkspaceLabel'),
                    onChange: (e) => setSelectedRemoteWsId(e.target.value),
                  },
                  remoteWorkspaces.map((ws) => h('option', {
                    key: ws.remoteWorkspaceId,
                    value: ws.remoteWorkspaceId,
                  }, t('syncWorkspaceOptionFmt', {
                    title: ws.title,
                    path: ws.path,
                    count: String(ws.sessionCount ?? 0),
                    syncedTag: ws.synced ? t('syncWorkspaceSyncedTag') : '',
                  })))),
                  h('button', {
                    type: 'button',
                    className: 'dsh-rc-btn dsh-rc-btn-primary dsh-rc-btn-sm',
                    disabled: syncingWorkspace || !selectedRemoteWsId,
                    onClick: handleSyncWorkspaceClick,
                  }, syncingWorkspace ? t('btnSyncingWorkspace') : t('btnSyncWorkspace')))
                : h('span', { className: 'dsh-rc-field-hint' }, t('syncWorkspaceEmpty')),
              h('button', {
                type: 'button',
                className: 'dsh-rc-btn dsh-rc-btn-sm',
                disabled: loadingWorkspaces,
                onClick: () => { void loadRemoteWorkspaces() },
              }, t('btnRefreshWorkspaces')))),

        wsNotice && h('div', { className: 'dsh-rc-notice', role: 'status' }, wsNotice),
        wsError && h('div', { className: 'dsh-rc-error-inline', role: 'alert' }, wsError),

        // Collapsible plugin difference banner with long-term persisted collapse/expand state
        hasPluginDiff && h('div', {
          className: 'dsh-rc-diff-box',
          'data-collapsed': isDiffCollapsed ? 'true' : 'false',
          role: 'status',
        },
          h('div', { className: 'dsh-rc-diff-header' },
            h('span', {
              className: 'dsh-rc-diff-header-left',
              onClick: () => sharedState.togglePluginDiffCollapsed(item.alias),
            },
            h('span', null, t('pluginDiffTitle')),
            h('span', { className: 'dsh-rc-diff-count' }, String(diffCount))),
            h('button', {
              type: 'button',
              className: 'dsh-rc-btn dsh-rc-btn-sm dsh-rc-diff-toggle-btn',
              'aria-expanded': !isDiffCollapsed,
              onClick: () => sharedState.togglePluginDiffCollapsed(item.alias),
            },
            h(ChevronDownIcon, { size: 12, collapsed: isDiffCollapsed }),
            isDiffCollapsed ? t('btnExpandDiff') : t('btnCollapseDiff'))),
          !isDiffCollapsed && pluginDiff.missingOnRemote?.length > 0 && h('div', { className: 'dsh-rc-diff-section' },
            h('span', null, t('pluginDiffMissingOnRemote')),
            h('div', { className: 'dsh-rc-diff-tags' },
              pluginDiff.missingOnRemote.map((mp) => {
                const pTitle = (isZh ? mp.title?.zh : mp.title?.en) || mp.name
                return h('button', {
                  key: mp.name,
                  type: 'button',
                  className: 'dsh-rc-btn dsh-rc-btn-sm',
                  disabled: syncingPlugin,
                  onClick: () => triggerSyncPlugin(mp.name),
                }, t('btnSyncDiffPlugin', { name: `${pTitle} (v${mp.version})` }))
              }))),
          !isDiffCollapsed && pluginDiff.missingOnLocal?.length > 0 && h('div', { className: 'dsh-rc-diff-section' },
            h('span', null, t('pluginDiffMissingOnLocal')),
            h('div', { className: 'dsh-rc-diff-tags' },
              pluginDiff.missingOnLocal.map((rp) => {
                const pTitle = (isZh ? rp.title?.zh : rp.title?.en) || rp.name
                return h('span', { key: rp.name, className: 'dsh-rc-badge' },
                  `${pTitle} (${rp.name} v${rp.version})`)
              })))),

        configDiffersFromActive && h('div', { className: 'dsh-rc-field-hint' },
          t('nextConfigNotice', {
            remotePort: String(item.config.remotePort),
            localPort: String(item.config.localPort),
            profile: item.config.profile,
          }))),

      isRemotePortConflict && h('div', { className: 'dsh-rc-conflict-box', role: 'alert' },
        h('h4', { className: 'dsh-rc-conflict-title' },
          t('portConflictTitle', { port: String(conflictPort) })),
        h('p', { className: 'dsh-rc-conflict-desc' },
          item.error?.occupantPid
            ? t('portConflictDescWithProcess', {
              port: String(conflictPort),
              pid: String(item.error.occupantPid),
              cmd: item.error.occupantCommand ? ` (${item.error.occupantCommand})` : '',
            })
            : t('portConflictDescGeneric', { port: String(conflictPort) })),
        h('div', { className: 'dsh-rc-conflict-controls' },
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-danger',
            disabled: killingPort || changingPort,
            onClick: async () => {
              setKillingPort(true)
              try {
                await onKillPortAndReconnect(item.alias, conflictPort)
              } finally {
                setKillingPort(false)
              }
            },
          }, killingPort ? t('btnKillingOccupant') : t('btnKillOccupantAndReconnect')),
          h('div', { className: 'dsh-rc-quick-port-group' },
            h('label', { className: 'dsh-rc-field-label' }, t('quickPortLabel')),
            h('input', {
              type: 'number',
              min: 1,
              max: 65535,
              className: 'dsh-rc-input',
              style: { width: '96px' },
              value: quickPort,
              onChange: (e) => setQuickPort(e.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-rc-btn dsh-rc-btn-primary',
              disabled: changingPort || killingPort,
              onClick: async () => {
                const nextP = Number(quickPort)
                if (!Number.isInteger(nextP) || nextP < 1 || nextP > 65535) return
                setChangingPort(true)
                try {
                  await onSaveConfig(item.alias, { remotePort: nextP })
                  await onConnect(item.alias, nextP)
                } finally {
                  setChangingPort(false)
                }
              },
            }, t('btnChangePortAndReconnect')),
            h('button', {
              type: 'button',
              className: 'dsh-rc-btn',
              disabled: changingPort || killingPort,
              onClick: async () => {
                const nextP = Number(quickPort)
                if (!Number.isInteger(nextP) || nextP < 1 || nextP > 65535) return
                setChangingPort(true)
                try {
                  await onSaveConfig(item.alias, { remotePort: nextP })
                } finally {
                  setChangingPort(false)
                }
              },
            }, t('btnChangePortOnly'))))),

      isLocalPortConflict && h('div', { className: 'dsh-rc-conflict-box', role: 'alert' },
        h('h4', { className: 'dsh-rc-conflict-title' },
          t('localPortConflictTitle', { port: String(item.error?.localPort ?? item.config?.localPort) })),
        h('p', { className: 'dsh-rc-conflict-desc' },
          t('localPortConflictDesc', { port: String(item.error?.localPort ?? item.config?.localPort) })),
        h('div', { className: 'dsh-rc-conflict-controls' },
          h('button', {
            type: 'button',
            className: 'dsh-rc-btn dsh-rc-btn-primary',
            onClick: async () => {
              await onSaveConfig(item.alias, { localPort: 0 })
              await onConnect(item.alias)
            },
          }, t('btnAutoLocalPortAndReconnect')))),

      item.status === 'error' && !isRemotePortConflict && !isLocalPortConflict && item.error?.message && h('div', {
        className: 'dsh-rc-conflict-box',
        role: 'alert',
      },
      h('p', { className: 'dsh-rc-conflict-desc', style: { color: 'var(--dsw-alias-state-error-primary)' } },
        item.error.message)),

      settingsOpen && h('form', { className: 'dsh-rc-settings-panel', onSubmit: handleSaveConfig },
        h('div', { className: 'dsh-rc-form-grid' },
          h('div', { className: 'dsh-rc-field' },
            h('label', { className: 'dsh-rc-field-label' }, t('fieldRemotePort')),
            h('input', {
              type: 'number',
              min: 1,
              max: 65535,
              className: 'dsh-rc-input',
              value: remotePortInput,
              onChange: (e) => setRemotePortInput(e.target.value),
            }),
            h('span', { className: 'dsh-rc-field-hint' }, t('fieldRemotePortHint'))),
          h('div', { className: 'dsh-rc-field' },
            h('label', { className: 'dsh-rc-field-label' }, t('fieldLocalPort')),
            h('input', {
              type: 'number',
              min: 0,
              max: 65535,
              className: 'dsh-rc-input',
              value: localPortInput,
              onChange: (e) => setLocalPortInput(e.target.value),
            }),
            h('span', { className: 'dsh-rc-field-hint' }, t('fieldLocalPortHint'))),
          h('div', { className: 'dsh-rc-field' },
            h('label', { className: 'dsh-rc-field-label' }, t('fieldProfile')),
            h('input', {
              type: 'text',
              className: 'dsh-rc-input',
              value: profileInput,
              onChange: (e) => setProfileInput(e.target.value),
            }),
            h('span', { className: 'dsh-rc-field-hint' }, t('fieldProfileHint')))),
        configErr && h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, configErr),
        h('div', { className: 'dsh-rc-settings-foot' },
          h('span', { className: 'dsh-rc-notice' }, savedBanner ? t('configSavedNotice') : ''),
          h('button', {
            type: 'submit',
            className: 'dsh-rc-btn dsh-rc-btn-primary',
            disabled: savingConfig,
          }, savingConfig ? t('btnSavingConfig') : t('btnSaveConfig')))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh,
          en,
          ja: en,
          es: en,
          fr: en,
          de: en,
          ru: en,
          pt: en,
        }), 'remote-ssh-connect: locale')

        const t = ctx.locale.bind(NS)

        function getClientWorkspaceModel() {
          const wsSvc = ctx.get?.('workspaces')
          if (!wsSvc) return null
          const raw = unwrapCordisService(wsSvc)
          return raw?.model ?? raw?.list ?? wsSvc.list ?? null
        }

        function ensureWorkspaceInClientModel(localWorkspaceId, overrideRecord) {
          const model = getClientWorkspaceModel()
          if (!model || !localWorkspaceId) return
          try {
            model.removedIds?.delete?.(localWorkspaceId)
            const rec = overrideRecord || sharedState.syncedWorkspaces.find((w) => w.localWorkspaceId === localWorkspaceId)
            if (!rec) return
            const snap = model.getSnapshot?.()
            const existing = snap?.items?.find((w) => w.workspaceId === localWorkspaceId)
            const sessionIds = Array.isArray(rec.sessionIds) ? rec.sessionIds : (existing?.sessionIds ?? [])
            const prevMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0
            const nextMs = Math.max(Date.now(), (Number.isFinite(prevMs) ? prevMs : 0) + 1)
            const pureTitle = rec.title || localWorkspaceId
            model.upsertView?.({
              workspaceId: localWorkspaceId,
              path: rec.remotePath || rec.path || '/',
              title: pureTitle,
              sessionIds,
              createdAt: rec.createdAt || existing?.createdAt || new Date().toISOString(),
              updatedAt: new Date(nextMs).toISOString(),
            })
          } catch {}
        }

        function addSessionToClientWorkspaceModel(localWorkspaceId, sessionId) {
          const model = getClientWorkspaceModel()
          if (!model || !localWorkspaceId || !sessionId) return
          try {
            const parsed = parseLocalWorkspaceId(localWorkspaceId)
            if (parsed) {
              sessionToRemoteHost.set(sessionId, parsed.host)
            }
            model.removedIds?.delete?.(localWorkspaceId)
            const snap = model.getSnapshot?.()
            const existing = snap?.items?.find((w) => w.workspaceId === localWorkspaceId)
            const rec = sharedState.syncedWorkspaces.find((w) => w.localWorkspaceId === localWorkspaceId)
            if (!existing && !rec) return
            const prevIds = Array.isArray(existing?.sessionIds)
              ? existing.sessionIds
              : (Array.isArray(rec?.sessionIds) ? rec.sessionIds : [])
            const nextIds = prevIds.includes(sessionId) ? prevIds : [sessionId, ...prevIds]
            const prevMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0
            const nextMs = Math.max(Date.now(), (Number.isFinite(prevMs) ? prevMs : 0) + 1)
            const pureTitle = existing?.title || rec?.title || localWorkspaceId
            model.upsertView?.({
              workspaceId: localWorkspaceId,
              path: existing?.path || rec?.remotePath || '/',
              title: pureTitle,
              sessionIds: nextIds,
              createdAt: existing?.createdAt || rec?.createdAt || new Date().toISOString(),
              updatedAt: new Date(nextMs).toISOString(),
            })
            reconcileAllModelDirectories()
          } catch {}
        }

        function syncAllWorkspacesToClientModel(syncedList) {
          const model = getClientWorkspaceModel()
          if (!model || !Array.isArray(syncedList)) return
          try {
            const activeIds = new Set()
            const snap = model.getSnapshot?.()
            const existingById = new Map((snap?.items ?? []).map((w) => [w.workspaceId, w]))

            for (const ws of syncedList) {
              if (!ws || !ws.localWorkspaceId || ws.invalidated) continue
              activeIds.add(ws.localWorkspaceId)
              model.removedIds?.delete?.(ws.localWorkspaceId)
              const existing = existingById.get(ws.localWorkspaceId)
              const wsSessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
              for (const sid of wsSessionIds) {
                if (typeof sid === 'string' && sid) {
                  sessionToRemoteHost.set(sid, ws.host)
                }
              }
              if (Array.isArray(ws.rawSummaries)) {
                for (const s of ws.rawSummaries) {
                  if (s && typeof s.sessionId === 'string') {
                    sessionToRemoteHost.set(s.sessionId, ws.host)
                  }
                }
              }
              const pureTitle = ws.title
              const sameSessions = existing &&
                Array.isArray(existing.sessionIds) &&
                existing.sessionIds.length === wsSessionIds.length &&
                existing.sessionIds.every((id, idx) => id === wsSessionIds[idx])
              if (!existing || existing.title !== pureTitle || existing.path !== ws.remotePath || !sameSessions) {
                const prevMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0
                const nextMs = Math.max(Date.now(), (Number.isFinite(prevMs) ? prevMs : 0) + 1)
                model.upsertView?.({
                  workspaceId: ws.localWorkspaceId,
                  path: ws.remotePath || '/',
                  title: pureTitle,
                  sessionIds: wsSessionIds,
                  createdAt: ws.createdAt || existing?.createdAt || new Date().toISOString(),
                  updatedAt: new Date(nextMs).toISOString(),
                })
              }
            }

            for (const [id] of existingById) {
              if (parseLocalWorkspaceId(id) !== null && !activeIds.has(id)) {
                model.removeView?.(id)
              }
            }
          } catch {}
        }

        const requestedProjectionIds = new Set()

        function ensureSessionsInClientStore(syncedList) {
          if (!Array.isArray(syncedList) || syncedList.length === 0) return
          const sessSvc = ctx.get?.('sessions')
          if (!sessSvc) return
          const rawSessions = unwrapCordisService(sessSvc)
          if (!rawSessions || typeof rawSessions.handleSessionAdded !== 'function') return

          try {
            const snap = rawSessions.list?.getSnapshot?.()
            const byId = snap?.byId ?? {}
            const projectionsBySession = snap?.projectionsBySession ?? {}

            for (const ws of syncedList) {
              if (!ws || !ws.connected || ws.invalidated) continue
              if (Array.isArray(ws.rawSummaries)) {
                for (const summary of ws.rawSummaries) {
                  if (summary && typeof summary.sessionId === 'string') {
                    sessionToRemoteHost.set(summary.sessionId, ws.host)
                    rawSessions.handleSessionAdded(summary)
                  }
                }
              }
              const sids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
              for (const sid of sids) {
                if (!sid || typeof sid !== 'string') continue
                sessionToRemoteHost.set(sid, ws.host)
                if (!byId[sid]) {
                  rawSessions.handleSessionAdded({
                    sessionId: sid,
                    updatedAt: 0,
                    agentAvailable: false,
                    running: false,
                    blank: true,
                    cwd: ws.remotePath || '/',
                  })
                }
                const projState = projectionsBySession[sid]?.state
                if (
                  projState !== 'ready' &&
                  projState !== 'loading' &&
                  !requestedProjectionIds.has(sid) &&
                  typeof rawSessions.refreshProjections === 'function'
                ) {
                  requestedProjectionIds.add(sid)
                  Promise.resolve(rawSessions.refreshProjections(sid))
                    .catch(() => { requestedProjectionIds.delete(sid) })
                    .finally(() => { sharedState.notify() })
                }
              }
            }
          } catch {}
        }

        /**
         * Per-remote-host ModelCatalogDirectory implementation that mirrors DSH's
         * `ModelCatalogDirectory` interface (`store`, `load()`, `reasoningFor()`, `refresh()`, `resetGeneration()`),
         * fetching the remote host's `session/modelCatalog` so remote sessions only display models
         * configured on the remote host.
         */
        function createSimpleCatalogStore(initialState) {
          let state = initialState
          const listeners = new Set()
          const notify = () => {
            for (const fn of [...listeners]) {
              try { fn() } catch {}
            }
          }
          return {
            getSnapshot() {
              return state
            },
            subscribe(fn) {
              listeners.add(fn)
              return () => listeners.delete(fn)
            },
            set(next) {
              state = next
              notify()
            },
            update(mutator) {
              const draft = { ...state }
              mutator(draft)
              state = draft
              notify()
            },
          }
        }

        class RemoteModelCatalogDirectory {
          constructor(host) {
            this.host = host
            this.store = createSimpleCatalogStore({
              value: null,
              status: 'idle',
              error: null,
            })
            this.reasoning = new Map()
            this.generation = 0
            this.inflight = undefined
            this.lastLoadedAt = 0
          }

          reasoningFor(selection) {
            if (!selection) return undefined
            return this.reasoning.get(JSON.stringify([selection.provider, selection.model]))
          }

          _normalizeRemoteCatalog(rawCatalog) {
            if (!rawCatalog || typeof rawCatalog !== 'object') {
              return { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] }
            }
            const groups = Array.isArray(rawCatalog.groups) ? rawCatalog.groups : []
            const failures = Array.isArray(rawCatalog.failures) ? rawCatalog.failures : []
            const routableProviders = Array.isArray(rawCatalog.routableProviders) ? rawCatalog.routableProviders : []
            let def = rawCatalog.default
            const defIsRoutable = Boolean(
              def?.provider &&
              def?.model &&
              groups.some((g) => g.id === def.provider && Array.isArray(g.models) && g.models.some((m) => m.id === def.model)),
            )
            if (!defIsRoutable) {
              const firstGroup = groups.find((g) => Array.isArray(g.models) && g.models.length > 0)
              const firstModel = firstGroup?.models?.[0]
              if (firstGroup && firstModel) {
                def = {
                  provider: firstGroup.id,
                  model: firstModel.id,
                  ...(firstModel.reasoning?.defaultEffort !== undefined
                    ? { reasoningEffort: firstModel.reasoning.defaultEffort }
                    : {}),
                }
              }
            }
            return {
              ...rawCatalog,
              default: def || { provider: '', model: '' },
              routableProviders,
              groups,
              failures,
            }
          }

          load() {
            const state = this.store.getSnapshot()
            const now = Date.now()
            if (state.status === 'ready' && state.value !== null) {
              if (now - this.lastLoadedAt > 4_000 && !this.inflight) {
                void this._fetchRemoteCatalog(this.generation, true).catch(() => {})
              }
              return Promise.resolve(state.value)
            }
            if (this.inflight !== undefined) return this.inflight
            return this._fetchRemoteCatalog(this.generation, false)
          }

          _fetchRemoteCatalog(generation, background = false) {
            if (!background) {
              this.store.update((draft) => {
                draft.status = 'loading'
                draft.error = null
              })
            }
            const operation = callHost('model-catalog', { host: this.host })
              .then((res) => {
                const catalog = this._normalizeRemoteCatalog(res?.catalog)
                if (generation === this.generation) {
                  for (const group of catalog.groups) {
                    for (const model of group.models ?? []) {
                      this.reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning)
                    }
                  }
                  this.lastLoadedAt = Date.now()
                  this.store.set({ value: catalog, status: 'ready', error: null })
                }
                return catalog
              })
              .catch((error) => {
                if (generation === this.generation && !background) {
                  this.store.update((draft) => {
                    draft.status = 'error'
                    draft.error = error instanceof Error ? error.message : String(error)
                  })
                }
                throw error
              })
              .finally(() => {
                if (generation === this.generation && this.inflight === operation) {
                  this.inflight = undefined
                }
              })
            this.inflight = operation
            return operation
          }

          invalidate(clear = false) {
            this.generation += 1
            this.inflight = undefined
            const value = clear ? null : this.store.getSnapshot().value
            this.store.set({ value, status: 'idle', error: null })
          }

          refresh() {
            this.invalidate()
            void this.load().catch(() => {})
          }

          resetGeneration() {
            this.reasoning.clear()
            this.invalidate(true)
            void this.load().catch(() => {})
          }
        }

        const remoteCatalogsByHost = new Map()
        const sessionToRemoteHost = new Map()
        const checkedRemoteHostSessionIds = new Set()
        const trackedModelDirectories = new Set()

        function getRemoteHostCatalog(host) {
          let cat = remoteCatalogsByHost.get(host)
          if (!cat) {
            cat = new RemoteModelCatalogDirectory(host)
            remoteCatalogsByHost.set(host, cat)
          }
          return cat
        }

        function resolveRemoteHostForSession(sessionId) {
          if (!sessionId || typeof sessionId !== 'string') return null
          const direct = sessionToRemoteHost.get(sessionId)
          if (direct) return direct

          // Check client workspace model
          try {
            const wsModel = getClientWorkspaceModel()
            const snap = wsModel?.getSnapshot?.()
            for (const w of snap?.items ?? []) {
              const parsed = parseLocalWorkspaceId(w?.workspaceId)
              if (parsed && Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) {
                sessionToRemoteHost.set(sessionId, parsed.host)
                return parsed.host
              }
            }
          } catch {}

          // Check sharedState syncedWorkspaces
          for (const ws of sharedState.syncedWorkspaces) {
            if (!ws || !ws.host) continue
            if (
              (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) ||
              (Array.isArray(ws.rawSummaries) && ws.rawSummaries.some((s) => s?.sessionId === sessionId))
            ) {
              sessionToRemoteHost.set(sessionId, ws.host)
              return ws.host
            }
          }
          return null
        }

        function bindDirectoryToCatalog(directory, targetCatalog, hostTag) {
          if (!directory || directory.disposed || !targetCatalog) return
          if (directory._rcBoundCatalog === targetCatalog) return
          directory._rcBoundCatalog = targetCatalog
          directory._rcBoundHost = hostTag || null
          try {
            if (typeof directory.unsubscribeCatalog === 'function') {
              directory.unsubscribeCatalog()
            }
          } catch {}
          directory.catalog = targetCatalog
          directory.unsubscribeCatalog = targetCatalog.store.subscribe(() => {
            try {
              directory.syncInputs()
              // If this is a remote session whose current model is not routable on the remote host
              // while the remote catalog has a valid default model, auto-align blank sessions to the remote default
              if (hostTag && typeof directory.isBlank === 'function' && directory.isBlank()) {
                const dirSnap = directory.store?.getSnapshot?.()
                const catSnap = targetCatalog.store?.getSnapshot?.()
                const remoteDef = catSnap?.value?.default
                if (
                  catSnap?.status === 'ready' &&
                  dirSnap?.routable === false &&
                  dirSnap?.status === 'ready' &&
                  remoteDef?.provider &&
                  remoteDef?.model &&
                  !directory._rcAutoAlignedDefault
                ) {
                  directory._rcAutoAlignedDefault = true
                  void directory.select(remoteDef).catch(() => {})
                }
              }
            } catch {}
          })
          try {
            directory.syncInputs()
          } catch {}
          void targetCatalog.load().catch(() => {})
        }

        function reconcileDirectoryCatalog(directory) {
          if (!directory || directory.disposed) {
            trackedModelDirectories.delete(directory)
            return
          }
          if (!directory._rcOriginalLocalCatalog) {
            directory._rcOriginalLocalCatalog = directory.catalog
          }
          const sid = directory.sessionId
          const host = resolveRemoteHostForSession(sid)
          if (host) {
            const remoteCat = getRemoteHostCatalog(host)
            bindDirectoryToCatalog(directory, remoteCat, host)
            return
          }
          bindDirectoryToCatalog(directory, directory._rcOriginalLocalCatalog, null)
          if (sid && !checkedRemoteHostSessionIds.has(sid)) {
            checkedRemoteHostSessionIds.add(sid)
            callHost('session-host', { sessionId: sid })
              .then((res) => {
                if (res?.host && typeof res.host === 'string') {
                  sessionToRemoteHost.set(sid, res.host)
                  reconcileDirectoryCatalog(directory)
                }
              })
              .catch(() => {})
          }
        }

        function reconcileAllModelDirectories() {
          try {
            const mdSvc = unwrapCordisService(ctx.get?.('modelDirectories'))
            const liveValues = mdSvc?.live?.directories?.values
            if (liveValues && typeof liveValues[Symbol.iterator] === 'function') {
              for (const dir of liveValues) {
                trackedModelDirectories.add(dir)
              }
            }
          } catch {}
          for (const dir of [...trackedModelDirectories]) {
            if (!dir || dir.disposed) {
              trackedModelDirectories.delete(dir)
              continue
            }
            reconcileDirectoryCatalog(dir)
          }
        }

        function installModelDirectoriesInterceptor() {
          try {
            const mdProxy = ctx.get?.('modelDirectories')
            const md = unwrapCordisService(mdProxy)
            if (!md || typeof md.directoryFor !== 'function' || md._rcDirectoryForWrapped) return
            const origDirectoryFor = md.directoryFor.bind(md)
            md.directoryFor = (sessionId) => {
              const directory = origDirectoryFor(sessionId)
              if (directory && !directory.disposed) {
                if (!directory._rcOriginalLocalCatalog) {
                  directory._rcOriginalLocalCatalog = directory.catalog
                }
                trackedModelDirectories.add(directory)
                reconcileDirectoryCatalog(directory)
              }
              return directory
            }
            md._rcDirectoryForWrapped = true
            reconcileAllModelDirectories()
          } catch {}
        }

        // Shared reactive store across sidebar and SSH Connect panel
        const sharedState = {
          hostsByAlias: new Map(),
          syncedWorkspaces: [],
          invalidatedWorkspaces: [],
          authPrompts: [],
          remoteWorkspacesByHost: new Map(),
          pluginDiffByHost: new Map(),
          collapsedPluginDiffs: loadPersistedCollapsedDiffs(),
          listeners: new Set(),
          notify() {
            for (const fn of [...this.listeners]) {
              try { fn() } catch {}
            }
          },
          subscribe(fn) {
            this.listeners.add(fn)
            return () => this.listeners.delete(fn)
          },
          isPluginDiffCollapsed(host) {
            if (this.collapsedPluginDiffs.has(host)) {
              return Boolean(this.collapsedPluginDiffs.get(host))
            }
            const hostItem = this.hostsByAlias.get(host)
            if (typeof hostItem?.config?.pluginDiffCollapsed === 'boolean') {
              return hostItem.config.pluginDiffCollapsed
            }
            return false
          },
          togglePluginDiffCollapsed(host) {
            const next = !this.isPluginDiffCollapsed(host)
            this.collapsedPluginDiffs.set(host, next)
            savePersistedCollapsedDiffs(this.collapsedPluginDiffs)
            const hostItem = this.hostsByAlias.get(host)
            if (hostItem?.config) {
              hostItem.config.pluginDiffCollapsed = next
            }
            this.notify()
            void callHost('configure', {
              host,
              config: { pluginDiffCollapsed: next },
            }).catch(() => {})
          },
          updateFromList(res) {
            if (!res || typeof res !== 'object') return
            const prevConnectedHosts = new Set(
              [...this.hostsByAlias.values()].filter((hItem) => hItem.status === 'connected').map((hItem) => hItem.alias),
            )
            this.hostsByAlias.clear()
            const prompts = []
            let newlyConnected = false
            let collapsedChanged = false
            for (const hItem of res.hosts ?? []) {
              this.hostsByAlias.set(hItem.alias, hItem)
              if (hItem.authPrompt) prompts.push(hItem.authPrompt)
              if (
                typeof hItem.config?.pluginDiffCollapsed === 'boolean' &&
                !this.collapsedPluginDiffs.has(hItem.alias)
              ) {
                this.collapsedPluginDiffs.set(hItem.alias, hItem.config.pluginDiffCollapsed)
                collapsedChanged = true
              }
              if (hItem.status === 'connected' && !prevConnectedHosts.has(hItem.alias)) {
                newlyConnected = true
                getRemoteHostCatalog(hItem.alias).refresh()
              }
            }
            if (collapsedChanged) {
              savePersistedCollapsedDiffs(this.collapsedPluginDiffs)
            }
            this.authPrompts = prompts
            this.syncedWorkspaces = Array.isArray(res.syncedWorkspaces)
              ? res.syncedWorkspaces.filter((w) => !w.invalidated)
              : []
            this.invalidatedWorkspaces = Array.isArray(res.invalidatedWorkspaces)
              ? res.invalidatedWorkspaces
              : []

            syncAllWorkspacesToClientModel(this.syncedWorkspaces)
            ensureSessionsInClientStore(this.syncedWorkspaces)
            installModelDirectoriesInterceptor()
            reconcileAllModelDirectories()
            if (newlyConnected) {
              try {
                const sessSvc = ctx.get?.('sessions')
                void sessSvc?.refresh?.()
              } catch {}
            }
            this.notify()
          },
        }

        async function refreshSharedState() {
          try {
            const res = await callHost('list', {})
            sharedState.updateFromList(res)
            return res
          } catch {
            return null
          }
        }

        async function connectHostFromSidebar(host) {
          try {
            const prev = sharedState.hostsByAlias.get(host)
            if (prev) {
              sharedState.hostsByAlias.set(host, { ...prev, status: 'connecting' })
              sharedState.notify()
            }
            await callHost('connect', { host, waitForReady: false })
            await refreshSharedState()
          } catch {}
        }

        // Intercept modelDirectories.directoryFor so remote sessions use their remote host's model catalog
        ctx.effect(() => {
          installModelDirectoriesInterceptor()
          const timer = setInterval(installModelDirectoriesInterceptor, 1000)
          timer?.unref?.()
          return () => clearInterval(timer)
        }, 'remote-ssh-connect: modelDirectories intercept')

        // Intercept uiWorkspace.startSession, openWorkspace, and connectWorkspace on the underlying service instance
        ctx.effect(() => {
          const uiWsProxy = ctx.get?.('uiWorkspace')
          const uiWs = unwrapCordisService(uiWsProxy)
          if (!uiWs || typeof uiWs.startSession !== 'function') return () => {}

          const origStartSession = uiWs.startSession.bind(uiWs)
          const origOpenWorkspace = typeof uiWs.openWorkspace === 'function' ? uiWs.openWorkspace.bind(uiWs) : null
          const origConnectWorkspace = typeof uiWs.connectWorkspace === 'function' ? uiWs.connectWorkspace.bind(uiWs) : null

          uiWs.startSession = (workspaceId, options) => {
            const parsed = parseLocalWorkspaceId(workspaceId)
            if (parsed) {
              const hostInfo = sharedState.hostsByAlias.get(parsed.host)
              if (!hostInfo || hostInfo.status !== 'connected') {
                void connectHostFromSidebar(parsed.host)
                return
              }
              ensureWorkspaceInClientModel(workspaceId)
            }
            return origStartSession(workspaceId, options)
          }

          if (origOpenWorkspace) {
            uiWs.openWorkspace = async (workspaceId, beforeOpen, options) => {
              const parsed = parseLocalWorkspaceId(workspaceId)
              if (parsed) {
                const hostInfo = sharedState.hostsByAlias.get(parsed.host)
                if (!hostInfo || hostInfo.status !== 'connected') {
                  await connectHostFromSidebar(parsed.host)
                  return
                }
                ensureWorkspaceInClientModel(workspaceId)
              }
              return origOpenWorkspace(workspaceId, beforeOpen, options)
            }
          }

          if (origConnectWorkspace) {
            uiWs.connectWorkspace = async (workspaceId, options) => {
              const parsed = parseLocalWorkspaceId(workspaceId)
              if (parsed) {
                ensureWorkspaceInClientModel(workspaceId)
              }
              const sessionId = await origConnectWorkspace(workspaceId, options)
              if (parsed && sessionId) {
                addSessionToClientWorkspaceModel(workspaceId, sessionId)
              }
              return sessionId
            }
          }

          return () => {
            uiWs.startSession = origStartSession
            if (origOpenWorkspace) uiWs.openWorkspace = origOpenWorkspace
            if (origConnectWorkspace) uiWs.connectWorkspace = origConnectWorkspace
          }
        }, 'remote-ssh-connect: uiWorkspace intercept')

        // Register remote workspace actions into the built-in workspace context menu (Connect / Disconnect / Open remote native DSH)
        ctx.effect(() => {
          ctx.slots.inject('contextMenu.icon', function* () {
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'remote-ssh-connect.connect' }, ConnectLinkIcon)
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'remote-ssh-connect.disconnect' }, DisconnectIcon)
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'remote-ssh-connect.open-native' }, ExternalBrowserIcon)
          })
        }, 'remote-ssh-connect: contextMenu icons')

        ctx.effect(() => {
          const contextMenus = ctx.get?.('contextMenus')
          if (!contextMenus || typeof contextMenus.register !== 'function') return () => {}
          return contextMenus.register({
            id: 'remote-ssh-connect.workspace-actions',
            target: 'workspace',
            order: 10,
            resolve: ({ workspaceId }) => {
              const parsed = parseLocalWorkspaceId(workspaceId)
              if (!parsed) return []
              const hostInfo = sharedState.hostsByAlias.get(parsed.host)
              const isConnected = hostInfo?.status === 'connected'
              const items = []
              if (!isConnected) {
                items.push({
                  id: 'remote-ssh-connect.connect',
                  label: t('menuConnectHost', { host: parsed.host }),
                  icon: { key: 'remote-ssh-connect.connect' },
                  run: () => {
                    void connectHostFromSidebar(parsed.host)
                  },
                })
              } else {
                if (hostInfo?.url) {
                  items.push({
                    id: 'remote-ssh-connect.open-native',
                    label: t('menuOpenRemoteNative', { host: parsed.host }),
                    icon: { key: 'remote-ssh-connect.open-native' },
                    run: () => {
                      window.open(hostInfo.url, '_blank', 'noopener,noreferrer')
                    },
                  })
                }
                items.push({
                  id: 'remote-ssh-connect.disconnect',
                  label: t('menuDisconnectHost', { host: parsed.host }),
                  icon: { key: 'remote-ssh-connect.disconnect' },
                  run: () => {
                    void callHost('disconnect', { host: parsed.host }).then(() => refreshSharedState())
                  },
                })
              }
              return items
            },
          })
        }, 'remote-ssh-connect: workspace contextMenu')

        /**
         * Synchronize `data-rc-status` and `data-rc-host` attributes onto remote workspace rows
         * (`[data-row-key^="workspace:remote:"]`) in the built-in Workspaces list so the VS Code-style
         * remote corner badge and disconnected Connect-Host button reflect live connection state.
         */
        function decorateRemoteWorkspaceRowsInDom() {
          if (typeof document === 'undefined') return
          try {
            // Remove any legacy separate Remote Workspaces mount node if present from a prior version
            const legacyMount = document.getElementById('dsh-rc-remote-workspaces-mount')
            if (legacyMount) legacyMount.remove()

            const rows = document.querySelectorAll('[data-row-key^="workspace:remote:"]')
            for (const row of rows) {
              const rowKey = row.getAttribute('data-row-key') || ''
              const wsId = rowKey.startsWith('workspace:') ? rowKey.slice('workspace:'.length) : ''
              const parsed = parseLocalWorkspaceId(wsId)
              if (!parsed) continue
              const hostInfo = sharedState.hostsByAlias.get(parsed.host)
              const wsRec = sharedState.syncedWorkspaces.find((w) => w.localWorkspaceId === wsId)
              const status = hostInfo?.status || wsRec?.hostStatus || 'disconnected'
              if (row.getAttribute('data-rc-status') !== status) {
                row.setAttribute('data-rc-status', status)
              }
              if (row.getAttribute('data-rc-host') !== parsed.host) {
                row.setAttribute('data-rc-host', parsed.host)
              }
              const titleEl = row.querySelector('[class*="projectText"] > [class*="title"]')
              if (titleEl && titleEl.getAttribute('data-rc-host-label') !== parsed.host) {
                titleEl.setAttribute('data-rc-host-label', parsed.host)
              }

              const actionsSpan = row.lastElementChild
              if (!actionsSpan) continue
              let connectBtn = actionsSpan.querySelector('.dsh-rc-inline-connect-btn')

              if (status !== 'connected') {
                const isConnecting = status === 'connecting'
                const tip = isConnecting
                  ? t('sidebarConnectingHost')
                  : `${t('sidebarConnectHost')} (${parsed.host})`
                if (!connectBtn) {
                  connectBtn = document.createElement('button')
                  connectBtn.type = 'button'
                  connectBtn.className = 'dsh-rc-inline-connect-btn'
                  connectBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.5 9.5L9.5 6.5M5 7L3.5 8.5C2.4 9.6 2.4 11.4 3.5 12.5C4.6 13.6 6.4 13.6 7.5 12.5L9 11M11 9L12.5 7.5C13.6 6.4 13.6 4.6 12.5 3.5C11.4 2.4 9.6 2.4 8.5 3.5L7 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
                  connectBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    void connectHostFromSidebar(parsed.host)
                  })
                  actionsSpan.appendChild(connectBtn)
                }
                connectBtn.disabled = isConnecting
                if (connectBtn.getAttribute('title') !== tip) {
                  connectBtn.setAttribute('title', tip)
                  connectBtn.setAttribute('aria-label', tip)
                }
              } else if (connectBtn) {
                connectBtn.remove()
              }
            }
          } catch {}
        }

        /**
         * Frame-wide overlay mounted in `shell.overlay`:
         * - Injects global CSS (including the VS Code-style remote corner badge on remote workspace folders).
         * - Syncs connection status attributes onto remote workspace rows in the built-in Workspaces list.
         * - Shows `InvalidatedWorkspaceModal` whenever a remote workspace was deleted on the remote host.
         * - Shows `AuthModal` when connecting a host from the sidebar while outside the SSH Connect page.
         */
        function RemoteConnectShellOverlay() {
          const [, setTick] = React.useState(0)

          React.useEffect(() => {
            const unsub = sharedState.subscribe(() => {
              setTick((n) => n + 1)
              decorateRemoteWorkspaceRowsInDom()
            })
            void refreshSharedState()
            decorateRemoteWorkspaceRowsInDom()
            return unsub
          }, [])

          React.useEffect(() => {
            if (!ctx.locale?.subscribe) return undefined
            return ctx.locale.subscribe(() => {
              setTick((n) => n + 1)
              decorateRemoteWorkspaceRowsInDom()
            })
          }, [])

          React.useEffect(() => {
            const hasTransition = [...sharedState.hostsByAlias.values()].some(
              (hItem) => hItem.status === 'connecting' || hItem.status === 'disconnecting' || hItem.authPrompt !== null,
            )
            const timer = setInterval(() => {
              void refreshSharedState()
            }, hasTransition ? 900 : 4500)
            return () => clearInterval(timer)
          }, [sharedState.authPrompts.length])

          React.useEffect(() => {
            decorateRemoteWorkspaceRowsInDom()
            if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
            const obs = new MutationObserver(() => {
              decorateRemoteWorkspaceRowsInDom()
            })
            obs.observe(document.body, { childList: true, subtree: true })
            return () => obs.disconnect()
          }, [])

          const firstInvalidated = sharedState.invalidatedWorkspaces[0] || null
          const isSshPageMounted = typeof document !== 'undefined' && Boolean(document.querySelector('[data-dsh-remote-ssh-connect-page]'))
          const sidebarAuthPrompt = !isSshPageMounted ? (sharedState.authPrompts[0] || null) : null

          const handleAckInvalidWorkspace = async (localWorkspaceId) => {
            await callHost('ack-invalid-workspace', { localWorkspaceId })
            await refreshSharedState()
          }

          const handleOverlayAuthSubmit = async ({ host, promptId, value }) => {
            await callHost('auth-submit', { host, promptId, value })
            await refreshSharedState()
          }

          const handleOverlayAuthCancel = async () => {
            if (!sidebarAuthPrompt) return
            try {
              await callHost('auth-cancel', { host: sidebarAuthPrompt.host, promptId: sidebarAuthPrompt.id })
            } catch {}
            await refreshSharedState()
          }

          return h(React.Fragment, null,
            h('style', null, GLOBAL_SIDEBAR_CSS),
            h('style', null, PAGE_CSS),
            firstInvalidated && h(InvalidatedWorkspaceModal, {
              workspaceInfo: firstInvalidated,
              onConfirmRemove: handleAckInvalidWorkspace,
              t,
            }),
            sidebarAuthPrompt && h(AuthModal, {
              promptInfo: sidebarAuthPrompt,
              onSubmit: handleOverlayAuthSubmit,
              onCancel: handleOverlayAuthCancel,
              t,
            }))
        }

        /**
         * Session header indicator & escape hatch ("Remote: <host> · Remote native UI") when viewing a session
         * belonging to a synced remote workspace.
         */
        function RemoteSessionHeaderAction({ sessionId: propSessionId, useWorkspaces, useSessions }) {
          const [, setTick] = React.useState(0)
          React.useEffect(() => sharedState.subscribe(() => setTick((n) => n + 1)), [])

          const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces((s) => s.items) : []
          const sessions = typeof useSessions === 'function' ? useSessions((s) => s) : null
          const mainSessionId = propSessionId || (sessions?.byId
            ? Object.values(sessions.byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id
            : undefined)
          if (!mainSessionId || !Array.isArray(workspaces)) return null

          const owningWs = workspaces.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(mainSessionId))
          const parsed = owningWs ? parseLocalWorkspaceId(owningWs.workspaceId) : null
          if (!parsed) return null

          const hostInfo = sharedState.hostsByAlias.get(parsed.host)
          const remoteUrl = hostInfo?.url

          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            h('span', { className: 'dsh-rc-header-pill', title: owningWs.path },
              t('headerRemoteBadge', { host: parsed.host })),
            remoteUrl && h('a', {
              href: remoteUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'dsh-rc-header-pill',
            }, t('headerOpenRemoteNative')))
        }

        function RemoteConnectPage() {
          const [, setLocaleTick] = React.useState(0)
          const [loading, setLoading] = React.useState(() => sharedState.hostsByAlias.size === 0)
          const [loadError, setLoadError] = React.useState(null)
          const [actionError, setActionError] = React.useState(null)
          const [data, setData] = React.useState(() => ({
            configPath: '~/.ssh/config',
            configExists: true,
            dshVersion: '',
            localPlugins: [],
            syncedWorkspaces: sharedState.syncedWorkspaces,
            invalidatedWorkspaces: sharedState.invalidatedWorkspaces,
            hosts: [...sharedState.hostsByAlias.values()],
          }))
          const [manualPrompt, setManualPrompt] = React.useState(null)
          const [overwriteModalInfo, setOverwriteModalInfo] = React.useState(null)

          React.useEffect(() => {
            if (!ctx.locale?.subscribe) return undefined
            return ctx.locale.subscribe(() => setLocaleTick((n) => n + 1))
          }, [])

          React.useEffect(() => sharedState.subscribe(() => setLocaleTick((n) => n + 1)), [])

          const localeSnapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
          const currentLocaleId = typeof localeSnapshot === 'string'
            ? localeSnapshot
            : (localeSnapshot?.active ?? localeSnapshot?.locale ?? localeSnapshot?.id ?? t('_lang'))

          const fetchHosts = React.useCallback(async (showSpinner = false) => {
            if (showSpinner) setLoading(true)
            try {
              const res = await callHost('list', {})
              setData(res)
              sharedState.updateFromList(res)
              setLoadError(null)
            } catch (err) {
              setLoadError(err instanceof Error ? err.message : String(err))
            } finally {
              if (showSpinner) setLoading(false)
            }
          }, [])

          React.useEffect(() => {
            void fetchHosts(sharedState.hostsByAlias.size === 0)
          }, [fetchHosts])

          const hasActiveTransition = data.hosts.some(
            (item) => item.status === 'connecting' || item.status === 'disconnecting' || item.authPrompt !== null,
          )

          React.useEffect(() => {
            const intervalMs = hasActiveTransition ? 800 : 4000
            const timer = setInterval(() => {
              void fetchHosts(false)
            }, intervalMs)
            return () => clearInterval(timer)
          }, [fetchHosts, hasActiveTransition])

          const activeAuthPrompt = manualPrompt ||
            data.hosts.map((item) => item.authPrompt).find(Boolean) ||
            null

          const handleConnect = async (host, overrideRemotePort) => {
            setActionError(null)
            try {
              await callHost('connect', {
                host,
                waitForReady: false,
                ...(overrideRemotePort !== undefined ? { remotePort: overrideRemotePort } : {}),
              })
              await fetchHosts(false)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : String(err))
            }
          }

          const handleDisconnect = async (host) => {
            setActionError(null)
            try {
              await callHost('disconnect', { host })
              await fetchHosts(false)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : String(err))
            }
          }

          const handleSaveConfig = async (host, config) => {
            await callHost('configure', { host, config })
            await fetchHosts(false)
          }

          const handleKillPortAndReconnect = async (host, remotePort) => {
            setActionError(null)
            try {
              await callHost('kill-port', {
                host,
                remotePort,
                reconnect: true,
                waitForReady: false,
              })
              await fetchHosts(false)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : String(err))
            }
          }

          const handleSyncPlugin = async (host, pluginName, force = false, onForceComplete) => {
            const res = await callHost('sync-plugin', { host, pluginName, force })
            if (res && res.status === 'confirm_required') {
              setOverwriteModalInfo({
                ...res,
                onForceComplete,
              })
            }
            return res
          }

          const handleConfirmOverwrite = async (info) => {
            setActionError(null)
            try {
              const res = await callHost('sync-plugin', {
                host: info.host,
                pluginName: info.pluginName,
                force: true,
              })
              setOverwriteModalInfo(null)
              if (res && res.status === 'synced' && typeof info.onForceComplete === 'function') {
                info.onForceComplete(res)
              }
              await fetchHosts(false)
            } catch (err) {
              setOverwriteModalInfo(null)
              setActionError(err instanceof Error ? err.message : String(err))
            }
          }

          const handleAuthSubmit = async ({ host, promptId, value }) => {
            await callHost('auth-submit', { host, promptId, value })
            setManualPrompt(null)
            await fetchHosts(false)
          }

          const handleAuthCancel = async () => {
            if (!activeAuthPrompt) return
            const p = activeAuthPrompt
            setManualPrompt(null)
            try {
              await callHost('auth-cancel', { host: p.host, promptId: p.id })
            } catch {}
            await fetchHosts(false)
          }

          const connectedCount = data.hosts.filter((hItem) => hItem.status === 'connected').length

          return h('div', { className: 'dsh-rc-page', 'data-dsh-remote-ssh-connect-page': '' },
            h('div', { className: 'dsh-rc-container' },
              h('header', { className: 'dsh-rc-header' },
                h('div', { className: 'dsh-rc-heading' },
                  h('h2', { className: 'dsh-rc-title' }, t('title')),
                  h('p', { className: 'dsh-rc-subtitle' }, t('subtitle'))),
                h('div', { className: 'dsh-rc-toolbar' },
                  data.dshVersion && h('span', { className: 'dsh-rc-badge' },
                    t('dshVersionBadge', { version: data.dshVersion })),
                  data.hosts.length > 0 && h('span', { className: 'dsh-rc-badge' },
                    t('summaryCounts', { total: String(data.hosts.length), connected: String(connectedCount) })),
                  h('button', {
                    type: 'button',
                    className: 'dsh-rc-btn',
                    disabled: loading,
                    onClick: () => { void fetchHosts(true) },
                  }, t('refresh')))),

              actionError && h('div', { className: 'dsh-rc-conflict-box', role: 'alert' },
                h('p', { className: 'dsh-rc-conflict-desc', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                  actionError)),

              loading && data.hosts.length === 0
                ? h('div', { className: 'dsh-rc-empty', role: 'status' }, t('loading'))
                : loadError && data.hosts.length === 0
                  ? h('div', { className: 'dsh-rc-conflict-box', role: 'alert' },
                    h('p', { className: 'dsh-rc-conflict-desc' }, t('loadError', { message: loadError })),
                    h('div', null,
                      h('button', {
                        type: 'button',
                        className: 'dsh-rc-btn',
                        onClick: () => { void fetchHosts(true) },
                      }, t('retry'))))
                  : !data.configExists
                    ? h('div', { className: 'dsh-rc-empty' }, t('emptyNoConfig'))
                    : data.hosts.length === 0
                      ? h('div', { className: 'dsh-rc-empty' }, t('emptyNoHosts'))
                      : h('ul', { className: 'dsh-rc-list' },
                        data.hosts.map((item) => h(HostCard, {
                          key: item.alias,
                          item,
                          localPlugins: data.localPlugins || [],
                          localeId: currentLocaleId,
                          sharedState,
                          onConnect: handleConnect,
                          onDisconnect: handleDisconnect,
                          onSaveConfig: handleSaveConfig,
                          onKillPortAndReconnect: handleKillPortAndReconnect,
                          onSyncPlugin: handleSyncPlugin,
                          onOpenAuthModal: (p) => setManualPrompt(p),
                          onRefreshParent: () => fetchHosts(false),
                          t,
                        })))),

            h(AuthModal, {
              promptInfo: activeAuthPrompt,
              onSubmit: handleAuthSubmit,
              onCancel: handleAuthCancel,
              t,
            }),

            h(PluginOverwriteModal, {
              confirmInfo: overwriteModalInfo,
              onConfirm: handleConfirmOverwrite,
              onCancel: () => setOverwriteModalInfo(null),
              t,
            }))
        }

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'remote-ssh-connect.overlay',
          order: 90,
          locale: NS,
        }, RemoteConnectShellOverlay)), 'remote-ssh-connect: shell overlay')

        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'remote-ssh-connect.session-badge',
          order: 50,
          locale: NS,
        }, RemoteSessionHeaderAction)), 'remote-ssh-connect: session header badge')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, RemoteConnectPage)), 'remote-ssh-connect: main panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: () => t('panel'),
          locale: NS,
        }, SshPanelIcon)), 'remote-ssh-connect: sidebar entry')
      },
    }
  },
})
