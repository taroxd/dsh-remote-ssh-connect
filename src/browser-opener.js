// Cross-platform default browser launcher with headless/unsupported detection.

import { spawn } from 'node:child_process'

function runOpenerCommand(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      return
    }

    const timer = setTimeout(() => {
      // If the browser process stayed running (e.g. direct browser binary), treat as launched
      try {
        child.unref()
      } catch {
        /* ignore */
      }
      finish({ ok: true })
    }, timeoutMs)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk
    })

    child.once('error', (error) => {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) })
    })

    child.once('close', (code) => {
      if (code === 0) {
        finish({ ok: true })
      } else {
        const msg = stderr.trim().split(/\r?\n/)[0] || `${command} exited with code ${String(code)}`
        finish({ ok: false, reason: msg })
      }
    })
  })
}

/**
 * Open an HTTP(S) URL in the operating system's default browser.
 * Returns `{ opened: boolean, url: string, fallbackRequired: boolean, reason?: string }`.
 * @param {string} url
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof runOpenerCommand} [options.execOpener]
 */
export async function openUrlInDefaultBrowser(url, options = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${String(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`)
  }

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const execOpener = options.execOpener ?? runOpenerCommand

  if (platform === 'win32') {
    if (env.SSH_CONNECTION && !env.SESSIONNAME) {
      return {
        opened: false,
        url,
        fallbackRequired: true,
        reason: 'Running inside a headless Windows SSH session without an interactive desktop',
      }
    }
    const res = await execOpener('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    if (res.ok) {
      return { opened: true, url, fallbackRequired: false }
    }
    return {
      opened: false,
      url,
      fallbackRequired: true,
      reason: res.reason || 'Failed to launch default browser on Windows',
    }
  }

  if (platform === 'linux') {
    const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
    const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET)
    const customBrowser = typeof env.BROWSER === 'string' && env.BROWSER.trim() !== '' ? env.BROWSER.trim() : null

    if (!isWsl && !hasDisplay && !customBrowser) {
      return {
        opened: false,
        url,
        fallbackRequired: true,
        reason: 'No graphical desktop environment (DISPLAY / WAYLAND_DISPLAY) detected on Linux',
      }
    }

    const candidates = []
    if (customBrowser) {
      candidates.push([customBrowser, [url]])
    }
    if (isWsl) {
      candidates.push(['wslview', [url]])
      candidates.push(['rundll32.exe', ['url.dll,FileProtocolHandler', url]])
    }
    if (hasDisplay) {
      candidates.push(['xdg-open', [url]])
      candidates.push(['gio', ['open', url]])
      candidates.push(['x-www-browser', [url]])
      candidates.push(['sensible-browser', [url]])
    }

    let lastReason = 'No supported browser launcher found'
    for (const [cmd, args] of candidates) {
      const res = await execOpener(cmd, args)
      if (res.ok) {
        return { opened: true, url, fallbackRequired: false }
      }
      if (res.reason) lastReason = res.reason
    }

    return {
      opened: false,
      url,
      fallbackRequired: true,
      reason: lastReason,
    }
  }

  if (platform === 'darwin') {
    const res = await execOpener('open', [url])
    if (res.ok) {
      return { opened: true, url, fallbackRequired: false }
    }
    return {
      opened: false,
      url,
      fallbackRequired: true,
      reason: res.reason || 'Failed to launch default browser on macOS',
    }
  }

  return {
    opened: false,
    url,
    fallbackRequired: true,
    reason: `Unsupported operating system platform: ${platform}`,
  }
}
