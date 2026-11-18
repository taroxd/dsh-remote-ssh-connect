// Client half of dsh-remote-connect: registers "SSH 连接" / "SSH connect" in the
// left navigation sidebar and renders the bilingual SSH Management Panel.
// Uses only official --dsw-alias-* theme tokens and React (no private primitive imports).

window.__ModuleLoader__.load({
  id: 'dsh-remote-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshRemoteConnect'
    const PANEL_ID = 'remote-connect'

    const zh = {
      _lang: 'zh',
      panel: 'SSH 连接',
      title: 'SSH 远端连接管理',
      subtitle: '管理 ~/.ssh/config 中的 Linux 主机，通过 SSH 自动部署同版本 DSH、同步本地插件并建立本地端口映射',
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
      phase_installing_node: '正在安装 Node.js 到 ~/.dsh-remote-connect/node…',
      phase_checking_dsh: '正在检查远端 ~/.dsh-remote-connect/{version}…',
      phase_installing_dsh: '正在安装 DSH {version} 到 ~/.dsh-remote-connect/{version}…',
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

      urlModalTitle: '打开远端 DSH — {host}',
      urlModalFallbackDesc: '当前操作系统环境不支持直接唤起默认浏览器（{reason}）。请点击或复制下方链接在浏览器中打开：',
      urlModalManualDesc: '您可以通过以下映射到本地的 URL 访问远端 DSH：',
      btnOpenInNewTab: '在浏览器新标签页打开',
      btnCloseModal: '关闭',
      browserOpenedNotice: '已在操作系统默认浏览器中打开 {url}',
    }

    const en = {
      _lang: 'en',
      panel: 'SSH connect',
      title: 'Remote SSH connections',
      subtitle: 'Manage Linux hosts from ~/.ssh/config, provision matching DSH versions over SSH, sync local plugins, and forward ports locally',
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
      phase_installing_node: 'Installing Node.js into ~/.dsh-remote-connect/node…',
      phase_checking_dsh: 'Checking ~/.dsh-remote-connect/{version}…',
      phase_installing_dsh: 'Installing DSH {version} into ~/.dsh-remote-connect/{version}…',
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

      urlModalTitle: 'Open remote DSH — {host}',
      urlModalFallbackDesc: 'The operating system could not open the default browser directly ({reason}). Click or copy the URL below to open it manually:',
      urlModalManualDesc: 'Access the remote DSH instance using the mapped local URL below:',
      btnOpenInNewTab: 'Open in new browser tab',
      btnCloseModal: 'Close',
      browserOpenedNotice: 'Opened {url} in default browser',
    }

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
      const response = await fetch(new URL(`api/remote-connect/${op}`, document.baseURI).href, {
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
     * - Password prompt: shows only the password field (no extra OTP box; if the server requires OTP, a second prompt will appear).
     * - OTP prompt: always plain text, no "Hide input" / "Show input" toggle.
     * - Clicking Cancel terminates the SSH connection attempt immediately.
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
          h('input', {
            ref: inputRef,
            type: alwaysPlainText || showSecret ? 'text' : 'password',
            className: 'dsh-rc-input',
            value,
            placeholder,
            autoComplete: 'off',
            onChange: (e) => setValue(e.target.value),
          })),
        !alwaysPlainText && h('label', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' },
        },
        h('input', {
          type: 'checkbox',
          checked: showSecret,
          onChange: (e) => setShowSecret(e.target.checked),
        }),
        showSecret ? t('authHideSecret') : t('authShowSecret')),
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

    function HostCard({
      item,
      localPlugins,
      localeId,
      onConnect,
      onDisconnect,
      onSaveConfig,
      onKillPortAndReconnect,
      onSyncPlugin,
      onOpenAuthModal,
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

      const isConnected = item.status === 'connected'
      const isConnecting = item.status === 'connecting'
      const isDisconnecting = item.status === 'disconnecting'
      const isRemotePortConflict = item.error?.code === 'REMOTE_PORT_IN_USE'
      const isLocalPortConflict = item.error?.code === 'LOCAL_PORT_IN_USE'

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

      const handleSyncPluginClick = async () => {
        if (!selectedPlugin || syncingPlugin) return
        setSyncingPlugin(true)
        setSyncNotice(null)
        setSyncError(null)
        try {
          const res = await onSyncPlugin(item.alias, selectedPlugin, false, (confirmedResult) => {
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
          }
        } catch (err) {
          setSyncError(err instanceof Error ? err.message : String(err))
        } finally {
          setSyncingPlugin(false)
        }
      }

      const configDiffersFromActive = isConnected && (
        item.config?.remotePort !== item.activeRemotePort ||
        (item.config?.localPort !== 0 && item.config?.localPort !== item.activeLocalPort) ||
        item.config?.profile !== item.activeProfile
      )

      const isZh = String(localeId || '').toLowerCase().startsWith('zh')

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
                onClick: handleSyncPluginClick,
              }, syncingPlugin ? t('btnSyncingPlugin') : t('btnSyncPlugin')))
            : h('span', { className: 'dsh-rc-field-hint' }, t('syncPluginNoLocal'))),

        syncNotice && h('div', { className: 'dsh-rc-notice', role: 'status' }, syncNotice),
        syncError && h('div', { className: 'dsh-rc-error-inline', role: 'alert' }, syncError),
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
        }), 'remote-connect: locale')

        const t = ctx.locale.bind(NS)

        function RemoteConnectPage() {
          const [, setLocaleTick] = React.useState(0)
          const [loading, setLoading] = React.useState(true)
          const [loadError, setLoadError] = React.useState(null)
          const [actionError, setActionError] = React.useState(null)
          const [data, setData] = React.useState({
            configPath: '~/.ssh/config',
            configExists: true,
            dshVersion: '',
            localPlugins: [],
            hosts: [],
          })
          const [manualPrompt, setManualPrompt] = React.useState(null)
          const [overwriteModalInfo, setOverwriteModalInfo] = React.useState(null)

          React.useEffect(() => {
            if (!ctx.locale?.subscribe) return undefined
            return ctx.locale.subscribe(() => setLocaleTick((n) => n + 1))
          }, [])

          const localeSnapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
          const currentLocaleId = typeof localeSnapshot === 'string'
            ? localeSnapshot
            : (localeSnapshot?.active ?? localeSnapshot?.locale ?? localeSnapshot?.id ?? t('_lang'))

          const fetchHosts = React.useCallback(async (showSpinner = false) => {
            if (showSpinner) setLoading(true)
            try {
              const res = await callHost('list', {})
              setData(res)
              setLoadError(null)
            } catch (err) {
              setLoadError(err instanceof Error ? err.message : String(err))
            } finally {
              if (showSpinner) setLoading(false)
            }
          }, [])

          React.useEffect(() => {
            void fetchHosts(true)
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

          return h('div', { className: 'dsh-rc-page', 'data-dsh-remote-connect-page': '' },
            h('style', null, PAGE_CSS),
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
                          onConnect: handleConnect,
                          onDisconnect: handleDisconnect,
                          onSaveConfig: handleSaveConfig,
                          onKillPortAndReconnect: handleKillPortAndReconnect,
                          onSyncPlugin: handleSyncPlugin,
                          onOpenAuthModal: (p) => setManualPrompt(p),
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

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, RemoteConnectPage)), 'remote-connect: main panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: () => t('panel'),
          locale: NS,
        }, SshPanelIcon)), 'remote-connect: sidebar entry')
      },
    }
  },
})
