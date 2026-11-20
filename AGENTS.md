# AGENTS.md

## Architecture & Implementation Notes

### Package Structure

- `index.js`: Host plugin entry (`remote-ssh-connect`). Opens the `dsh_remote_ssh_connect` storage domain (`host_configs` and `remote_workspaces` tables), registers `/api/remote-ssh-connect/*` HTTP routes, federates `typertGateway` RPC/stream calls to connected remote hosts, and registers the `remote_ssh_connect` agent tool.
- `client.js`: Web client plugin entry (`dsh-remote-ssh-connect`). Registers the `remote-ssh-connect` main panel and sidebar entry, mounts the global overlay for auth/invalidation dialogs and workspace row decoration, hooks `modelDirectories` for per-host remote model catalogs, and registers remote workspace context menu actions.
- `src/connection-manager.js`: Manages SSH child processes, local port allocation, `SSH_ASKPASS` coordination, remote bootstrap events, plugin synchronization over the active SSH stdin/stdout channel, and remote model catalog queries.
- `src/remote-workspace-bridge.js`: Implements `MinimalWsClient` (RFC 6455 over `node:http`/`node:https`), `RemoteHostGatewayClient`, and `RemoteWorkspaceBridge`. Synchronizes `workspace/follow`, `session/control`, and `$events` streams from connected remote hosts and proxies session-scoped and workspace-scoped RPCs/streams.
- `src/plugin-sync.js`: Discovers user-installed bundles in the local profile (`npm`, `github`, or `local` directory/tarball sources) and packs local plugin directories into gzipped archives for streaming over SSH.
- `src/remote-script.js`: Generates the POSIX shell + Node.js supervisor script executed on the remote Linux host (`~/.dsh-remote-ssh-connect`).
- `src/ssh-config.js`: Parses `~/.ssh/config` and `Include` directives using OpenSSH first-wins semantics, excluding wildcard (`*`, `?`) and negated (`!`) patterns from listed host aliases.
- `src/askpass-server.js` & `src/askpass-helper.mjs`: Loopback HTTP coordinator and helper script for `SSH_ASKPASS` interactive authentication prompts (password, OTP, passphrase, host confirmation).

### Key Design Conventions

1. **Unified Workspaces List & Ordering**:
   - Synced remote workspaces use the local ID format `remote:<host>:<remoteWorkspaceId>` and live alongside local workspaces in the built-in `Workspaces` sidebar tree.
   - Workspace titles are stored and forwarded verbatim: the local record title, `WorkspaceView.title`, and the remote DSH title are never rewritten by heuristic rules. Syncing a remote workspace adopts the remote title as-is, and renaming forwards the exact user-entered title to the remote host.
   - The ` (<host>)` label is a purely visual suffix: the client sets `data-rc-host-label` on the row's title element and CSS renders it with `[data-row-key^="workspace:remote:"] [data-rc-host-label]::after { content: " (" attr(data-rc-host-label) ")"; }`. `attr()` reads the pseudo-element's own host element, so the attribute must live on the title span itself.
   - Interleaved ordering of local and remote workspaces is tracked in `RemoteWorkspaceBridge.combinedWorkspaceOrder` and persisted under the `__workspace_order__` record in `host_configs`.
   - `workspace/insertBefore` is intercepted for both local and remote workspaces so mixed drag-and-drop ordering is preserved across reloads.
   - Remote workspace folder icons in the sidebar (`[data-row-key^="workspace:remote:"] > span:first-child`) are decorated via CSS `::before`/`::after` masks with a circular `8.5px` VS Code `remote-explorer` style corner badge (`currentColor` outline and `><` glyph over a sidebar-background circular knockout).
   - When a remote workspace's host is not connected (`data-rc-status !== "connected"`), its sessions are hidden (`sessionIds: []`), the built-in New Session button is hidden via CSS, and an inline Connect Host button (`.dsh-rc-inline-connect-btn`) is rendered in `.rowActions`.

2. **Per-Host Remote Model Catalogs**:
   - Local `session/modelCatalog` calls (with no `host` or remote `sessionId`) are handled strictly by the local Host so local sessions only display locally configured models.
   - On the client, `modelDirectories.directoryFor(sessionId)` is intercepted. When `sessionId` belongs to a remote workspace on `<host>`, its `ModelDirectory` is bound to a per-host `RemoteModelCatalogDirectory` backed by `/api/remote-ssh-connect/model-catalog`, ensuring the model selector and `/model` command display the remote host's routable models.

3. **Plugin Difference Hints**:
   - `HostCard` displays local vs. remote plugin differences in `.dsh-rc-diff-box` with a Collapse/Expand toggle.
   - The collapsed state is persisted long-term in both `localStorage` (`dsh.remoteSshConnect.collapsedPluginDiffs.v1`) and the Host `storageDomain` (`host_configs[host].pluginDiffCollapsed`).

4. **SSH Authentication Modal**:
   - Secret inputs (`password`, `passphrase`) render an inline eye toggle button (`.dsh-rc-eye-btn`) on the right side of the input (`EyeClosedIcon` when hidden, `EyeOpenIcon` when revealed). Plain-text prompts (`otp`, `confirm`) omit the toggle.

5. **Remote Host Side Effects (keep them minimal)**:
   - Plugin sync removes and installs bundles only through the remote DSH's live PluginManager (`removeBundle` / `installBundle`) driven by the supervisor. It never edits the remote profile `package.json`, never writes `.npmrc` or `pnpm-workspace.yaml`, never auto-approves build scripts (`approvedBuilds` / `dangerouslyAllowAllBuilds`), and never restarts the remote DSH. A `restart-required` outcome is reported to the user; failures (including pending build approvals) surface as errors.
   - Local plugins keep their local install protocol on the remote (`link:` stays `link:`, `file:` stays `file:`). For `link:` directories with dependencies, the supervisor runs `pnpm install --prod --ignore-scripts` inside the synced copy, because `link:` does not install the target's own dependencies.
   - The packed plugin archive contains the plugin's files only; nothing is injected.
   - The remote DSH child receives the supervisor's environment unchanged (plus `NO_COLOR`); do not inject variables for the benefit of specific third-party plugins. Plugin load-order problems belong in the plugin itself.
   - `prune_old_versions` deletes only directories in `~/.dsh-remote-ssh-connect` that carry both `.install-complete` and `node_modules/@deepseek-ai/dsh/package.json`.
   - Terminating a remote port occupant targets only the process currently listening on that port (`ss` / `lsof` / `fuser`); no PID files are written or trusted.
   - SSH host key checking follows the user's own `~/.ssh/config`; the plugin does not override `StrictHostKeyChecking`.

6. **Code & Documentation Language Policy**:
   - All source code comments, commit messages, `README.md`, `AGENTS.md`, and `docs/DETAIL.md` must be written strictly in English (no Chinese characters).
   - Chinese text is only permitted in localized UI dictionaries (`zh` in `client.js`, `locale/zh.json`, `docs/DETAIL.zh.md`, and prompt-classification regexes in `src/askpass-server.js`).

### Testing & Release

- Run tests with `npm test` (`node --test --test-isolation=none test/remote-ssh-connect.test.js`).
- GitHub Actions workflows:
  - `.github/workflows/ci.yml`: Runs tests on push and pull requests.
  - `.github/workflows/publish.yml`: Publishes to npm with provenance via OIDC trusted publishing when a `v*` tag matching `package.json` `version` is pushed.
