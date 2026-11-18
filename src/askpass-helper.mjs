#!/usr/bin/env node
// Cross-platform SSH_ASKPASS helper invoked by OpenSSH when interactive
// password, OTP, keyboard-interactive, or key-passphrase input is required.

import { request as httpRequest } from 'node:http'

const askpassUrl = process.env.DSH_RC_ASKPASS_URL
const token = process.env.DSH_RC_ASKPASS_TOKEN
const promptText = process.argv.slice(2).join(' ').trim() || 'Password / OTP:'

if (!askpassUrl || !token) {
  process.exit(1)
}

const body = JSON.stringify({
  token,
  prompt: promptText,
})

let parsedUrl
try {
  parsedUrl = new URL(askpassUrl)
} catch {
  process.exit(1)
}

const req = httpRequest(
  {
    hostname: parsedUrl.hostname,
    port: Number(parsedUrl.port),
    path: parsedUrl.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    timeout: 300_000,
  },
  (res) => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      raw += chunk
    })
    res.on('end', () => {
      if (res.statusCode !== 200) {
        process.exit(1)
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.ok === true && typeof parsed.value === 'string') {
          process.stdout.write(`${parsed.value}\n`, () => {
            process.exit(0)
          })
          return
        }
      } catch {
        // fall through
      }
      process.exit(1)
    })
  },
)

req.on('timeout', () => {
  req.destroy()
  process.exit(1)
})

req.on('error', () => {
  process.exit(1)
})

req.end(body)
