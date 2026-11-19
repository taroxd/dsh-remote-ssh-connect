# dsh-remote-ssh-connect

Connect DeepSeek Harness (DSH) to remote Linux hosts over SSH. Manage remote connections from the sidebar, automatically provision matching Node.js and DSH versions on remote machines, synchronize local plugins, and work with remote workspaces and sessions directly from your local DSH interface.

## Features

- **SSH Host Discovery**: Automatically reads concrete host entries from `~/.ssh/config` (including `Include` files) while excluding wildcard patterns.
- **Zero-Setup Remote Provisioning**: Installs a matching DSH version and compatible Node.js runtime under `~/.dsh-remote-ssh-connect` on the remote Linux host when needed, and retains up to three versions automatically.
- **Interactive Authentication**: Supports SSH keys/agents as well as interactive password, OTP / 2FA, and key passphrase prompts directly in the UI.
- **Port Forwarding & Custom Profiles**: Forwards a local port (auto-assigned or fixed) to the remote DSH port and launches the configured remote profile (defaulting to `web`).
- **Plugin Synchronization**: Syncs user-installed local plugins (npm, GitHub, or local directory/tarball sources) to connected remote hosts over the active SSH connection, with version checks before overwriting newer remote versions.
- **Remote Workspaces & Sessions**: Synchronizes remote workspaces into your local **Workspaces** list so you can browse, create, and control remote sessions, use the remote host's configured models, and reorder local and remote workspaces freely.
- **Port Conflict Recovery**: Detects when the target remote port is occupied and lets you terminate the conflicting process or switch ports from the UI.

## Usage

1. Add your remote Linux hosts to `~/.ssh/config`.
2. Open the **SSH connect** panel from the left sidebar in DSH.
3. Optional: click **Settings** on a host card to customize the remote port (default `3080`), local forwarded port (`0` for automatic allocation), or remote profile name (default `web`).
4. Click **Connect** and complete any interactive authentication prompt if requested.
5. Once connected:
   - Use **Sync local plugin** to install local plugins onto the remote profile.
   - Use **Remote workspace** -> **Sync to local** to add a remote workspace to your sidebar **Workspaces** list.
   - Click the mapped local URL if you want to open the remote host's standalone DSH Web interface in a browser.

## License

[MIT](./LICENSE)
