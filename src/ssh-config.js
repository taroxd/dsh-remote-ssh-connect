// ~/.ssh/config parser modelled after VS Code Remote-SSH and OpenSSH rules.
// Excludes wildcard (*, ?) and negated (!) patterns from the listed hosts
// while still applying matching Host block options in first-wins order.

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Strip inline comment outside quotes. In OpenSSH config, a '#' starts a
 * comment when at index 0 or preceded by whitespace outside quotes.
 * @param {string} line
 * @returns {string}
 */
export function stripSshComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trim()
    }
  }
  return line.trim()
}

/**
 * Tokenize one SSH config argument string into tokens, respecting quotes.
 * @param {string} raw
 * @returns {string[]}
 */
export function tokenizeSshArgs(raw) {
  const tokens = []
  let current = ''
  let quote = null
  let hasToken = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      hasToken = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) tokens.push(current)
  return tokens
}

/**
 * Parse one non-empty, comment-stripped SSH config line into `{ key, value, tokens }`.
 * Supports both whitespace-delimited and `Key = Value` syntax.
 * @param {string} cleanLine
 * @returns {{ key: string, rawValue: string, tokens: string[] } | null}
 */
export function parseSshDirective(cleanLine) {
  if (!cleanLine) return null
  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*|\s+)(.*)$/.exec(cleanLine)
  if (!match) return null
  const key = match[1].toLowerCase()
  const rawValue = match[2].trim()
  const tokens = tokenizeSshArgs(rawValue)
  if (tokens.length === 0) return null
  return { key, rawValue, tokens }
}

/**
 * Whether a Host pattern is a concrete host alias (not wildcard and not negated).
 * @param {string} pattern
 * @returns {boolean}
 */
export function isConcreteHostPattern(pattern) {
  if (typeof pattern !== 'string') return false
  const trimmed = pattern.trim()
  if (trimmed === '' || trimmed.startsWith('!')) return false
  if (trimmed.includes('*') || trimmed.includes('?')) return false
  return true
}

/**
 * Convert an SSH glob pattern (`*`, `?`) into a RegExp.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  let expr = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') expr += '.*'
    else if (ch === '?') expr += '.'
    else if ('\\^$+?.()|{}[]'.includes(ch)) expr += `\\${ch}`
    else expr += ch
  }
  expr += '$'
  return new RegExp(expr, 'i')
}

/**
 * Check if a Host pattern list matches a target host alias according to OpenSSH rules:
 * matches if at least one positive pattern matches and no negated (`!`) pattern matches.
 * @param {string[]} patterns
 * @param {string} hostAlias
 * @returns {boolean}
 */
export function hostBlockMatches(patterns, hostAlias) {
  let matchedPositive = false
  for (const rawPattern of patterns) {
    if (!rawPattern) continue
    if (rawPattern.startsWith('!')) {
      const negPattern = rawPattern.slice(1)
      if (negPattern && globToRegExp(negPattern).test(hostAlias)) {
        return false
      }
    } else if (globToRegExp(rawPattern).test(hostAlias)) {
      matchedPositive = true
    }
  }
  return matchedPositive
}

function expandHome(inputPath, homeDir) {
  if (inputPath === '~') return homeDir
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return join(homeDir, inputPath.slice(2))
  }
  return inputPath
}

async function expandGlobPattern(absPattern) {
  const normalized = absPattern.replace(/\\/g, '/')
  if (!normalized.includes('*') && !normalized.includes('?')) {
    try {
      const info = await stat(absPattern)
      return info.isFile() ? [absPattern] : []
    } catch {
      return []
    }
  }

  // Split into directory prefix without wildcards and remaining segments
  const parts = normalized.split('/')
  let baseIdx = 0
  while (baseIdx < parts.length && !parts[baseIdx].includes('*') && !parts[baseIdx].includes('?')) {
    baseIdx += 1
  }
  const baseDir = baseIdx === 0 ? '/' : parts.slice(0, baseIdx).join('/') || '/'
  const restSegments = parts.slice(baseIdx)

  async function walk(currentDir, segmentIndex) {
    if (segmentIndex >= restSegments.length) return []
    const segPattern = restSegments[segmentIndex]
    const re = globToRegExp(segPattern)
    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return []
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const results = []
    const isLast = segmentIndex === restSegments.length - 1
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !segPattern.startsWith('.')) continue
      if (!re.test(entry.name)) continue
      const fullPath = join(currentDir, entry.name)
      if (isLast) {
        try {
          const info = await stat(fullPath)
          if (info.isFile()) results.push(fullPath)
        } catch {
          /* ignore broken symlink */
        }
      } else {
        try {
          const info = await stat(fullPath)
          if (info.isDirectory()) {
            const sub = await walk(fullPath, segmentIndex + 1)
            results.push(...sub)
          }
        } catch {
          /* ignore */
        }
      }
    }
    return results
  }

  return walk(baseDir, 0)
}

/**
 * Parse raw SSH config content (without file-system Includes) into host blocks.
 * @param {string} content
 * @param {string} [sourceFile]
 * @returns {{ concreteHosts: Array<{ alias: string, sourceFile: string }>, blocks: Array<{ patterns: string[], options: Record<string, string[]>, sourceFile: string }> }}
 */
export function parseSshConfigText(content, sourceFile = '~/.ssh/config') {
  const lines = String(content ?? '').split(/\r?\n/)
  const concreteHosts = []
  const seenConcrete = new Set()
  const blocks = []

  // Top-level options before any Host directive apply globally like `Host *`
  let currentBlock = {
    patterns: ['*'],
    options: {},
    sourceFile,
    isMatch: false,
  }
  blocks.push(currentBlock)

  for (const rawLine of lines) {
    const clean = stripSshComment(rawLine)
    if (!clean) continue
    const directive = parseSshDirective(clean)
    if (!directive) continue
    const { key, rawValue, tokens } = directive

    if (key === 'host') {
      currentBlock = {
        patterns: tokens,
        options: {},
        sourceFile,
        isMatch: false,
      }
      blocks.push(currentBlock)
      for (const pat of tokens) {
        if (isConcreteHostPattern(pat) && !seenConcrete.has(pat)) {
          seenConcrete.add(pat)
          concreteHosts.push({ alias: pat, sourceFile })
        }
      }
      continue
    }

    if (key === 'match') {
      currentBlock = {
        patterns: [],
        options: {},
        sourceFile,
        isMatch: true,
      }
      continue
    }

    if (currentBlock.isMatch) continue

    if (!currentBlock.options[key]) {
      currentBlock.options[key] = []
    }
    currentBlock.options[key].push(tokens.length === 1 ? tokens[0] : rawValue)
  }

  return { concreteHosts, blocks }
}

/**
 * Resolve concrete hosts and their effective SSH parameters from blocks.
 * @param {Array<{ alias: string, sourceFile: string }>} concreteHosts
 * @param {Array<{ patterns: string[], options: Record<string, string[]>, sourceFile: string }>} blocks
 * @returns {Array<{
 *   alias: string,
 *   hostName: string,
 *   user?: string,
 *   port: number,
 *   identityFiles: string[],
 *   proxyJump?: string,
 *   proxyCommand?: string,
 *   forwardAgent?: string,
 *   sourceFile: string,
 * }>}
 */
export function resolveHostsFromBlocks(concreteHosts, blocks) {
  const resolved = []
  const seen = new Set()

  for (const item of concreteHosts) {
    const { alias, sourceFile } = item
    if (seen.has(alias)) continue
    seen.add(alias)

    const effective = {}
    const identityFiles = []

    for (const block of blocks) {
      if (!hostBlockMatches(block.patterns, alias)) continue
      for (const [k, values] of Object.entries(block.options)) {
        if (!Array.isArray(values) || values.length === 0) continue
        if (k === 'identityfile') {
          for (const v of values) {
            if (!identityFiles.includes(v)) identityFiles.push(v)
          }
        } else if (effective[k] === undefined) {
          effective[k] = values[0]
        }
      }
    }

    const rawHostName = effective.hostname ?? alias
    const hostName = rawHostName.replace(/%h/g, alias)
    const parsedPort = effective.port !== undefined ? Number.parseInt(effective.port, 10) : 22
    const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 22

    resolved.push({
      alias,
      hostName,
      ...(effective.user !== undefined ? { user: effective.user } : {}),
      port,
      identityFiles,
      ...(effective.proxyjump !== undefined ? { proxyJump: effective.proxyjump } : {}),
      ...(effective.proxycommand !== undefined ? { proxyCommand: effective.proxycommand } : {}),
      ...(effective.forwardagent !== undefined ? { forwardAgent: effective.forwardagent } : {}),
      sourceFile,
    })
  }

  return resolved
}

/**
 * Parse a user's SSH config file (default `~/.ssh/config`), recursively expanding `Include` directives.
 * @param {object} [options]
 * @param {string} [options.configPath] - Path to the root SSH config file.
 * @param {string} [options.homeDir] - Home directory used for `~` expansion.
 * @returns {Promise<{ configPath: string, exists: boolean, hosts: ReturnType<typeof resolveHostsFromBlocks> }>}
 */
export async function loadSshConfigHosts(options = {}) {
  const homeDir = options.homeDir ?? homedir()
  const sshDir = options.sshDir ?? join(homeDir, '.ssh')
  const configPath = options.configPath ?? join(sshDir, 'config')

  const concreteHosts = []
  const seenConcrete = new Set()
  const blocks = []
  const visitedFiles = new Set()

  let rootExists = false

  async function parseFile(filePath, isRoot = false) {
    let real
    try {
      real = await realpath(filePath)
    } catch {
      real = resolve(filePath)
    }
    if (visitedFiles.has(real)) return
    visitedFiles.add(real)

    let raw
    try {
      raw = await readFile(real, 'utf8')
      if (isRoot) rootExists = true
    } catch {
      return
    }

    const lines = raw.split(/\r?\n/)
    let currentBlock = {
      patterns: ['*'],
      options: {},
      sourceFile: filePath,
      isMatch: false,
    }
    blocks.push(currentBlock)

    for (const rawLine of lines) {
      const clean = stripSshComment(rawLine)
      if (!clean) continue
      const directive = parseSshDirective(clean)
      if (!directive) continue
      const { key, rawValue, tokens } = directive

      if (key === 'include') {
        const currentPatterns = [...currentBlock.patterns]
        const currentIsMatch = currentBlock.isMatch
        for (const patternToken of tokens) {
          const expandedHome = expandHome(patternToken, homeDir)
          const absPattern = isAbsolute(expandedHome)
            ? expandedHome
            : join(dirname(real), expandedHome)
          const matchedFiles = await expandGlobPattern(absPattern)
          for (const includedFile of matchedFiles) {
            await parseFile(includedFile, false)
          }
        }
        // Restore enclosing Host context after Include
        currentBlock = {
          patterns: currentPatterns,
          options: {},
          sourceFile: filePath,
          isMatch: currentIsMatch,
        }
        blocks.push(currentBlock)
        continue
      }

      if (key === 'host') {
        currentBlock = {
          patterns: tokens,
          options: {},
          sourceFile: filePath,
          isMatch: false,
        }
        blocks.push(currentBlock)
        for (const pat of tokens) {
          if (isConcreteHostPattern(pat) && !seenConcrete.has(pat)) {
            seenConcrete.add(pat)
            concreteHosts.push({ alias: pat, sourceFile: filePath })
          }
        }
        continue
      }

      if (key === 'match') {
        currentBlock = {
          patterns: [],
          options: {},
          sourceFile: filePath,
          isMatch: true,
        }
        continue
      }

      if (currentBlock.isMatch) continue

      if (!currentBlock.options[key]) {
        currentBlock.options[key] = []
      }
      currentBlock.options[key].push(tokens.length === 1 ? tokens[0] : rawValue)
    }
  }

  await parseFile(configPath, true)
  return {
    configPath,
    exists: rootExists,
    hosts: resolveHostsFromBlocks(concreteHosts, blocks),
  }
}
