// Local plugin discovery and packing for remote plugin synchronization (npm / GitHub / local source).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

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

const IGNORED_DIRS = new Set([
  '.git',
  '.git-backup',
  'node_modules',
  '.pnpm-store',
  '.npm-cache',
  '.tmp',
  'tmp',
  '.dev',
  '.plugin-manager',
  'coverage',
])
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/**
 * Pack a local plugin directory into a gzipped JSON archive buffer for streaming over SSH stdin.
 * Files are copied as-is; nothing is added to the plugin.
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
        if (IGNORED_FILES.has(entry.name) || entry.name.endsWith('.log') || TARBALL_EXT.test(entry.name)) continue
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
