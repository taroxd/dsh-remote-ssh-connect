// Generates the remote POSIX shell + Node.js supervisor scripts executed over SSH
// on the remote Linux host.

import { gzipSync } from 'node:zlib'

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
if [ -z "$PIDS" ] && [ -f "$HOME/.dsh-remote-ssh-connect/run/dsh-$PORT.pid" ]; then
  SAVED_PID=$(cat "$HOME/.dsh-remote-ssh-connect/run/dsh-$PORT.pid" 2>/dev/null || true)
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
rm -f "$HOME/.dsh-remote-ssh-connect/run/dsh-$PORT.pid" 2>/dev/null || true
printf '%s\\n' '${EVENT_PREFIX}{"type":"kill_result","ok":true}'
`
  const normalized = script.replace(/\r\n/g, '\n')
  const encoded = Buffer.from(normalized, 'utf8').toString('base64')
  return `mkdir -p ~/.dsh-remote-ssh-connect && printf %s ${encoded} | base64 -d > ~/.dsh-remote-ssh-connect/.kill-$$.sh && exec sh ~/.dsh-remote-ssh-connect/.kill-$$.sh`
}

/**
 * Build the remote shell script that provisions Node.js and DSH under ~/.dsh-remote-ssh-connect,
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
 * @param {boolean} [options.forceInstallNode] - Force installing Node into ~/.dsh-remote-ssh-connect/node.
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
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

try { fs.unlinkSync(__filename); } catch {}
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const PREFIX = ${JSON.stringify(EVENT_PREFIX)};
const dshBin = process.env.DSH_RC_BIN;
const dshVersion = process.env.DSH_RC_VERSION;
const profile = process.env.DSH_RC_PROFILE;
const remotePort = Number(process.env.DSH_RC_REMOTE_PORT);
const localPort = Number(process.env.DSH_RC_LOCAL_PORT);
const pidFile = process.env.DSH_RC_PID_FILE;
const shippedProfiles = new Set(['web', 'acp', 'headless', 'sdk', 'sdk-minimal', 'desktop']);

function emit(obj) {
  try {
    if (process.stdout.writable && !process.stdout.destroyed) {
      process.stdout.write(PREFIX + JSON.stringify(obj) + '\\n');
    }
  } catch {}
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function canConnectPort(port) {
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

async function checkPortInUse(port) {
  const bindable = await canBindPort(port);
  if (!bindable) return true;
  return await canConnectPort(port);
}

function detectPortOccupant(port) {
  let pid = null;
  let command = null;
  try {
    const ssOut = execSync('ss -tlnp 2>/dev/null || true', { encoding: 'utf8', timeout: 3000 });
    for (const line of ssOut.split(/\\r?\\n/)) {
      if (new RegExp(':' + String(port) + '(?:\\\\b|\\\\s|$)').test(line)) {
        const m = /pid=(\\d+)/.exec(line);
        if (m) {
          pid = Number(m[1]);
          break;
        }
      }
    }
  } catch {}
  if (!pid) {
    try {
      const lsofOut = execSync('lsof -nP -t -iTCP:' + String(port) + ' -sTCP:LISTEN 2>/dev/null || true', { encoding: 'utf8', timeout: 3000 }).trim();
      const first = lsofOut.split(/\\s+/)[0];
      if (/^\\d+$/.test(first)) pid = Number(first);
    } catch {}
  }
  if (!pid && pidFile && fs.existsSync(pidFile)) {
    try {
      const saved = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(saved) && saved > 0) {
        process.kill(saved, 0);
        pid = saved;
      }
    } catch {}
  }
  if (pid) {
    try {
      const rawCmd = fs.readFileSync('/proc/' + String(pid) + '/cmdline', 'utf8');
      command = rawCmd.replace(/[\\x00\\r\\n]+/g, ' ').trim().slice(0, 200) || null;
    } catch {}
  }
  return { pid, command };
}

(async () => {
  const inUse = await checkPortInUse(remotePort);
  if (inUse) {
    const occ = detectPortOccupant(remotePort);
    emit({
      type: 'port_in_use',
      port: remotePort,
      ...(occ.pid ? { pid: occ.pid } : {}),
      ...(occ.command ? { command: occ.command } : {}),
    });
    process.exit(42);
  }

  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.HOME || '', '.dsh');
  const profileManifest = path.join(dshHome, 'profiles', profile, 'package.json');
  const isShipped = shippedProfiles.has(profile.toLowerCase());
  const profileExists = fs.existsSync(profileManifest);
  const needsInit = !isShipped && !profileExists;

  const baseArgs = [
    dshBin,
    '--profile',
    profile,
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

  let child = null;
  let shuttingDown = false;
  let restartingChild = false;
  let readyEmitted = false;
  let remoteLaunchToken = null;
  let remoteAuthCookie = null;
  let rpcCallSeq = 0;
  let lastPingAt = Date.now();
  const initialPpid = process.ppid;

  function cleanupPidFile() {
    if (pidFile) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
  }

  function forceKillChildSync() {
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }
    cleanupPidFile();
  }

  process.on('exit', () => {
    forceKillChildSync();
  });

  function terminateChild(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child && child.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      emit({ type: 'stopping', reason });
      setTimeout(() => {
        forceKillChildSync();
        emit({ type: 'stopped', reason });
        process.exit(0);
      }, 800);
    } else {
      cleanupPidFile();
      emit({ type: 'stopped', reason });
      process.exit(0);
    }
  }

  const watchdogTimer = setInterval(() => {
    if (
      process.ppid === 1 ||
      (initialPpid > 1 && process.ppid !== initialPpid) ||
      process.stdin.destroyed ||
      process.stdin.readableEnded ||
      Date.now() - lastPingAt > 45_000
    ) {
      clearInterval(watchdogTimer);
      terminateChild('ssh_connection_lost');
    }
  }, 2000);
  watchdogTimer.unref();

  const dshInstallDir = path.dirname(path.dirname(dshBin));
  process.env.DSH_INSTALL_DIR = dshInstallDir;

  async function recoverIdlePlugins() {
    try {
      const [bundlesRes, pluginsRes] = await Promise.all([
        callRemotePluginManager('listBundles', {}, 10_000),
        callRemotePluginManager('listPlugins', {}, 10_000),
      ]);
      const bundles = (bundlesRes && bundlesRes.ok && Array.isArray(bundlesRes.value)) ? bundlesRes.value : [];
      const plugins = (pluginsRes && pluginsRes.ok && Array.isArray(pluginsRes.value)) ? pluginsRes.value : [];
      const pluginsById = new Map();
      for (const p of plugins) {
        if (p && typeof p.entryId === 'string') pluginsById.set(p.entryId, p);
        if (p && typeof p.patchId === 'string') pluginsById.set(p.patchId, p);
      }
      for (const b of bundles) {
        if (!b || !b.enabled || !b.installed || b.official) continue;
        const rows = Array.isArray(b.rows) ? b.rows : [];
        const needsRecovery = rows.some((r) => {
          const live = pluginsById.get(r.entryId) || pluginsById.get(r.rowId);
          return !live || (live.enabled && (live.fiberPhase === null || live.fiberPhase === 'failed'));
        });
        if (needsRecovery) {
          await callRemotePluginManager('setBundleEnabled', { name: b.name, enabled: false }, 15_000);
          await callRemotePluginManager('setBundleEnabled', { name: b.name, enabled: true }, 15_000);
        }
      }
    } catch {}
  }

  function spawnDshChild(withInitFlag) {
    return new Promise((resolveReady) => {
      let settledReady = false;
      const launchArgs = withInitFlag
        ? [dshBin, '--profile', profile, '--from-default-profile', 'web', ...baseArgs.slice(3)]
        : baseArgs;

      const proc = spawn(process.execPath, launchArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          DSH_INSTALL_DIR: dshInstallDir,
          NO_COLOR: '1',
        },
      });
      child = proc;

      if (proc.pid && pidFile) {
        try {
          fs.mkdirSync(path.dirname(pidFile), { recursive: true });
          fs.writeFileSync(pidFile, String(proc.pid) + '\\n');
        } catch {}
      }

      const startupTimeout = setTimeout(async () => {
        if (settledReady || shuttingDown) return;
        const occ = detectPortOccupant(remotePort);
        if (occ.pid && occ.pid !== proc.pid) {
          settledReady = true;
          emit({
            type: 'port_in_use',
            port: remotePort,
            pid: occ.pid,
            ...(occ.command ? { command: occ.command } : {}),
          });
          forceKillChildSync();
          process.exit(42);
        }
      }, 20_000);
      startupTimeout.unref();

      function onLine(line, streamName) {
        const trimmed = line.trim();
        if (!trimmed) return;
        const urlMatch = /^dsh web:\\s*(https?:\\/\\/\\S+)/i.exec(trimmed);
        if (urlMatch) {
          clearTimeout(startupTimeout);
          let finalUrl = urlMatch[1];
          try {
            const parsed = new URL(finalUrl);
            const tok = parsed.searchParams.get('token');
            if (tok) {
              remoteLaunchToken = tok;
              remoteAuthCookie = null;
            }
            parsed.protocol = 'http:';
            parsed.hostname = '127.0.0.1';
            parsed.port = String(localPort);
            finalUrl = parsed.href;
          } catch {}
          Promise.resolve(recoverIdlePlugins()).finally(() => {
            readyEmitted = true;
            emit({
              type: 'ready',
              url: finalUrl,
              remotePort,
              localPort,
              profile,
              version: dshVersion,
              pid: proc.pid,
              initializedFromWeb: needsInit,
            });
            if (!settledReady) {
              settledReady = true;
              resolveReady(true);
            }
          });
          return;
        }
        if (/EADDRINUSE|address already in use/i.test(trimmed)) {
          clearTimeout(startupTimeout);
          const occ = detectPortOccupant(remotePort);
          const occPid = (occ.pid && occ.pid !== proc.pid) ? occ.pid : null;
          emit({
            type: 'port_in_use',
            port: remotePort,
            ...(occPid ? { pid: occPid } : {}),
            ...(occPid && occ.command ? { command: occ.command } : {}),
            detail: trimmed,
          });
          if (!restartingChild) {
            forceKillChildSync();
            process.exit(42);
          }
          return;
        }
        emit({ type: 'log', stream: streamName, line: trimmed });
      }

      readline.createInterface({ input: proc.stdout }).on('line', (l) => onLine(l, 'stdout'));
      readline.createInterface({ input: proc.stderr }).on('line', (l) => onLine(l, 'stderr'));

      proc.on('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        if (!settledReady) {
          settledReady = true;
          resolveReady(false);
        }
        if (restartingChild) return;
        cleanupPidFile();
        if (!shuttingDown) {
          emit({ type: 'dsh_exit', code, signal });
          process.exit(code ?? 1);
        }
        emit({ type: 'stopped', reason: 'child_exit' });
        process.exit(0);
      });
    });
  }

  async function restartDshChild() {
    if (shuttingDown) return;
    restartingChild = true;
    try {
      const prev = child;
      if (prev && prev.pid && prev.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (prev.exitCode === null) {
              try { process.kill(-prev.pid, 'SIGKILL'); } catch {}
              try { prev.kill('SIGKILL'); } catch {}
            }
          }, 2000);
          prev.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          try { process.kill(-prev.pid, 'SIGTERM'); } catch {}
          try { prev.kill('SIGTERM'); } catch {}
        });
      }
      await Promise.race([
        spawnDshChild(false),
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
    } finally {
      restartingChild = false;
    }
  }

  void spawnDshChild(needsInit);

  const homeDir = process.env.HOME || '';
  const baseDir = path.join(homeDir, '.dsh-remote-ssh-connect');
  const profileDir = path.join(dshHome, 'profiles', profile);
  const rpcChunks = new Map();

  async function ensureRemoteAuthCookie() {
    if (remoteAuthCookie) return remoteAuthCookie;
    if (!remoteLaunchToken || typeof fetch !== 'function') return null;
    try {
      const authRes = await fetch('http://127.0.0.1:' + String(remotePort) + '/?token=' + encodeURIComponent(remoteLaunchToken), {
        method: 'GET',
        redirect: 'manual',
        headers: { host: '127.0.0.1:' + String(remotePort) },
        signal: AbortSignal.timeout(10_000),
      });
      const setCookies = typeof authRes.headers?.getSetCookie === 'function'
        ? authRes.headers.getSetCookie()
        : (authRes.headers?.get?.('set-cookie') ? [authRes.headers.get('set-cookie')] : []);
      for (const rawCookie of setCookies) {
        const pair = String(rawCookie).split(';')[0].trim();
        if (pair.startsWith('dsh-auth-')) {
          remoteAuthCookie = pair;
          return remoteAuthCookie;
        }
      }
    } catch {}
    return null;
  }

  async function callRemotePluginManager(method, args = {}, timeoutMs = 300_000) {
    if (!remoteLaunchToken || shuttingDown || typeof fetch !== 'function') return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cookie = await ensureRemoteAuthCookie();
      if (!cookie) return null;
      try {
        const rpcId = 'rc-' + String(++rpcCallSeq);
        const res = await fetch('http://127.0.0.1:' + String(remotePort) + '/api/pluginManager/' + method, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:' + String(remotePort),
            'content-type': 'application/json',
            cookie,
          },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: 'pluginManager/' + method,
            payload: { args },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 || res.status === 403) {
          remoteAuthCookie = null;
          continue;
        }
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.result && data.result.ok === true) {
          return { ok: true, value: data.result.value };
        }
        if (data && data.result && data.result.ok === false) {
          return { ok: false, error: data.result.error };
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function runCommandAsync(cmd, cmdArgs, timeoutMs = 300_000) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const proc = spawn(cmd, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { proc.kill('SIGKILL'); } catch {}
          resolve({ status: 1, stdout, stderr: stderr + '\\nOperation timed out' });
        }
      }, timeoutMs);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.once('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ status: 1, stdout, stderr: String(err && err.message ? err.message : err) });
        }
      });
      proc.once('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ status: code ?? 1, stdout, stderr });
        }
      });
    });
  }

  async function ensureRemotePnpm() {
    const check = await runCommandAsync('sh', ['-c', 'command -v pnpm'], 10_000);
    if (check.status === 0 && check.stdout.trim()) return;
    const pnpmPrefix = path.join(baseDir, 'pnpm');
    fs.mkdirSync(pnpmPrefix, { recursive: true });
    for (const reg of ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/']) {
      const res = await runCommandAsync('npm', ['install', '--prefix', pnpmPrefix, '-g', 'pnpm', '--registry', reg, '--no-audit', '--no-fund'], 120_000);
      if (res.status === 0) break;
    }
    process.env.PATH = path.join(pnpmPrefix, 'bin') + ':' + (process.env.PATH || '');
  }

  function classifyRecordedSpec(spec) {
    if (!spec || typeof spec !== 'string') return null;
    const s = spec.trim();
    if (/^(?:file|link):/i.test(s) || s.startsWith('/') || /^\\.{1,2}(?:[\\\\/]|$)/.test(s)) return 'local';
    if (/^(?:github|gitlab|bitbucket|gist):/i.test(s) || /^git(?:\\+[a-z]+)?:\\/\\/|^git@[^:]+:/i.test(s) || /^https?:\\/\\/[^/]+\\/[^/]+\\/[^/#]+(?:\\.git)?(?:#.*)?$/i.test(s)) return 'github';
    return 'npm';
  }

  function handleCheckPlugin(params) {
    const pkgName = String(params && params.packageName ? params.packageName : '');
    const profileManifestPath = path.join(profileDir, 'package.json');
    let installed = false;
    let remoteVersion = null;
    let recordedSpec = null;
    let remoteSourceKind = null;

    if (fs.existsSync(profileManifestPath)) {
      try {
        const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
        const deps = pm.dependencies || {};
        const bundles = (pm.dsh && pm.dsh.profile && pm.dsh.profile.bundles) || [];
        if (Object.prototype.hasOwnProperty.call(deps, pkgName) || bundles.includes(pkgName)) {
          installed = true;
          recordedSpec = deps[pkgName] || null;
          remoteSourceKind = classifyRecordedSpec(recordedSpec);
        }
      } catch {}
    }

    const pkgManifestPath = path.join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json');
    if (fs.existsSync(pkgManifestPath)) {
      try {
        const pkgM = JSON.parse(fs.readFileSync(pkgManifestPath, 'utf8'));
        installed = true;
        if (typeof pkgM.version === 'string') {
          remoteVersion = pkgM.version.trim();
        }
      } catch {}
    }

    return {
      packageName: pkgName,
      installed,
      remoteVersion,
      recordedSpec,
      remoteSourceKind,
    };
  }

  function handleListPlugins() {
    const profileManifestPath = path.join(profileDir, 'package.json');
    const builtinBundles = new Set([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-acp-app',
      '@deepseek-ai/dsh-sdk-app',
      '@deepseek-ai/dsh-sdk-minimal',
    ]);
    if (!fs.existsSync(profileManifestPath)) {
      return { plugins: [] };
    }
    let pm;
    try {
      pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
    } catch {
      return { plugins: [] };
    }
    const deps = pm.dependencies || {};
    const enabledSet = new Set((pm.dsh && pm.dsh.profile && pm.dsh.profile.bundles) || []);
    const plugins = [];
    for (const [pkgName, recordedSpec] of Object.entries(deps)) {
      if (builtinBundles.has(pkgName)) continue;
      const pkgManifestPath = path.join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json');
      let pkgM = null;
      if (fs.existsSync(pkgManifestPath)) {
        try {
          pkgM = JSON.parse(fs.readFileSync(pkgManifestPath, 'utf8'));
        } catch {}
      }
      if (pkgM && (!pkgM.dsh || !pkgM.dsh.bundle)) continue;
      const pkgDir = path.dirname(pkgManifestPath);
      let zhTitle = pkgName;
      let enTitle = pkgName;
      try {
        const zhJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'));
        if (zhJson && zhJson.meta && zhJson.meta.title) zhTitle = zhJson.meta.title;
      } catch {}
      try {
        const enJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale', 'en.json'), 'utf8'));
        if (enJson && enJson.meta && enJson.meta.title) enTitle = enJson.meta.title;
      } catch {}
      plugins.push({
        name: pkgName,
        version: (pkgM && pkgM.version) ? String(pkgM.version).trim() : '0.0.0',
        title: { zh: zhTitle, en: enTitle },
        enabled: enabledSet.has(pkgName),
        hasClientUi: Boolean(pkgM && pkgM.dsh && pkgM.dsh.client),
        sourceKind: classifyRecordedSpec(recordedSpec) || 'npm',
      });
    }
    return { plugins };
  }

  async function handleInstallPlugin(reqId, params) {
    const pkgName = String(params.packageName || '');
    const sourceKind = String(params.sourceKind || 'npm');
    const localSubkind = String(params.localSubkind || 'directory');
    const localLinkPrefix = String(params.localLinkPrefix || 'link');
    const installSpec = String(params.installSpec || '');
    const tarballFilename = String(params.tarballFilename || 'plugin.tgz');
    const reinstall = Boolean(params.reinstall);
    const safeSlug = pkgName.replace(/[^A-Za-z0-9._-]/g, '_');

    const rawBase64 = (rpcChunks.get(reqId) || []).join('');
    rpcChunks.delete(reqId);

    await ensureRemotePnpm();

    const runDshPlugin = (pluginArgs) => runCommandAsync(process.execPath, [dshBin, 'plugin', '--profile', profile, ...pluginArgs], 300_000);
    const registries = ['https://registry.npmmirror.com/', null, 'https://registry.npmjs.org/'];
    const profileManifestPath = path.join(profileDir, 'package.json');
    const profileNpmrcPath = path.join(profileDir, '.npmrc');
    if (fs.existsSync(profileDir) && !fs.existsSync(profileNpmrcPath)) {
      try {
        fs.writeFileSync(profileNpmrcPath, [
          'registry=https://registry.npmmirror.com/',
          'auto-install-peers=false',
          'fetch-timeout=15000',
          'fetch-retries=1',
          '',
        ].join('\\n'));
      } catch {}
    }
    const nodeModulesPkgDir = path.join(profileDir, 'node_modules', ...pkgName.split('/'));

    function isPluginStillInProfile() {
      if (fs.existsSync(path.join(nodeModulesPkgDir, 'package.json'))) return true;
      if (!fs.existsSync(profileManifestPath)) return false;
      try {
        const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
        const deps = pm.dependencies || {};
        const bundles = (pm.dsh && pm.dsh.profile && Array.isArray(pm.dsh.profile.bundles)) ? pm.dsh.profile.bundles : [];
        return Object.prototype.hasOwnProperty.call(deps, pkgName) || bundles.includes(pkgName);
      } catch {
        return false;
      }
    }

    // 1. Materialize local plugin files first (before removing existing copy)
    let targetSpec = installSpec;
    if (sourceKind === 'local') {
      if (!rawBase64) {
        throw new Error('Empty payload received for local plugin sync');
      }
      const stdinBuf = Buffer.from(rawBase64, 'base64');
      const localPluginsRoot = path.join(baseDir, 'local-plugins');
      fs.mkdirSync(localPluginsRoot, { recursive: true });

      if (localSubkind === 'tarball') {
        const baseName = path.basename(tarballFilename).replace(/[^A-Za-z0-9._-]/g, '_');
        const destTarball = path.join(localPluginsRoot, baseName.startsWith(safeSlug) ? baseName : (safeSlug + '-' + baseName));
        fs.writeFileSync(destTarball, stdinBuf);
        targetSpec = 'file:' + destTarball;
      } else {
        const destDir = path.join(localPluginsRoot, safeSlug);
        const resolvedDest = path.resolve(destDir);
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        const unpacked = JSON.parse(zlib.gunzipSync(stdinBuf).toString('utf8'));
        for (const fileEntry of unpacked.files || []) {
          const rel = String(fileEntry.path || '').replace(/^\\/+/, '');
          if (!rel || rel.includes('..')) continue;
          const fullPath = path.resolve(destDir, ...rel.split('/'));
          if (fullPath !== resolvedDest && !fullPath.startsWith(resolvedDest + path.sep)) continue;
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, Buffer.from(fileEntry.data, 'base64'), {
            mode: fileEntry.mode || 0o644,
          });
        }
        const destPkgPath = path.join(destDir, 'package.json');
        if (fs.existsSync(destPkgPath)) {
          try {
            const destPkg = JSON.parse(fs.readFileSync(destPkgPath, 'utf8'));
            const hasDeps = (destPkg.dependencies && Object.keys(destPkg.dependencies).length > 0) ||
              (destPkg.optionalDependencies && Object.keys(destPkg.optionalDependencies).length > 0);
            if (hasDeps) {
              for (const reg of registries) {
                const depRes = await runCommandAsync('pnpm', [
                  '--dir',
                  destDir,
                  'install',
                  '--prod',
                  '--ignore-scripts',
                  '--no-frozen-lockfile',
                  '--config.auto-install-peers=false',
                  '--config.fetch-timeout=15000',
                  '--config.fetch-retries=1',
                  ...(reg ? ['--registry=' + reg] : []),
                ], 60_000);
                if (depRes.status === 0) break;
              }
            }
          } catch {}
        }
        targetSpec = 'file:' + destDir;
      }
    }

    // 2. If already installed on remote, unload and remove via live PluginManager first, with CLI fallback
    let needsRestart = false;
    if (reinstall || isPluginStillInProfile()) {
      const apiRm = await callRemotePluginManager('removeBundle', { name: pkgName });
      if (apiRm && apiRm.ok && apiRm.value && apiRm.value.application === 'restart-required') {
        needsRestart = true;
      }

      if (isPluginStillInProfile()) {
        if (remoteLaunchToken) {
          await callRemotePluginManager('setBundleEnabled', { name: pkgName, enabled: false });
        }
        if (fs.existsSync(profileManifestPath)) {
          try {
            const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
            if (pm.dsh && pm.dsh.profile && Array.isArray(pm.dsh.profile.bundles)) {
              const nextBundles = pm.dsh.profile.bundles.filter((b) => b !== pkgName);
              if (nextBundles.length !== pm.dsh.profile.bundles.length) {
                pm.dsh.profile.bundles = nextBundles;
                fs.writeFileSync(profileManifestPath, JSON.stringify(pm, null, 2) + '\\n');
              }
            }
          } catch {}
        }
        for (const reg of registries) {
          const rmRes = await runDshPlugin(['remove', pkgName, ...(reg ? ['--config.registry=' + reg] : [])]);
          if (rmRes.status === 0) break;
        }
        // Clean up any stubborn leftover dependency or node_modules entry so add starts cleanly
        if (fs.existsSync(profileManifestPath)) {
          try {
            const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
            let modified = false;
            if (pm.dependencies && Object.prototype.hasOwnProperty.call(pm.dependencies, pkgName)) {
              delete pm.dependencies[pkgName];
              modified = true;
            }
            if (pm.dsh && pm.dsh.profile && Array.isArray(pm.dsh.profile.bundles) && pm.dsh.profile.bundles.includes(pkgName)) {
              pm.dsh.profile.bundles = pm.dsh.profile.bundles.filter((b) => b !== pkgName);
              modified = true;
            }
            if (modified) {
              fs.writeFileSync(profileManifestPath, JSON.stringify(pm, null, 2) + '\\n');
            }
          } catch {}
        }
        try {
          fs.rmSync(nodeModulesPkgDir, { recursive: true, force: true });
        } catch {}
      }
    }

    // 3. Install via live PluginManager first so HMR and Web UI update immediately, falling back to CLI
    let installedViaApi = false;
    let lastApiError = null;
    if (remoteLaunchToken) {
      const baseInstallOpts = {
        enabled: true,
        ...(sourceKind === 'npm' ? { saveExact: true } : {}),
      };
      for (const reg of ['https://registry.npmmirror.com/', undefined, 'https://registry.npmjs.org/']) {
        const opts = reg === undefined ? baseInstallOpts : { ...baseInstallOpts, registry: reg };
        const apiAdd = await callRemotePluginManager('installBundle', {
          spec: targetSpec,
          options: opts,
        });
        if (!apiAdd) break;
        if (apiAdd.ok && apiAdd.value) {
          let val = apiAdd.value;
          if (val.application === 'failed' && Array.isArray(val.pendingBuilds) && val.pendingBuilds.length > 0) {
            const retryBuild = await callRemotePluginManager('installBundle', {
              spec: targetSpec,
              options: { ...opts, approvedBuilds: val.pendingBuilds },
            });
            if (retryBuild && retryBuild.ok && retryBuild.value) {
              val = retryBuild.value;
            }
          }
          if (val.application === 'applied' || val.application === 'restart-required' || val.application === 'overridden') {
            installedViaApi = true;
            if (val.application === 'restart-required') needsRestart = true;
            break;
          }
          lastApiError = (val.packageResult && val.packageResult.output) || (val.error && (val.error.diagnostic || val.error.code)) || 'installBundle failed';
          const pkgKind = val.packageResult && val.packageResult.kind;
          if (val.failedAt !== 'registry' && pkgKind !== 'network' && pkgKind !== 'timeout' && pkgKind !== 'not-found' && pkgKind !== 'no-matching-version') {
            break;
          }
        } else {
          lastApiError = (apiAdd.error && apiAdd.error.message) || 'installBundle RPC failed';
          break;
        }
      }
    }

    if (!installedViaApi) {
      let addRes = null;
      for (const reg of registries) {
        const addArgs = [
          'add',
          targetSpec,
          ...(sourceKind === 'npm' ? ['--save-exact'] : []),
          ...(reg ? ['--registry=' + reg] : []),
        ];
        addRes = await runDshPlugin(addArgs);
        if (addRes.status === 0) break;
        const out = ((addRes && addRes.stderr) || '') + '\\n' + ((addRes && addRes.stdout) || '');
        if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(out) || sourceKind === 'github') {
          const wsPath = path.join(profileDir, 'pnpm-workspace.yaml');
          if (fs.existsSync(wsPath)) {
            const wsContent = fs.readFileSync(wsPath, 'utf8');
            if (!wsContent.includes('dangerouslyAllowAllBuilds')) {
              fs.writeFileSync(wsPath, wsContent.trimEnd() + '\\ndangerouslyAllowAllBuilds: true\\n');
              addRes = await runDshPlugin(addArgs);
              if (addRes.status === 0) break;
            }
          }
        }
      }

      if (!addRes || addRes.status !== 0) {
        const errOut = ((addRes && (addRes.stderr || addRes.stdout)) || lastApiError || 'dsh plugin add failed').trim();
        throw new Error(errOut);
      }

      if (remoteLaunchToken) {
        const enableRes = await callRemotePluginManager('setBundleEnabled', { name: pkgName, enabled: true });
        if (!enableRes || !enableRes.ok || !enableRes.value || enableRes.value.application === 'restart-required' || enableRes.value.application === 'failed') {
          needsRestart = true;
        } else {
          installedViaApi = true;
        }
      }

      if (fs.existsSync(profileManifestPath)) {
        try {
          const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
          pm.dsh = pm.dsh || {};
          pm.dsh.profile = pm.dsh.profile || {};
          const bundles = Array.isArray(pm.dsh.profile.bundles) ? pm.dsh.profile.bundles : [];
          if (!bundles.includes(pkgName)) {
            bundles.push(pkgName);
            pm.dsh.profile.bundles = bundles;
            fs.writeFileSync(profileManifestPath, JSON.stringify(pm, null, 2) + '\\n');
            needsRestart = true;
          }
        } catch {}
      }
    }

    if (needsRestart && remoteLaunchToken) {
      await restartDshChild();
    }

    let installedVersion = null;
    const pkgManifestPath = path.join(nodeModulesPkgDir, 'package.json');
    if (fs.existsSync(pkgManifestPath)) {
      try {
        const pkgM = JSON.parse(fs.readFileSync(pkgManifestPath, 'utf8'));
        installedVersion = pkgM.version || null;
      } catch {}
    }

    return {
      packageName: pkgName,
      installedVersion,
      sourceKind,
      reinstalled: reinstall,
      appliedViaPluginManager: installedViaApi,
    };
  }

  process.stdin.setEncoding('utf8');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const cmd = line.trim();
    if (!cmd) return;
    if (cmd === 'SHUTDOWN') {
      terminateChild('client_shutdown');
      return;
    }
    if (cmd === 'PING') {
      lastPingAt = Date.now();
      emit({ type: 'pong', ts: lastPingAt });
      return;
    }
    if (cmd.startsWith('RPC_CHUNK:')) {
      try {
        const chunkObj = JSON.parse(cmd.slice('RPC_CHUNK:'.length));
        if (chunkObj && chunkObj.id && typeof chunkObj.data === 'string') {
          if (!rpcChunks.has(chunkObj.id)) rpcChunks.set(chunkObj.id, []);
          rpcChunks.get(chunkObj.id).push(chunkObj.data);
        }
      } catch {}
      return;
    }
    if (cmd.startsWith('RPC:')) {
      let req;
      try {
        req = JSON.parse(cmd.slice('RPC:'.length));
      } catch {
        return;
      }
      if (!req || !req.id) return;
      Promise.resolve().then(async () => {
        if (req.method === 'check_plugin') {
          return handleCheckPlugin(req.params || {});
        }
        if (req.method === 'list_plugins') {
          return handleListPlugins();
        }
        if (req.method === 'install_plugin') {
          return await handleInstallPlugin(req.id, req.params || {});
        }
        throw new Error('Unknown RPC method: ' + String(req.method));
      }).then(
        (value) => emit({ type: 'rpc_result', id: req.id, ok: true, value }),
        (err) => {
          rpcChunks.delete(req.id);
          emit({ type: 'rpc_result', id: req.id, ok: false, error: String(err && err.message ? err.message : err) });
        },
      );
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

  const script = `
${LOGIN_ENV_PREAMBLE}
set -e

PREFIX='${EVENT_PREFIX}'
BASE_DIR="$HOME/.dsh-remote-ssh-connect"
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
  SS_OUT=""
  if command -v ss >/dev/null 2>&1; then
    SS_PROC=$(ss -tlnp 2>/dev/null | grep -E ":$REMOTE_PORT[[:space:]]" || true)
    if [ -n "$SS_PROC" ]; then
      SS_OUT="listening"
      OCCUPANT_PID=$(printf '%s\\n' "$SS_PROC" | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
    fi
  fi
  if [ -z "$SS_OUT" ] && command -v lsof >/dev/null 2>&1; then
    OCCUPANT_PID=$(lsof -t -iTCP:"$REMOTE_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
      SS_OUT="listening"
    fi
  fi
  if [ -z "$SS_OUT" ] && command -v fuser >/dev/null 2>&1; then
    OCCUPANT_PID=$(fuser "$REMOTE_PORT/tcp" 2>/dev/null | tr ' ' '\\n' | grep -E '^[0-9]+$' | head -n 1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
      SS_OUT="listening"
    fi
  fi

  if [ -n "$SS_OUT" ]; then
    if [ -n "$OCCUPANT_PID" ] && [ -r "/proc/$OCCUPANT_PID/cmdline" ]; then
      OCCUPANT_CMD=$(tr '\\0\\n\\r\\\\"' '     ' < "/proc/$OCCUPANT_PID/cmdline" | tr -cd '\\40-\\176' | cut -c1-200 | sed 's/[[:space:]]*$//' || true)
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
  "name": "dsh-remote-ssh-connect-runtime",
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
    ERR_TAIL=$(tail -n 5 "$BASE_DIR/logs/npm-install.err" 2>/dev/null | tr '\\n\\r\\\\"' '    ' | tr -cd '\\40-\\176' | cut -c1-300 || echo "npm install failed")
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

export DSH_INSTALL_DIR="$VERSION_DIR/node_modules/@deepseek-ai/dsh"
export DSH_RC_BIN="$DSH_BIN"
export DSH_RC_VERSION="$DSH_VERSION"
export DSH_RC_PROFILE="$PROFILE_NAME"
export DSH_RC_REMOTE_PORT="$REMOTE_PORT"
export DSH_RC_LOCAL_PORT="$LOCAL_PORT"
export DSH_RC_PID_FILE="$BASE_DIR/run/dsh-$REMOTE_PORT.pid"

SUPERVISOR_FILE="$BASE_DIR/run/.sup-$$.cjs"
cat > "$SUPERVISOR_FILE" << 'DSH_RC_SUPERVISOR_EOF'
${supervisorJs}
DSH_RC_SUPERVISOR_EOF
exec "$SELECTED_NODE" "$SUPERVISOR_FILE"
`.trim()

  const normalizedSupervisor = supervisorJs.replace(/\r\n/g, '\n')
  const normalizedScript = script.replace(/\r\n/g, '\n')
  const encodedScript = gzipSync(Buffer.from(normalizedScript, 'utf8')).toString('base64')
  const sshCommand = 'mkdir -p ~/.dsh-remote-ssh-connect && IFS= read -r B && printf %s "$B" | base64 -d | gzip -d > ~/.dsh-remote-ssh-connect/.boot-$$.sh && exec sh ~/.dsh-remote-ssh-connect/.boot-$$.sh'
  return { script: normalizedScript, supervisorJs: normalizedSupervisor, encodedScript, sshCommand }
}
