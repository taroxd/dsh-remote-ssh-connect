// Loopback HTTP coordinator for SSH_ASKPASS interactive prompts (Password / OTP / 2FA).

import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_SCRIPT_PATH = fileURLToPath(new URL('./askpass-helper.mjs', import.meta.url))

/**
 * Classify an SSH prompt to help the UI present appropriate input fields.
 * @param {string} promptText
 * @returns {'otp' | 'password' | 'passphrase' | 'confirm' | 'input'}
 */
export function classifyAuthPrompt(promptText) {
  const lower = String(promptText ?? '').toLowerCase()
  if (/\b(yes\/no|continue connecting|fingerprint)\b/.test(lower)) {
    return 'confirm'
  }
  if (/\b(otp|one-time|verification code|authenticator|token|2fa|mfa|passcode|pin|动态码|验证码|口令码)\b/.test(lower)) {
    return 'otp'
  }
  if (/\bpassphrase\b/.test(lower)) {
    return 'passphrase'
  }
  if (/\b(password|密码)\b/.test(lower)) {
    return 'password'
  }
  return 'input'
}

export class AskpassCoordinator {
  constructor({ onPromptChanged } = {}) {
    this.onPromptChanged = onPromptChanged ?? (() => {})
    this.server = null
    this.port = 0
    this.tempDir = null
    this.launcherPath = null
    /** @type {Map<string, { host: string, createdAt: number }>} */
    this.sessions = new Map()
    /** @type {Map<string, { id: string, token: string, host: string, prompt: string, kind: string, createdAt: number, resolve: (val: string | null) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pendingPrompts = new Map()
  }

  async start() {
    if (this.server !== null) return
    const baseTmp = tmpdir()
    await mkdir(baseTmp, { recursive: true })
    this.tempDir = await mkdtemp(join(baseTmp, 'dsh-rc-askpass-'))

    if (process.platform === 'win32') {
      const cmdPath = join(this.tempDir, 'askpass.cmd')
      const cmdContent = [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        '"%DSH_RC_NODE_EXEC%" "%DSH_RC_ASKPASS_SCRIPT%" %*',
        '',
      ].join('\r\n')
      await writeFile(cmdPath, cmdContent, 'utf8')
      this.launcherPath = cmdPath
    } else {
      const shPath = join(this.tempDir, 'askpass.sh')
      const shContent = [
        '#!/bin/sh',
        'export ELECTRON_RUN_AS_NODE=1',
        'exec "$DSH_RC_NODE_EXEC" "$DSH_RC_ASKPASS_SCRIPT" "$@"',
        '',
      ].join('\n')
      await writeFile(shPath, shContent, { encoding: 'utf8', mode: 0o700 })
      await chmod(shPath, 0o700)
      this.launcherPath = shPath
    }

    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/askpass') {
        res.writeHead(404)
        res.end()
        return
      }
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        if (raw.length < 16384) raw += chunk
      })
      req.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          return
        }
        const token = typeof parsed?.token === 'string' ? parsed.token : ''
        const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt : 'Password:'
        const session = this.sessions.get(token)
        if (!session) {
          res.writeHead(403)
          res.end(JSON.stringify({ ok: false, error: 'invalid session token' }))
          return
        }

        const promptId = randomUUID()
        const kind = classifyAuthPrompt(prompt)
        const timer = setTimeout(() => {
          this.settlePrompt(promptId, null)
        }, 290_000)

        const entry = {
          id: promptId,
          token,
          host: session.host,
          prompt,
          kind,
          createdAt: Date.now(),
          timer,
          resolve: (value) => {
            if (res.writableEnded) return
            if (typeof value === 'string') {
              res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
              res.end(JSON.stringify({ ok: true, value }))
            } else {
              res.writeHead(403, { 'content-type': 'application/json', connection: 'close' })
              res.end(JSON.stringify({ ok: false, error: 'cancelled' }))
            }
          },
        }

        res.on('close', () => {
          if (this.pendingPrompts.has(promptId)) {
            clearTimeout(timer)
            this.pendingPrompts.delete(promptId)
            this.onPromptChanged(session.host, this.getPendingPromptForHost(session.host))
          }
        })

        this.pendingPrompts.set(promptId, entry)
        this.onPromptChanged(session.host, this.getPendingPromptForHost(session.host))
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const addr = this.server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
  }

  /**
   * Create askpass environment variables for one SSH connection attempt.
   * @param {string} host
   */
  createSessionEnv(host) {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, { host, createdAt: Date.now() })
    return {
      token,
      env: {
        SSH_ASKPASS: this.launcherPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY || 'dsh-remote-connect:0',
        DSH_RC_NODE_EXEC: process.execPath,
        DSH_RC_ASKPASS_SCRIPT: HELPER_SCRIPT_PATH,
        DSH_RC_ASKPASS_URL: `http://127.0.0.1:${this.port}/askpass`,
        DSH_RC_ASKPASS_TOKEN: token,
      },
      dispose: () => {
        this.sessions.delete(token)
        for (const [id, entry] of this.pendingPrompts.entries()) {
          if (entry.token === token) {
            this.settlePrompt(id, null)
          }
        }
      },
    }
  }

  getPendingPromptForHost(host) {
    for (const entry of this.pendingPrompts.values()) {
      if (entry.host === host) {
        return {
          id: entry.id,
          host: entry.host,
          prompt: entry.prompt,
          kind: entry.kind,
          createdAt: entry.createdAt,
        }
      }
    }
    return null
  }

  settlePrompt(promptId, value) {
    const entry = this.pendingPrompts.get(promptId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingPrompts.delete(promptId)
    try {
      entry.resolve(value)
    } finally {
      this.onPromptChanged(entry.host, this.getPendingPromptForHost(entry.host))
    }
    return true
  }

  submitForHost(host, promptId, value) {
    for (const [id, entry] of this.pendingPrompts.entries()) {
      if (entry.host === host && (!promptId || id === promptId)) {
        return this.settlePrompt(id, value)
      }
    }
    return false
  }

  cancelForHost(host, promptId) {
    return this.submitForHost(host, promptId, null)
  }

  async stop() {
    for (const id of [...this.pendingPrompts.keys()]) {
      this.settlePrompt(id, null)
    }
    this.sessions.clear()
    if (this.server !== null) {
      const srv = this.server
      this.server = null
      srv.closeAllConnections?.()
      await new Promise((resolve) => srv.close(() => resolve()))
    }
    if (this.tempDir !== null) {
      const dir = this.tempDir
      this.tempDir = null
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
