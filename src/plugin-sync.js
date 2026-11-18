// Local plugin discovery and remote plugin synchronization (npm / GitHub / local source).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { EVENT_PREFIX, LOGIN_ENV_PREAMBLE } from './remote-script.js'

const BUILTIN_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i
const HOSTED_REPO_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i
const TARBALL_EXT = /\.(?:tgz|tar\.gz)$/i
const HTTP_USER_INFO = /^((?:git\+)?https?:\/\/)[^/]*@/i

function parseSemver(versionStr) {
  const cleaned = String(versionStr ?? '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Compare two version strings using SemVer 2.0.0 rules.
 * Returns `1` if `vA > vB`, `-1` if `vA < vB`, and `0` if `vA === vB`.
 * @param {string} vA
 * @param {string} vB
 * @returns {-1 | 0 | 1}
 */
export function comparePluginVersions(vA, vB) {
  const aStr = String(vA ?? '').trim()
  const bStr = String(vB ?? '').trim()
  if (aStr === bStr) return 0

  const a = parseSemver(aStr)
  const b = parseSemver(bStr)
  if (!a || !b) {
    const cmp = aStr.localeCompare(bStr, undefined, { numeric: true, sensitivity: 'base' })
    return cmp > 0 ? 1 : cmp < 0 ? -1 : 0
  }

  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1

  // Normal version has higher precedence than prerelease
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const idA = a.prerelease[i]
    const idB = b.prerelease[i]
    if (idA === undefined) return -1
    if (idB === undefined) return 1
    if (idA === idB) continue
    const numA = /^\d+$/.test(idA)
    const numB = /^\d+$/.test(idB)
    if (numA && numB) {
      const nA = Number(idA)
      const nB = Number(idB)
      if (nA !== nB) return nA > nB ? 1 : -1
    } else if (numA && !numB) {
      return -1
    } else if (!numA && numB) {
      return 1
    } else {
      return idA > idB ? 1 : -1
    }
  }
  return 0
}

/**
 * Classify how a plugin dependency in `<profileDir>/package.json` was installed.
 * @param {string} packageName
 * @param {string} recordedSpec
 * @param {string} profileDir
 * @returns {{
 *   sourceKind: 'npm' | 'github' | 'local',
 *   localSubkind?: 'directory' | 'tarball',
 *   localLinkPrefix?: 'link' | 'file',
 *   localPath?: string,
 *   installSpec: string,
 *   recordedSpec: string,
 * }}
 */
export function classifyInstallSource(packageName, recordedSpec, profileDir) {
  const raw = String(recordedSpec ?? '').trim()
  const localMatch = /^(file|link):(.*)$/i.exec(raw)
  if (localMatch) {
    const prefix = localMatch[1].toLowerCase()
    const rawTarget = localMatch[2].trim().replace(/^~(?=$|[\\/])/, () => homedir())
    const resolvedPath = isAbsolute(rawTarget) ? rawTarget : resolve(profileDir, rawTarget)
    const isTarball = TARBALL_EXT.test(resolvedPath)
    return {
      sourceKind: 'local',
      localSubkind: isTarball ? 'tarball' : 'directory',
      localLinkPrefix: prefix === 'file' ? 'file' : 'link',
      localPath: resolvedPath,
      installSpec: `${prefix}:${resolvedPath}`,
      recordedSpec: raw,
    }
  }

  if (isAbsolute(raw) || /^\.{1,2}(?:[\\/]|$)/.test(raw)) {
    const resolvedPath = isAbsolute(raw) ? raw : resolve(profileDir, raw)
    const isTarball = TARBALL_EXT.test(resolvedPath)
    return {
      sourceKind: 'local',
      localSubkind: isTarball ? 'tarball' : 'directory',
      localLinkPrefix: isTarball ? 'file' : 'link',
      localPath: resolvedPath,
      installSpec: resolvedPath,
      recordedSpec: raw,
    }
  }

  if ((GIT_SHORTHAND.test(raw) || GIT_URL.test(raw) || HOSTED_REPO_URL.test(raw)) && !TARBALL_EXT.test(raw)) {
    const cleanGit = raw.replace(HTTP_USER_INFO, '$1')
    return {
      sourceKind: 'github',
      installSpec: cleanGit,
      recordedSpec: raw,
    }
  }

  const npmRange = raw.replace(/^npm:/i, '')
  const spec = npmRange.includes('@') && !npmRange.startsWith('@')
    ? npmRange
    : `${packageName}@${npmRange}`
  return {
    sourceKind: 'npm',
    installSpec: spec,
    recordedSpec: raw,
  }
}

/**
 * Resolve the local profile directory.
 * @param {object} [options]
 * @param {string} [options.profileDir]
 * @param {string} [options.homeDir]
 * @returns {string}
 */
export function resolveLocalProfileDir(options = {}) {
  if (options.profileDir) return resolve(options.profileDir)
  if (process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim() !== '') {
    return resolve(process.env.DSH_PROFILE_DIR.trim())
  }
  const home = options.homeDir
    ?? (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh'))
  const profileName = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  return join(resolve(home), 'profiles', profileName)
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readLocalizedMeta(pkgDir, pkgManifest) {
  const fallbackTitle = pkgManifest?.name || basename(pkgDir)
  const fallbackDesc = pkgManifest?.description || ''
  const zhJson = readJsonSafe(join(pkgDir, 'locale', 'zh.json'))
  const enJson = readJsonSafe(join(pkgDir, 'locale', 'en.json'))
  return {
    title: {
      zh: typeof zhJson?.meta?.title === 'string' && zhJson.meta.title.trim() ? zhJson.meta.title.trim() : fallbackTitle,
      en: typeof enJson?.meta?.title === 'string' && enJson.meta.title.trim() ? enJson.meta.title.trim() : fallbackTitle,
    },
    description: {
      zh: typeof zhJson?.meta?.description === 'string' ? zhJson.meta.description.trim() : fallbackDesc,
      en: typeof enJson?.meta?.description === 'string' ? enJson.meta.description.trim() : fallbackDesc,
    },
  }
}

/**
 * List user-installed plugins (bundles) in the local DSH profile along with their
 * installation method (`npm`, `github`, `local`) and version.
 * @param {object} [options]
 * @param {string} [options.profileDir]
 * @param {string} [options.homeDir]
 */
export async function listLocalPlugins(options = {}) {
  const profileDir = resolveLocalProfileDir(options)
  const profileManifest = readJsonSafe(join(profileDir, 'package.json'))
  if (!profileManifest) {
    return { profileDir, plugins: [] }
  }

  const dependencies = profileManifest.dependencies ?? {}
  const enabledSet = new Set(profileManifest.dsh?.profile?.bundles ?? [])
  const plugins = []

  for (const [pkgName, recordedSpec] of Object.entries(dependencies)) {
    if (BUILTIN_BUNDLES.has(pkgName)) continue
    const sourceInfo = classifyInstallSource(pkgName, recordedSpec, profileDir)

    const nodeModulesPkgDir = join(profileDir, 'node_modules', ...pkgName.split('/'))
    const candidateDirs = [
      ...(sourceInfo.sourceKind === 'local' && sourceInfo.localSubkind === 'directory' && sourceInfo.localPath
        ? [sourceInfo.localPath]
        : []),
      nodeModulesPkgDir,
    ]

    let pkgDir = null
    let pkgManifest = null
    for (const dir of candidateDirs) {
      const m = readJsonSafe(join(dir, 'package.json'))
      if (m) {
        pkgDir = dir
        pkgManifest = m
        break
      }
    }

    if (!pkgManifest) continue
    // Only include DSH bundles (declaring dsh.bundle)
    if (!pkgManifest.dsh?.bundle) continue

    const version = typeof pkgManifest.version === 'string' && pkgManifest.version.trim() !== ''
      ? pkgManifest.version.trim()
      : '0.0.0'
    const meta = readLocalizedMeta(pkgDir, pkgManifest)

    const installSpec = sourceInfo.sourceKind === 'npm'
      ? `${pkgName}@${version}`
      : sourceInfo.installSpec

    // If local directory source points to a missing external path, fall back to the installed nodeModulesPkgDir
    let effectiveLocalPath = sourceInfo.localPath
    let effectiveLocalSubkind = sourceInfo.localSubkind
    if (sourceInfo.sourceKind === 'local') {
      if (!effectiveLocalPath || !existsSync(effectiveLocalPath)) {
        effectiveLocalPath = pkgDir
        effectiveLocalSubkind = 'directory'
      } else {
        try {
          const st = statSync(effectiveLocalPath)
          effectiveLocalSubkind = st.isDirectory() ? 'directory' : 'tarball'
        } catch {
          effectiveLocalPath = pkgDir
          effectiveLocalSubkind = 'directory'
        }
      }
    }

    plugins.push({
      name: pkgName,
      version,
      title: meta.title,
      description: meta.description,
      enabled: enabledSet.has(pkgName),
      sourceKind: sourceInfo.sourceKind,
      ...(sourceInfo.sourceKind === 'local'
        ? {
          localSubkind: effectiveLocalSubkind,
          localLinkPrefix: sourceInfo.localLinkPrefix ?? 'link',
          localPath: effectiveLocalPath,
        }
        : {}),
      recordedSpec: sourceInfo.recordedSpec,
      installSpec,
    })
  }

  return { profileDir, plugins }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.tmp', '.plugin-manager', 'coverage'])
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/**
 * Pack a local plugin directory into a gzipped JSON archive buffer for streaming over SSH stdin.
 * @param {string} rootDir
 * @returns {Promise<Buffer>}
 */
export async function packLocalPluginDirectory(rootDir) {
  const files = []

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(join(currentDir, entry.name))
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name) || entry.name.endsWith('.log')) continue
        const fullPath = join(currentDir, entry.name)
        const relPath = relative(rootDir, fullPath).split('\\').join('/')
        const content = await readFile(fullPath)
        const info = await stat(fullPath)
        files.push({
          path: relPath,
          mode: info.mode & 0o777,
          data: content.toString('base64'),
        })
      }
    }
  }

  await walk(rootDir)
  const payload = JSON.stringify({ version: 1, files })
  return gzipSync(Buffer.from(payload, 'utf8'))
}

/**
 * Build the remote shell command that inspects whether `packageName` is installed in `profile`
 * on the remote host and reports its version.
 * @param {object} options
 * @param {string} options.dshVersion
 * @param {string} options.profile
 * @param {string} options.packageName
 */
export function buildRemoteCheckPluginScript({ dshVersion, profile, packageName }) {
  const checkerJs = `
const fs = require('node:fs');
const path = require('node:path');
const PREFIX = ${JSON.stringify(EVENT_PREFIX)};
const profile = ${JSON.stringify(profile)};
const pkgName = ${JSON.stringify(packageName)};
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(process.env.HOME || '', '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);
const profileManifestPath = path.join(profileDir, 'package.json');

let installed = false;
let remoteVersion = null;
let recordedSpec = null;

if (fs.existsSync(profileManifestPath)) {
  try {
    const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
    const deps = pm.dependencies || {};
    const bundles = (pm.dsh && pm.dsh.profile && pm.dsh.profile.bundles) || [];
    if (Object.prototype.hasOwnProperty.call(deps, pkgName) || bundles.includes(pkgName)) {
      installed = true;
      recordedSpec = deps[pkgName] || null;
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

process.stdout.write(PREFIX + JSON.stringify({
  type: 'plugin_check',
  packageName: pkgName,
  installed,
  remoteVersion,
  recordedSpec,
}) + '\\n');
`.trim()

  const checkerB64 = Buffer.from(checkerJs, 'utf8').toString('base64')
  const shScript = `
${LOGIN_ENV_PREAMBLE}
set -e
BASE_DIR="$HOME/.dsh-remote-connect"
export PATH="$PATH:$BASE_DIR/node/current/bin:$HOME/.local/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  for CAND in $(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V -r); do
    export PATH="$CAND:$PATH"
    break
  done
fi
node -e "$(printf %s '${checkerB64}' | base64 -d)"
`.trim()

  const encoded = Buffer.from(shScript, 'utf8').toString('base64')
  return `mkdir -p ~/.dsh-remote-connect && printf %s ${encoded} | base64 -d > ~/.dsh-remote-connect/.chk-$$.sh && exec sh ~/.dsh-remote-connect/.chk-$$.sh`
}

/**
 * Build the remote shell command that removes an existing copy of `packageName` (if present)
 * and installs the plugin into `profile` using the matching source method (`npm`, `github`, `local`).
 * For `local` source, the payload is piped in via stdin.
 *
 * @param {object} options
 * @param {string} options.dshVersion
 * @param {string} options.profile
 * @param {string} options.packageName
 * @param {'npm' | 'github' | 'local'} options.sourceKind
 * @param {'directory' | 'tarball'} [options.localSubkind]
 * @param {'link' | 'file'} [options.localLinkPrefix]
 * @param {string} options.installSpec
 * @param {string} [options.tarballFilename]
 * @param {boolean} options.reinstall
 */
export function buildRemoteInstallPluginScript(options) {
  const {
    dshVersion,
    profile,
    packageName,
    sourceKind,
    localSubkind = 'directory',
    localLinkPrefix = 'link',
    installSpec,
    tarballFilename = 'plugin.tgz',
    reinstall = false,
  } = options

  const safeSlug = packageName.replace(/[^A-Za-z0-9._-]/g, '_')

  const installerNodeJs = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PREFIX = ${JSON.stringify(EVENT_PREFIX)};
const dshVersion = ${JSON.stringify(dshVersion)};
const profile = ${JSON.stringify(profile)};
const pkgName = ${JSON.stringify(packageName)};
const sourceKind = ${JSON.stringify(sourceKind)};
const localSubkind = ${JSON.stringify(localSubkind)};
const localLinkPrefix = ${JSON.stringify(localLinkPrefix)};
const installSpec = ${JSON.stringify(installSpec)};
const tarballFilename = ${JSON.stringify(tarballFilename)};
const safeSlug = ${JSON.stringify(safeSlug)};
const reinstall = ${JSON.stringify(Boolean(reinstall))};

function emit(obj) {
  process.stdout.write(PREFIX + JSON.stringify(obj) + '\\n');
}

const home = process.env.HOME || '';
const baseDir = path.join(home, '.dsh-remote-connect');
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(home, '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);
const dshBin = path.join(baseDir, dshVersion, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

if (!fs.existsSync(dshBin)) {
  emit({ type: 'plugin_sync_error', message: 'Remote DSH binary not found at ' + dshBin });
  process.exit(1);
}

function runDshPlugin(args) {
  return spawnSync(process.execPath, [dshBin, 'plugin', '--profile', profile, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: 300_000,
  });
}

// 1. If local source, read base64-encoded stdin into a binary Buffer first
let stdinBuf = null;
if (sourceKind === 'local') {
  const rawBase64 = fs.readFileSync(0, 'utf8').replace(/\\s+/g, '');
  if (!rawBase64) {
    emit({ type: 'plugin_sync_error', message: 'Empty payload received for local plugin sync' });
    process.exit(1);
  }
  stdinBuf = Buffer.from(rawBase64, 'base64');
}

// 2. If already installed on remote, deselect and remove first while existing files remain intact
const profileManifestPath = path.join(profileDir, 'package.json');
if (reinstall && fs.existsSync(profileManifestPath)) {
  try {
    const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
    if (pm.dsh && pm.dsh.profile && Array.isArray(pm.dsh.profile.bundles)) {
      const nextBundles = pm.dsh.profile.bundles.filter((b) => b !== pkgName);
      if (nextBundles.length !== pm.dsh.profile.bundles.length) {
        pm.dsh.profile.bundles = nextBundles;
        fs.writeFileSync(profileManifestPath, JSON.stringify(pm, null, 2) + '\\n');
        // Allow running dsh-hmr to observe bundle deselection before removing node_modules
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      }
    }
  } catch {}

  runDshPlugin(['remove', pkgName]);
}

// 3. Materialize local plugin files under ~/.dsh-remote-connect/local-plugins if local source
let targetSpec = installSpec;
if (sourceKind === 'local') {
  const localPluginsRoot = path.join(baseDir, 'local-plugins');
  fs.mkdirSync(localPluginsRoot, { recursive: true });

  if (localSubkind === 'tarball') {
    const baseName = path.basename(tarballFilename);
    const destTarball = path.join(localPluginsRoot, baseName.startsWith(safeSlug) ? baseName : (safeSlug + '-' + baseName));
    fs.writeFileSync(destTarball, stdinBuf);
    targetSpec = 'file:' + destTarball;
  } else {
    const destDir = path.join(localPluginsRoot, safeSlug);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    const unpacked = JSON.parse(zlib.gunzipSync(stdinBuf).toString('utf8'));
    for (const fileEntry of unpacked.files || []) {
      const rel = String(fileEntry.path || '').replace(/^\\/+/, '');
      if (!rel || rel.includes('..')) continue;
      const fullPath = path.join(destDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(fileEntry.data, 'base64'), {
        mode: fileEntry.mode || 0o644,
      });
    }
    targetSpec = destDir;
  }
}

// 3. Install plugin via dsh plugin --profile <profile> add <targetSpec>
let addRes;
if (sourceKind === 'npm') {
  const registries = [null, 'https://registry.npmmirror.com/', 'https://registry.npmjs.org/'];
  for (const reg of registries) {
    const args = ['add', targetSpec, '--save-exact', ...(reg ? ['--registry=' + reg] : [])];
    addRes = runDshPlugin(args);
    if (addRes.status === 0) break;
  }
} else {
  addRes = runDshPlugin(['add', targetSpec]);
  // If git plugin requires build script approval, record allowBuilds and retry once
  if (addRes.status !== 0 && sourceKind === 'github') {
    const wsPath = path.join(profileDir, 'pnpm-workspace.yaml');
    if (fs.existsSync(wsPath)) {
      const wsContent = fs.readFileSync(wsPath, 'utf8');
      if (!wsContent.includes('dangerouslyAllowAllBuilds')) {
        fs.writeFileSync(wsPath, wsContent.trimEnd() + '\\ndangerouslyAllowAllBuilds: true\\n');
        addRes = runDshPlugin(['add', targetSpec]);
      }
    }
  }
}

if (!addRes || addRes.status !== 0) {
  const errOut = ((addRes && (addRes.stderr || addRes.stdout)) || 'dsh plugin add failed').trim();
  emit({ type: 'plugin_sync_error', message: errOut });
  process.exit(1);
}

// 4. Read back installed version from remote profile
let installedVersion = null;
const pkgManifestPath = path.join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json');
if (fs.existsSync(pkgManifestPath)) {
  try {
    const pkgM = JSON.parse(fs.readFileSync(pkgManifestPath, 'utf8'));
    installedVersion = pkgM.version || null;
  } catch {}
}

emit({
  type: 'plugin_synced',
  ok: true,
  packageName: pkgName,
  installedVersion,
  sourceKind,
  reinstalled: reinstall,
});
`.trim()

  const installerB64 = Buffer.from(installerNodeJs, 'utf8').toString('base64')

  const shScript = `
${LOGIN_ENV_PREAMBLE}
set -e
BASE_DIR="$HOME/.dsh-remote-connect"
export PATH="$PATH:$BASE_DIR/node/current/bin:$BASE_DIR/pnpm/bin:$HOME/.local/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  for CAND in $(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V -r); do
    export PATH="$CAND:$PATH"
    break
  done
fi
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$BASE_DIR/pnpm"
  for REG in "https://registry.npmmirror.com/" "https://registry.npmjs.org/"; do
    if npm install --prefix "$BASE_DIR/pnpm" -g pnpm --registry "$REG" --no-audit --no-fund >/dev/null 2>&1; then
      break
    fi
  done
  export PATH="$BASE_DIR/pnpm/bin:$PATH"
fi
node -e "$(printf %s '${installerB64}' | base64 -d)"
`.trim()

  const encoded = Buffer.from(shScript, 'utf8').toString('base64')
  return `mkdir -p ~/.dsh-remote-connect && printf %s ${encoded} | base64 -d > ~/.dsh-remote-connect/.inst-$$.sh && exec sh ~/.dsh-remote-connect/.inst-$$.sh`
}
