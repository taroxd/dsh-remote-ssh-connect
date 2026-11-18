# dsh-remote-connect

Bilingual (`zh` / `en`) DeepSeek Harness (DSH) bundle plugin that adds the **SSH 登录** (**SSH login**) management panel to the left navigation sidebar, connects to remote Linux hosts configured in `~/.ssh/config`, provisions matching Node.js and DSH versions under `~/.dsh-remote-connect/${DSH_VERSION}`, forwards local ports to the remote DSH Web server, and opens the mapped URL in the default browser.

## Features

- **Bilingual UI (`zh` / `en`)**: Automatically follows DSH's active language setting with natural Chinese and English copy.
- **Cross-platform local host (`win32` / `linux`) to remote Linux (`linux`)**: Uses OpenSSH with `SSH_ASKPASS` (`SSH_ASKPASS_REQUIRE=force`) to support default public-key/agent authentication as well as interactive password, OTP / 2FA, and key-passphrase prompts.
- **`~/.ssh/config` discovery**: Parses `~/.ssh/config` and `Include` directives using VS Code Remote-SSH style rules, excluding wildcard (`*`, `?`) and negated (`!`) patterns from the host list while still applying matching `Host` block options in OpenSSH first-wins order.
- **Isolated versioned remote installation**:
  - Installs the exact local DSH version into `~/.dsh-remote-connect/${DSH_VERSION}` on the remote Linux host (skipping installation when already present).
  - Automatically retains at most 3 installed DSH versions under `~/.dsh-remote-connect`, pruning the oldest versions first.
  - Detects or installs a compatible Node.js (`>=24.9.0`) runtime under `~/.dsh-remote-connect/node` when the remote machine lacks one.
- **Custom profile initialization & port forwarding**:
  - Maps a local port (auto-allocated when `0`, or fixed `1-65535`) to the configured remote port (default `3080`, effective from the next connection).
  - Launches remote DSH with the configured profile (default `web`), automatically passing `--from-default-profile web` when initializing a non-existent custom profile on the remote host.
- **Long-lived keepalive & automatic remote cleanup**:
  - Maintains SSH keepalives (`ServerAliveInterval=15`, `ServerAliveCountMax=3`, `TCPKeepAlive=yes`, plus periodic application heartbeats).
  - Terminates the remote DSH process whenever the user disconnects or the local DSH process exits.
- **Friendly port-conflict recovery**:
  - Detects when the target remote port (such as `3080`) is already in use, reports the occupying process PID/command when available, and offers one-click process termination or a quick port-change input without silently bypassing the conflict.
- **Browser launch & fallback URL modal**:
  - Opens the mapped local URL in the OS default browser on every click of **打开远端 DSH** / **Open remote DSH**, or presents a clickable, copyable URL modal when running in an environment without direct browser support.
