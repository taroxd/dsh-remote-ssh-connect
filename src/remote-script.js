// Generates the remote POSIX shell + Node.js supervisor scripts executed over SSH
// on the remote Linux host.

export const EVENT_PREFIX = 'DSH_RC_EVENT:'
export const DEFAULT_NODE_FALLBACK_VERSION = 'v24.14.0'
export const SHIPPED_PROFILES = new Set(['web', 'acp', 'headless', 'sdk', 'sdk-minimal', 'desktop'])

/**
 * Shell preamble that re-executes the script inside a login + interactive bash environment
 * (`bash -lic`) while preserving the original stdin/stdout/stderr descriptors on fd 3/4/5,
 * so `/etc/profile`, `~/.bash_profile` / `~/.profile`, and `~/.bashrc` (including guards
 * checking `case $- in *i*)` or `$PS1`) execute exactly like a normal interactive SSH login
 * without polluting stdout or consuming stdin.
 */
export const LOGIN_ENV_PREAMBLE = `
if [ "$DSH_RC_ENV_LOADED" != "1" ]; then
  export DSH_RC_ENV_LOADED=1
  if command -v bash >/dev/null 2>&1; then
    exec 3<&0 4>&1 5>&2
    exec bash -lic '
      if [ -f "$HOME/.bashrc" ]; then
        PROFILE_FILE=""
        if [ -f "$HOME/.bash_profile" ]; then PROFILE_FILE="$HOME/.bash_profile"
        elif [ -f "$HOME/.bash_login" ]; then PROFILE_FILE="$HOME/.bash_login"
        elif [ -f "$HOME/.profile" ]; then PROFILE_FILE="$HOME/.profile"
        fi
        if [ -z "$PROFILE_FILE" ] || ! grep -q "bashrc" "$PROFILE_FILE" 2>/dev/null; then
          . "$HOME/.bashrc" >/dev/null 2>&1 || true
        fi
      fi
      exec 0<&3 1>&4 2>&5 3<&- 4<&- 5<&-
      exec bash "$0" "$@"
    ' "$0" "$@" </dev/null >/dev/null 2>&1
  else
    if [ -f /etc/profile ]; then . /etc/profile </dev/null >/dev/null 2>&1 || true; fi
    if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" </dev/null >/dev/null 2>&1 || true; fi
  fi
fi
rm -f "$0" 2>/dev/null || true
`.trim()

/**
 * Build the remote shell command that terminates a process occupying a specific TCP port.
 * Only kills a process owned by the current remote user listening on `port`.
 * @param {number} port
 * @returns {string}
 */
export function buildKillRemotePortScript(port) {
  const safePort = Number(port)
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    throw new Error(`Invalid remote port: ${String(port)}`)
  }
  const script = `
${LOGIN_ENV_PREAMBLE}
set -e
PORT=${safePort}
PIDS=""
if command -v ss >/dev/null 2>&1; then
  PIDS=$(ss -tlnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | sort -u)
fi
if [ -z "$PIDS" ] && command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u)
fi
if [ -z "$PIDS" ] && command -v fuser >/dev/null 2>&1; then
  PIDS=$(fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\\n' | grep -E '^[0-9]+$' | sort -u || true)
fi
if [ -z "$PIDS" ] && [ -f "$HOME/.dsh-remote-connect/run/dsh-$PORT.pid" ]; then
  SAVED_PID=$(cat "$HOME/.dsh-remote-connect/run/dsh-$PORT.pid" 2>/dev/null || true)
  if [ -n "$SAVED_PID" ] && kill -0 "$SAVED_PID" 2>/dev/null; then
    PIDS="$SAVED_PID"
  fi
fi
if [ -z "$PIDS" ]; then
  printf '%s\\n' '${EVENT_PREFIX}{"type":"kill_result","ok":false,"reason":"no_occupant_found"}'
  exit 0
fi
KILLED=""
for PID in $PIDS; do
  kill -TERM "$PID" 2>/dev/null || true
  KILLED="$KILLED $PID"
done
sleep 1
for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null || true
  fi
done
rm -f "$HOME/.dsh-remote-connect/run/dsh-$PORT.pid" 2>/dev/null || true
printf '%s\\n' '${EVENT_PREFIX}{"type":"kill_result","ok":true}'
`
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return `mkdir -p ~/.dsh-remote-connect && printf %s ${encoded} | base64 -d > ~/.dsh-remote-connect/.kill-$$.sh && exec sh ~/.dsh-remote-connect/.kill-$$.sh`
}

/**
 * Build the remote shell script that provisions Node.js and DSH under ~/.dsh-remote-connect,
 * prunes old versions (> 3), checks port availability, initializes custom profiles if needed,
 * and supervises the remote DSH process tied to the SSH connection's stdin lifecycle.
 *
 * @param {object} options
 * @param {string} options.dshVersion - Exact DSH version to install/run (e.g. "0.2.2-rc.3").
 * @param {number} options.remotePort - Remote port for DSH web server (default 3080).
 * @param {number} options.localPort - Local forwarded port mapped to remotePort.
 * @param {string} options.profile - DSH profile name (default "web").
 * @param {number} [options.maxVersions] - Max installed DSH versions to keep (default 3).
 * @param {number} [options.nodeMajorMin] - Minimum Node major version (default 24).
 * @param {number} [options.nodeMinorMin] - Minimum Node minor version (default 9).
 * @param {string} [options.nodeFallbackVersion] - Node version to install if none suitable exists.
 * @param {boolean} [options.forceInstallNode] - Force installing Node into ~/.dsh-remote-connect/node.
 * @param {string} [options.customDshTarballUrl] - Optional tarball/package spec override for testing.
 * @returns {{ script: string, sshCommand: string }}
 */
export function buildRemoteBootstrapScript(options) {
  const dshVersion = String(options.dshVersion || '').trim()
  if (!dshVersion || !/^[A-Za-z0-9._+-]+$/.test(dshVersion)) {
    throw new Error(`Invalid dshVersion: ${JSON.stringify(dshVersion)}`)
  }
  const remotePort = Number(options.remotePort ?? 3080)
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`Invalid remotePort: ${String(options.remotePort)}`)
  }
  const localPort = Number(options.localPort)
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error(`Invalid localPort: ${String(options.localPort)}`)
  }
  const profile = String(options.profile ?? 'web').trim() || 'web'
  if (profile.includes('/') || profile.includes('\\') || profile === '.' || profile === '..' || profile === 'node_modules') {
    throw new Error(`Invalid profile name: ${JSON.stringify(profile)}`)
  }
  if (profile.toLowerCase() === 'desktop') {
    throw new Error('Profile "desktop" is reserved for the Electron desktop application; choose "web" or a custom profile name.')
  }

  const maxVersions = Number(options.maxVersions ?? 3)
  const nodeMajorMin = Number(options.nodeMajorMin ?? 24)
  const nodeMinorMin = Number(options.nodeMinorMin ?? 9)
  const nodeFallbackVersion = String(options.nodeFallbackVersion || DEFAULT_NODE_FALLBACK_VERSION)
  const forceInstallNode = options.forceInstallNode === true ? '1' : '0'
  const dshPackageSpec = options.customDshTarballUrl
    ? String(options.customDshTarballUrl)
    : `@deepseek-ai/dsh@${dshVersion}`

  // Supervisor script run by Node on the remote host once Node & DSH are ready.
  const supervisorJs = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const PREFIX = ${JSON.stringify(EVENT_PREFIX)};
const dshBin = process.env.DSH_RC_BIN;
const dshVersion = process.env.DSH_RC_VERSION;
const profile = process.env.DSH_RC_PROFILE;
const remotePort = Number(process.env.DSH_RC_REMOTE_PORT);
const localPort = Number(process.env.DSH_RC_LOCAL_PORT);
const pidFile = process.env.DSH_RC_PID_FILE;
const shippedProfiles = new Set(['web', 'acp', 'headless', 'sdk', 'sdk-minimal', 'desktop']);

function emit(obj) {
  process.stdout.write(PREFIX + JSON.stringify(obj) + '\\n');
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 600);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

(async () => {
  const inUse = await checkPortInUse(remotePort);
  if (inUse) {
    emit({ type: 'port_in_use', port: remotePort });
    process.exit(42);
  }

  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.HOME || '', '.dsh');
  const profileManifest = path.join(dshHome, 'profiles', profile, 'package.json');
  const isShipped = shippedProfiles.has(profile.toLowerCase());
  const profileExists = fs.existsSync(profileManifest);
  const needsInit = !isShipped && !profileExists;

  const args = [
    dshBin,
    '--profile',
    profile,
    ...(needsInit ? ['--from-default-profile', 'web'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(remotePort),
    '--public-url',
    'http://127.0.0.1:' + String(localPort) + '/',
    '--no-open',
  ];

  emit({
    type: 'phase',
    phase: 'starting_dsh',
    profile,
    initializedFromWeb: needsInit,
    remotePort,
    localPort,
    version: dshVersion,
  });

  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  if (child.pid && pidFile) {
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(child.pid) + '\\n');
    } catch {}
  }

  let shuttingDown = false;
  let readyEmitted = false;

  function cleanupPidFile() {
    if (pidFile) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
  }

  function terminateChild(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    emit({ type: 'stopping', reason });
    if (child.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        if (child.exitCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          try { child.kill('SIGKILL'); } catch {}
        }
        cleanupPidFile();
        emit({ type: 'stopped', reason });
        process.exit(0);
      }, 2000).unref();
    } else {
      cleanupPidFile();
      emit({ type: 'stopped', reason });
      process.exit(0);
    }
  }

  function handleOutputLine(line, streamName) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const urlMatch = /^dsh web:\\s*(https?:\\/\\/\\S+)/i.exec(trimmed);
    if (urlMatch && !readyEmitted) {
      readyEmitted = true;
      let finalUrl = urlMatch[1];
      try {
        const parsed = new URL(finalUrl);
        parsed.protocol = 'http:';
        parsed.hostname = '127.0.0.1';
        parsed.port = String(localPort);
        finalUrl = parsed.href;
      } catch {}
      emit({
        type: 'ready',
        url: finalUrl,
        remotePort,
        localPort,
        profile,
        version: dshVersion,
        pid: child.pid,
        initializedFromWeb: needsInit,
      });
      return;
    }
    if (/EADDRINUSE|address already in use/i.test(trimmed)) {
      emit({ type: 'port_in_use', port: remotePort, detail: trimmed });
    }
    emit({ type: 'log', stream: streamName, line: trimmed });
  }

  readline.createInterface({ input: child.stdout }).on('line', (l) => handleOutputLine(l, 'stdout'));
  readline.createInterface({ input: child.stderr }).on('line', (l) => handleOutputLine(l, 'stderr'));

  child.on('exit', (code, signal) => {
    cleanupPidFile();
    if (!shuttingDown) {
      emit({ type: 'dsh_exit', code, signal });
      process.exit(code ?? 1);
    }
    emit({ type: 'stopped', reason: 'child_exit' });
    process.exit(0);
  });

  process.stdin.setEncoding('utf8');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const cmd = line.trim();
    if (cmd === 'SHUTDOWN') {
      terminateChild('client_shutdown');
    } else if (cmd === 'PING') {
      emit({ type: 'pong', ts: Date.now() });
    }
  });
  process.stdin.on('end', () => terminateChild('stdin_eof'));
  process.stdin.on('close', () => terminateChild('stdin_close'));
  process.stdin.resume();

  process.on('SIGTERM', () => terminateChild('SIGTERM'));
  process.on('SIGINT', () => terminateChild('SIGINT'));
  process.on('SIGHUP', () => terminateChild('SIGHUP'));
})().catch((err) => {
  emit({ type: 'error', message: String(err && err.message ? err.message : err) });
  process.exit(1);
});
`.trim()

  const supervisorB64 = Buffer.from(supervisorJs, 'utf8').toString('base64')

  const script = `
${LOGIN_ENV_PREAMBLE}
set -e

PREFIX='${EVENT_PREFIX}'
BASE_DIR="$HOME/.dsh-remote-connect"
DSH_VERSION='${dshVersion}'
VERSION_DIR="$BASE_DIR/$DSH_VERSION"
REMOTE_PORT=${remotePort}
LOCAL_PORT=${localPort}
PROFILE_NAME=${JSON.stringify(profile)}
MAX_VERSIONS=${maxVersions}
NODE_MAJOR_MIN=${nodeMajorMin}
NODE_MINOR_MIN=${nodeMinorMin}
NODE_FALLBACK_VER='${nodeFallbackVersion}'
FORCE_INSTALL_NODE=${forceInstallNode}
DSH_PACKAGE_SPEC=${JSON.stringify(dshPackageSpec)}

emit_json() {
  printf '%s%s\\n' "$PREFIX" "$1"
}

check_port_conflict() {
  OCCUPANT_PID=""
  OCCUPANT_CMD=""
  if command -v ss >/dev/null 2>&1; then
    SS_OUT=$(ss -tlnH "sport = :$REMOTE_PORT" 2>/dev/null || true)
    if [ -n "$SS_OUT" ]; then
      SS_PROC=$(ss -tlnpH "sport = :$REMOTE_PORT" 2>/dev/null || true)
      OCCUPANT_PID=$(printf '%s\\n' "$SS_PROC" | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
    fi
  elif command -v lsof >/dev/null 2>&1; then
    OCCUPANT_PID=$(lsof -t -iTCP:"$REMOTE_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
      SS_OUT="listening"
    fi
  fi

  if [ -n "$SS_OUT" ]; then
    if [ -n "$OCCUPANT_PID" ] && [ -r "/proc/$OCCUPANT_PID/cmdline" ]; then
      OCCUPANT_CMD=$(tr '\\0' ' ' < "/proc/$OCCUPANT_PID/cmdline" | sed 's/[[:space:]]*$//' | tr '"' "'" || true)
    fi
    if [ -n "$OCCUPANT_PID" ]; then
      emit_json "{\\"type\\":\\"port_in_use\\",\\"port\\":$REMOTE_PORT,\\"pid\\":$OCCUPANT_PID,\\"command\\":\\"$OCCUPANT_CMD\\"}"
    else
      emit_json "{\\"type\\":\\"port_in_use\\",\\"port\\":$REMOTE_PORT}"
    fi
    exit 42
  fi
}

emit_json '{"type":"phase","phase":"checking_port"}'
check_port_conflict

mkdir -p "$BASE_DIR" "$BASE_DIR/run" "$BASE_DIR/logs"

emit_json '{"type":"phase","phase":"checking_node"}'

test_node_candidate() {
  CAND_NODE="$1"
  if [ ! -x "$CAND_NODE" ]; then
    return 1
  fi
  CAND_DIR=$(dirname "$CAND_NODE")
  if [ ! -x "$CAND_DIR/npm" ] && ! command -v npm >/dev/null 2>&1; then
    return 1
  fi
  "$CAND_NODE" -e "const [maj,min]=process.versions.node.split('.').map(Number);process.exit(maj>$NODE_MAJOR_MIN||(maj===$NODE_MAJOR_MIN&&min>=$NODE_MINOR_MIN)?0:1)" >/dev/null 2>&1
}

SELECTED_NODE=""
if [ "$FORCE_INSTALL_NODE" != "1" ]; then
  for CAND in \\
    "$(command -v node 2>/dev/null || true)" \\
    "$BASE_DIR/node/current/bin/node" \\
    "$HOME/.volta/bin/node" \\
    "$HOME/.local/bin/node" \\
    "/usr/local/bin/node" \\
    "/usr/bin/node"
  do
    if [ -n "$CAND" ] && test_node_candidate "$CAND"; then
      SELECTED_NODE="$CAND"
      break
    fi
  done

  if [ -z "$SELECTED_NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    for CAND in $(ls -1d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -V -r); do
      if test_node_candidate "$CAND"; then
        SELECTED_NODE="$CAND"
        break
      fi
    done
  fi

  if [ -z "$SELECTED_NODE" ] && [ -d "$HOME/.local/share/fnm/node-versions" ]; then
    for CAND in $(ls -1d "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -V -r); do
      if test_node_candidate "$CAND"; then
        SELECTED_NODE="$CAND"
        break
      fi
    done
  fi
fi

if [ -z "$SELECTED_NODE" ]; then
  if [ -x "$BASE_DIR/node/current/bin/node" ] && test_node_candidate "$BASE_DIR/node/current/bin/node"; then
    SELECTED_NODE="$BASE_DIR/node/current/bin/node"
  else
    emit_json '{"type":"phase","phase":"installing_node"}'
    RAW_ARCH=$(uname -m)
    case "$RAW_ARCH" in
      x86_64|amd64) NODE_ARCH="x64" ;;
      aarch64|arm64) NODE_ARCH="arm64" ;;
      *)
        emit_json "{\\"type\\":\\"error\\",\\"message\\":\\"Unsupported Linux architecture: $RAW_ARCH\\"}"
        exit 1
        ;;
    esac

    mkdir -p "$BASE_DIR/node"
    NODE_STAGE="$BASE_DIR/node/.staging-$$"
    rm -rf "$NODE_STAGE"
    mkdir -p "$NODE_STAGE"

    TARBALL_NAME="node-$NODE_FALLBACK_VER-linux-$NODE_ARCH.tar.gz"
    DOWNLOADED=0
    for MIRROR_BASE in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
      URL="$MIRROR_BASE/$NODE_FALLBACK_VER/$TARBALL_NAME"
      if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --connect-timeout 15 --max-time 300 "$URL" -o "$NODE_STAGE/node.tar.gz" 2>/dev/null; then
          DOWNLOADED=1
          break
        fi
      elif command -v wget >/dev/null 2>&1; then
        if wget -q -T 30 -O "$NODE_STAGE/node.tar.gz" "$URL" 2>/dev/null; then
          DOWNLOADED=1
          break
        fi
      fi
    done

    if [ "$DOWNLOADED" != "1" ]; then
      rm -rf "$NODE_STAGE"
      emit_json '{"type":"error","message":"Failed to download Node.js distribution for remote host"}'
      exit 1
    fi

    tar -xzf "$NODE_STAGE/node.tar.gz" -C "$NODE_STAGE"
    EXTRACTED_DIR="$NODE_STAGE/node-$NODE_FALLBACK_VER-linux-$NODE_ARCH"
    TARGET_NODE_DIR="$BASE_DIR/node/$NODE_FALLBACK_VER-linux-$NODE_ARCH"
    rm -rf "$TARGET_NODE_DIR"
    mv "$EXTRACTED_DIR" "$TARGET_NODE_DIR"
    ln -sfn "$TARGET_NODE_DIR" "$BASE_DIR/node/current"
    rm -rf "$NODE_STAGE"
    SELECTED_NODE="$BASE_DIR/node/current/bin/node"
  fi
fi

NODE_BIN_DIR=$(dirname "$SELECTED_NODE")
export PATH="$NODE_BIN_DIR:$BASE_DIR/pnpm/bin:$HOME/.local/bin:$PATH"

prune_old_versions() {
  # Keep at most $MAX_VERSIONS version directories in $BASE_DIR, deleting oldest first.
  # Never delete reserved directories (node, run, logs, tmp) or hidden directories.
  Candidates=$(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' ! -name 'node' ! -name 'run' ! -name 'logs' ! -name 'tmp' 2>/dev/null || true)
  if [ -z "$Candidates" ]; then
    return 0
  fi
  COUNT=$(printf '%s\\n' "$Candidates" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$COUNT" -le "$MAX_VERSIONS" ]; then
    return 0
  fi
  TO_DELETE=$((COUNT - MAX_VERSIONS))
  # Sort by mtime ascending, breaking ties by version sort ascending; exclude active VERSION_DIR from deletion
  SORTED_OLDEST=$(
    for D in $Candidates; do
      if [ "$D" = "$VERSION_DIR" ]; then
        continue
      fi
      MTIME=$(stat -c '%Y' "$D" 2>/dev/null || echo 0)
      BNAME=$(basename "$D")
      printf '%012d\\t%s\\t%s\\n' "$MTIME" "$BNAME" "$D"
    done | sort -k1,1n -k2,2V | head -n "$TO_DELETE" | cut -f3
  )
  for OLD_DIR in $SORTED_OLDEST; do
    if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ] && [ "$OLD_DIR" != "$VERSION_DIR" ]; then
      rm -rf "$OLD_DIR"
      OLD_VER=$(basename "$OLD_DIR")
      emit_json "{\\"type\\":\\"version_pruned\\",\\"version\\":\\"$OLD_VER\\"}"
    fi
  done
}

emit_json "{\\"type\\":\\"phase\\",\\"phase\\":\\"checking_dsh\\",\\"version\\":\\"$DSH_VERSION\\"}"

DSH_BIN="$VERSION_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ -f "$VERSION_DIR/.install-complete" ] && [ -f "$DSH_BIN" ]; then
  emit_json "{\\"type\\":\\"dsh_ready\\",\\"version\\":\\"$DSH_VERSION\\",\\"cached\\":true}"
else
  emit_json "{\\"type\\":\\"phase\\",\\"phase\\":\\"installing_dsh\\",\\"version\\":\\"$DSH_VERSION\\"}"
  STAGE_DIR="$BASE_DIR/.staging-$DSH_VERSION-$$"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cat > "$STAGE_DIR/package.json" <<EOF
{
  "name": "dsh-remote-connect-runtime",
  "private": true,
  "version": "1.0.0"
}
EOF

  INSTALLED_OK=0
  for REG in "" "https://registry.npmmirror.com/" "https://registry.npmjs.org/"; do
    if [ -n "$REG" ]; then
      if npm install --prefix "$STAGE_DIR" --registry "$REG" --no-audit --no-fund "$DSH_PACKAGE_SPEC" >/dev/null 2>"$BASE_DIR/logs/npm-install.err"; then
        INSTALLED_OK=1
        break
      fi
    else
      if npm install --prefix "$STAGE_DIR" --no-audit --no-fund "$DSH_PACKAGE_SPEC" >/dev/null 2>"$BASE_DIR/logs/npm-install.err"; then
        INSTALLED_OK=1
        break
      fi
    fi
  done

  if [ "$INSTALLED_OK" != "1" ] || [ ! -f "$STAGE_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
    ERR_TAIL=$(tail -n 5 "$BASE_DIR/logs/npm-install.err" 2>/dev/null | tr '\\n"' '  ' || echo "npm install failed")
    rm -rf "$STAGE_DIR"
    emit_json "{\\"type\\":\\"error\\",\\"message\\":\\"Failed to install @deepseek-ai/dsh@$DSH_VERSION on remote host: $ERR_TAIL\\"}"
    exit 1
  fi

  mkdir -p "$STAGE_DIR/bin"
  cat > "$STAGE_DIR/bin/dsh" <<EOF
#!/bin/sh
export PATH="$NODE_BIN_DIR:\\$PATH"
exec "$SELECTED_NODE" "$VERSION_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" "\\$@"
EOF
  chmod +x "$STAGE_DIR/bin/dsh"
  date +%s > "$STAGE_DIR/.install-complete"

  rm -rf "$VERSION_DIR"
  mv "$STAGE_DIR" "$VERSION_DIR"
  emit_json "{\\"type\\":\\"dsh_ready\\",\\"version\\":\\"$DSH_VERSION\\",\\"cached\\":false}"
fi

prune_old_versions

export DSH_RC_BIN="$DSH_BIN"
export DSH_RC_VERSION="$DSH_VERSION"
export DSH_RC_PROFILE="$PROFILE_NAME"
export DSH_RC_REMOTE_PORT="$REMOTE_PORT"
export DSH_RC_LOCAL_PORT="$LOCAL_PORT"
export DSH_RC_PID_FILE="$BASE_DIR/run/dsh-$REMOTE_PORT.pid"

SUPERVISOR_CODE=$(printf '%s' '${supervisorB64}' | base64 -d)
exec "$SELECTED_NODE" -e "$SUPERVISOR_CODE"
`.trim()

  const encodedScript = Buffer.from(script, 'utf8').toString('base64')
  const sshCommand = `mkdir -p ~/.dsh-remote-connect && printf %s ${encodedScript} | base64 -d > ~/.dsh-remote-connect/.boot-$$.sh && exec sh ~/.dsh-remote-connect/.boot-$$.sh`
  return { script, supervisorJs, sshCommand }
}
