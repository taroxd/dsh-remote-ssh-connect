// Federation bridge between the local DSH Host and connected remote DSH instances.
// Implements:
// - Minimal RFC 6455 WebSocket client over node:http (zero external dependencies)
// - RemoteHostGatewayClient: authenticates with remote DSH over the SSH port-forward tunnel,
//   dispatches unary RPCs (/api/<endpoint>), multiplexes streams (/api/remote.mux),
//   and watches remote workspace/follow, session/control, and $events streams.
// - RemoteWorkspaceBridge: persists synced remote workspaces, detects remotely deleted workspaces,
//   synthesizes WorkspaceViews (hiding sessions when disconnected, syncing when connected),
//   and intercepts local TypertGateway RPCs & streams for remote workspaces and sessions.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { EventEmitter } from 'node:events'

export const REMOTE_WS_PREFIX = 'remote:'
const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const SAFE_RPC_ENDPOINT_RE = /^[A-Za-z0-9_$-]+(?:\/[A-Za-z0-9_$-]+)*$/

/**
 * Construct the deterministic local WorkspaceId for a synced remote workspace.
 * @param {string} host
 * @param {string} remoteWorkspaceId
 * @returns {string}
 */
export function makeLocalWorkspaceId(host, remoteWorkspaceId) {
  return `${REMOTE_WS_PREFIX}${String(host).trim()}:${String(remoteWorkspaceId).trim()}`
}

/**
 * Parse a local WorkspaceId into `{ host, remoteWorkspaceId }`, or `null` if it is a normal local workspace.
 * @param {string} workspaceId
 * @returns {{ host: string, remoteWorkspaceId: string } | null}
 */
export function parseLocalWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.startsWith(REMOTE_WS_PREFIX)) {
    return null
  }
  const rest = workspaceId.slice(REMOTE_WS_PREFIX.length)
  const sepIndex = rest.indexOf(':')
  if (sepIndex <= 0 || sepIndex === rest.length - 1) {
    return null
  }
  return {
    host: rest.slice(0, sepIndex),
    remoteWorkspaceId: rest.slice(sepIndex + 1),
  }
}

/**
 * Normalize and validate a persisted synced remote workspace record.
 * @param {object} raw
 */
export function normalizeSyncedWorkspaceRecord(raw = {}) {
  const host = String(raw.host ?? '').trim()
  const remoteWorkspaceId = String(raw.remoteWorkspaceId ?? '').trim()
  if (!host || !remoteWorkspaceId) {
    throw new TypeError('Synced workspace record requires non-empty host and remoteWorkspaceId')
  }
  const localWorkspaceId = typeof raw.localWorkspaceId === 'string' && raw.localWorkspaceId.startsWith(REMOTE_WS_PREFIX)
    ? raw.localWorkspaceId.trim()
    : makeLocalWorkspaceId(host, remoteWorkspaceId)
  const remotePath = String(raw.remotePath ?? raw.path ?? '/').trim() || '/'
  const defaultTitle = remotePath.split(/[\\/]/).filter(Boolean).pop() || remotePath
  const title = String(raw.title ?? '').trim() || defaultTitle
  const nowIso = new Date().toISOString()
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt.trim() : nowIso
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : createdAt
  const invalidated = Boolean(raw.invalidated)
  const invalidationReason = raw.invalidationReason ? String(raw.invalidationReason) : null

  return {
    localWorkspaceId,
    host,
    remoteWorkspaceId,
    remotePath,
    title,
    createdAt,
    updatedAt,
    invalidated,
    invalidationReason,
  }
}

/**
 * Extract the target SessionId from any Typert RPC/Stream `args` object.
 * Supports direct `sessionId`, `agentId`, `workspaceFileScopeId`, `childSessionId`, and `address`.
 * @param {object} args
 * @returns {string | null}
 */
export function extractSessionIdFromArgs(args) {
  if (!args || typeof args !== 'object') return null
  if (typeof args.sessionId === 'string' && args.sessionId) return args.sessionId
  if (typeof args.agentId === 'string' && args.agentId) return args.agentId
  if (typeof args.workspaceFileScopeId === 'string' && args.workspaceFileScopeId) return args.workspaceFileScopeId
  if (typeof args.childSessionId === 'string' && args.childSessionId) return args.childSessionId
  if (args.address && typeof args.address === 'object') {
    if (typeof args.address.sessionId === 'string' && args.address.sessionId) return args.address.sessionId
    if (typeof args.address.childSessionId === 'string' && args.address.childSessionId) return args.address.childSessionId
  }
  if (args.request && typeof args.request === 'object') {
    return extractSessionIdFromArgs(args.request)
  }
  return null
}

/**
 * Normalize a live `session/control` projection frame to the current wire shape
 * `{ type: 'projection', sessionId, seq, changes: { key, val }[] }`
 * (see the `v0.2.2-alpha.2/projection-event-frames` upgrade guide).
 * A pre-0.2.2 single-key frame `{ key, value, seq }` is converted so local clients
 * only ever receive the current shape. Returns `null` for an unusable frame.
 * @param {object} frame
 * @returns {{ type: 'projection', sessionId: string, seq: number, changes: { key: string, val: unknown }[] } | null}
 */
export function normalizeProjectionFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.sessionId !== 'string') return null
  const seq = typeof frame.seq === 'number' ? frame.seq : 0
  let changes
  if (Array.isArray(frame.changes)) {
    changes = frame.changes.filter((c) => c && typeof c === 'object' && typeof c.key === 'string')
  } else if (typeof frame.key === 'string') {
    changes = [{ key: frame.key, val: frame.value }]
  } else {
    return null
  }
  return { type: 'projection', sessionId: frame.sessionId, seq, changes }
}

/**
 * Create a RemoteError-compatible Error instance that TypertGateway's `remoteErrorOf` / `rpcFailure`
 * recognizes or forwards cleanly.
 */
export function createRemoteGatewayError(code, message, details = {}) {
  const err = new Error(message)
  err.name = 'RemoteError'
  err.code = code
  err.details = details && typeof details === 'object' ? details : {}
  return err
}

/**
 * Minimal, zero-dependency RFC 6455 WebSocket client over `node:http` / `node:https`.
 * Allows passing explicit `Cookie` and `Host` headers to the local SSH port-forwarded DSH endpoint.
 */
export class MinimalWsClient extends EventEmitter {
  /**
   * @param {string} urlStr - ws:// or wss:// URL
   * @param {object} [options]
   * @param {Record<string, string>} [options.headers]
   */
  constructor(urlStr, options = {}) {
    super()
    this.url = new URL(urlStr)
    this.headers = options.headers ?? {}
    this.readyState = 0 // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
    this.socket = null
    this.req = null
    this._buffer = Buffer.alloc(0)
    this._fragments = []
    this._fragmentOpcode = 0
    this._connect()
  }

  _connect() {
    const isSecure = this.url.protocol === 'wss:' || this.url.protocol === 'https:'
    const requestFn = isSecure ? httpsRequest : httpRequest
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')

    const reqHeaders = {
      Host: this.url.host,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      ...this.headers,
    }

    const req = requestFn({
      protocol: isSecure ? 'https:' : 'http:',
      hostname: this.url.hostname,
      port: this.url.port || (isSecure ? 443 : 80),
      path: `${this.url.pathname}${this.url.search}`,
      method: 'GET',
      headers: reqHeaders,
    })
    this.req = req

    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept']
      if (accept !== expectedAccept) {
        socket.destroy()
        this.readyState = 3
        this.emit('error', new Error('Invalid Sec-WebSocket-Accept header'))
        this.emit('close', 1002, '')
        return
      }
      this.socket = socket
      this.readyState = 1
      socket.setNoDelay(true)
      socket.setKeepAlive?.(true, 15_000)
      this._pingTimer = setInterval(() => {
        if (this.readyState === 1) {
          this._sendFrame(0x09, Buffer.alloc(0))
        }
      }, 20_000)
      this._pingTimer.unref?.()
      socket.on('data', (chunk) => this._onData(chunk))
      socket.on('error', (err) => this.emit('error', err))
      socket.on('close', () => {
        if (this._pingTimer) {
          clearInterval(this._pingTimer)
          this._pingTimer = null
        }
        if (this.readyState !== 3) {
          this.readyState = 3
          this.emit('close', 1006, '')
        }
      })
      this.emit('open')
      if (head && head.length > 0) {
        setImmediate(() => this._onData(head))
      }
    })

    req.on('response', (res) => {
      res.resume()
      this.readyState = 3
      this.emit('error', new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`))
      this.emit('close', 1006, '')
    })

    req.on('error', (err) => {
      if (this.readyState !== 3) {
        this.readyState = 3
        this.emit('error', err)
        this.emit('close', 1006, '')
      }
    })

    req.end()
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0]
      const secondByte = this._buffer[1]
      const fin = (firstByte & 0x80) !== 0
      const opcode = firstByte & 0x0f
      const masked = (secondByte & 0x80) !== 0
      let payloadLen = secondByte & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return
        payloadLen = this._buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return
        payloadLen = Number(this._buffer.readBigUInt64BE(2))
        offset = 10
      }

      if (payloadLen > MAX_WS_PAYLOAD_BYTES) {
        this.close(1009, 'Frame payload too large')
        return
      }
      const maskLen = masked ? 4 : 0
      const totalFrameLen = offset + maskLen + payloadLen
      if (this._buffer.length < totalFrameLen) return

      let payload = this._buffer.subarray(offset + maskLen, totalFrameLen)
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = payload[i] ^ maskKey[i & 3]
        }
        payload = unmasked
      }

      this._buffer = this._buffer.subarray(totalFrameLen)
      this._handleFrame(fin, opcode, payload)
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x08) {
      // Close frame
      let code = 1000
      let reason = ''
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0)
        reason = payload.subarray(2).toString('utf8')
      }
      if (this.readyState === 1) {
        this._sendFrame(0x08, Buffer.alloc(0))
      }
      this.readyState = 3
      this.socket?.destroy()
      this.emit('close', code, reason)
      return
    }
    if (opcode === 0x09) {
      // Ping -> send Pong
      if (this.readyState === 1) {
        this._sendFrame(0x0a, payload)
      }
      return
    }
    if (opcode === 0x0a) {
      // Pong
      return
    }

    if (opcode === 0x00) {
      this._fragments.push(payload)
      if (fin) {
        const full = Buffer.concat(this._fragments)
        const mode = this._fragmentOpcode
        this._fragments = []
        this._fragmentOpcode = 0
        if (mode === 0x01) {
          this.emit('message', { data: full.toString('utf8') })
        }
      }
      return
    }

    if (opcode === 0x01 || opcode === 0x02) {
      if (fin) {
        if (opcode === 0x01) {
          this.emit('message', { data: payload.toString('utf8') })
        }
      } else {
        this._fragmentOpcode = opcode
        this._fragments = [payload]
      }
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (!this.socket || this.socket.destroyed) return
    const len = payloadBuf.length
    let headerLen = 2
    if (len >= 126 && len <= 65535) headerLen = 4
    else if (len > 65535) headerLen = 10

    const frame = Buffer.allocUnsafe(headerLen + 4 + len)
    frame[0] = 0x80 | (opcode & 0x0f)
    if (len < 126) {
      frame[1] = 0x80 | len
    } else if (len <= 65535) {
      frame[1] = 0x80 | 126
      frame.writeUInt16BE(len, 2)
    } else {
      frame[1] = 0x80 | 127
      frame.writeBigUInt64BE(BigInt(len), 2)
    }

    const maskKey = randomBytes(4)
    maskKey.copy(frame, headerLen)
    for (let i = 0; i < len; i += 1) {
      frame[headerLen + 4 + i] = payloadBuf[i] ^ maskKey[i & 3]
    }
    try {
      this.socket.write(frame)
    } catch {}
  }

  send(text) {
    if (this.readyState !== 1) {
      throw new Error('WebSocket is not open')
    }
    const buf = Buffer.from(String(text), 'utf8')
    this._sendFrame(0x01, buf)
  }

  close(code = 1000, reason = '') {
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
    if (this.readyState === 3) return
    if (this.readyState === 1) {
      this.readyState = 2
      const reasonBuf = Buffer.from(String(reason), 'utf8')
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
      payload.writeUInt16BE(code, 0)
      reasonBuf.copy(payload, 2)
      this._sendFrame(0x08, payload)
    }
    this.readyState = 3
    try {
      this.req?.destroy()
    } catch {}
    try {
      this.socket?.destroy()
    } catch {}
  }
}

/**
 * Simple async queue for streaming items from WebSocket mux frames to an AsyncIterable consumer.
 */
class AsyncStreamQueue {
  constructor(onCancel) {
    this._items = []
    this._waiters = []
    this._done = false
    this._error = null
    this._onCancel = onCancel
  }

  push(value) {
    if (this._done) return
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()
      waiter.resolve({ value, done: false })
    } else {
      this._items.push({ type: 'item', value })
    }
  }

  end() {
    if (this._done) return
    this._done = true
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift()
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error) {
    if (this._done) return
    this._done = true
    this._error = error
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift()
      waiter.reject(error)
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._items.length > 0) {
          const next = this._items.shift()
          return Promise.resolve({ value: next.value, done: false })
        }
        if (this._error !== null) {
          const err = this._error
          this._error = null
          return Promise.reject(err)
        }
        if (this._done) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve, reject) => {
          this._waiters.push({ resolve, reject })
        })
      },
      return: () => {
        if (!this._done) {
          this._done = true
          this._onCancel?.()
        }
        while (this._waiters.length > 0) {
          const waiter = this._waiters.shift()
          waiter.resolve({ value: undefined, done: true })
        }
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/**
 * Manages the HTTP + WebSocket connection from the local Host to a single connected remote DSH instance.
 */
export class RemoteHostGatewayClient {
  /**
   * @param {object} options
   * @param {string} options.host - SSH host alias
   * @param {string} options.url - Authenticated mapped URL (http://127.0.0.1:<localPort>/?token=...)
   * @param {RemoteWorkspaceBridge} options.bridge
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(url: string, opts: object) => MinimalWsClient} [options.createWs]
   */
  constructor(options) {
    this.host = options.host
    this.url = options.url
    this.bridge = options.bridge
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.createWs = options.createWs ?? ((url, opts) => new MinimalWsClient(url, opts))

    this.parsedUrl = new URL(this.url)
    this.baseOrigin = `${this.parsedUrl.protocol}//${this.parsedUrl.host}`
    this.wsOrigin = `${this.parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${this.parsedUrl.host}`

    this.authCookie = null
    this.disposed = false
    this.lifetime = new AbortController()

    this.ws = null
    this.wsConnectingPromise = null
    this.streamSeq = 0
    /** @type {Map<string, AsyncStreamQueue>} */
    this.activeStreams = new Map()

    /** @type {Map<string, object>} remoteWorkspaceId -> WorkspaceView */
    this.remoteWorkspaces = new Map()
    /** @type {string[]} */
    this.remoteWorkspaceOrder = []
    /** @type {string[]} */
    this.remoteArchivedSessionIds = []
    /** @type {string[]} */
    this.remotePinnedSessionIds = []
    this.workspaceBaselineReceived = false

    /** @type {Map<string, object>} sessionId -> SessionSummary */
    this.remoteSessions = new Map()
    /** @type {Map<string, object>} sessionId -> ProjectionSnapshot */
    this.remoteProjections = new Map()
    this.remoteEventClientId = null
    this.remoteHome = null
  }

  async ensureAuthCookie() {
    if (this.authCookie) return this.authCookie
    if (this.disposed || typeof this.fetchImpl !== 'function') return null

    try {
      const res = await this.fetchImpl(this.url, {
        method: 'GET',
        redirect: 'manual',
        headers: { host: this.parsedUrl.host },
        signal: AbortSignal.timeout(10_000),
      })
      const setCookies = typeof res.headers?.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers?.get?.('set-cookie') ? [res.headers.get('set-cookie')] : [])
      for (const raw of setCookies) {
        const pair = String(raw).split(';')[0].trim()
        if (pair.startsWith('dsh-auth-')) {
          this.authCookie = pair
          return this.authCookie
        }
      }
    } catch {}
    return null
  }

  /**
   * Perform a unary RPC call against `/api/<endpoint>` on the remote DSH instance.
   * @param {string} endpoint - e.g. 'session/list', 'session/create', 'workspace/create'
   * @param {object} [args]
   * @param {AbortSignal} [signal]
   * @param {number} [timeoutMs=120000]
   */
  async callRpc(endpoint, args = {}, signal = undefined, timeoutMs = 120_000) {
    if (typeof endpoint !== 'string' || !SAFE_RPC_ENDPOINT_RE.test(endpoint)) {
      return {
        ok: false,
        error: {
          code: 'gateway/arguments-invalid',
          message: `Invalid RPC endpoint: ${String(endpoint)}`,
          details: {},
        },
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cookie = await this.ensureAuthCookie()
      if (!cookie) {
        return {
          ok: false,
          error: {
            code: 'gateway/unavailable',
            message: `Could not authenticate with remote DSH on host "${this.host}"`,
            details: {},
          },
        }
      }

      const rpcId = randomUUID()
      const signals = [AbortSignal.timeout(timeoutMs)]
      if (signal) signals.push(signal)
      const combinedSignal = AbortSignal.any(signals)

      let res
      try {
        res = await this.fetchImpl(`${this.baseOrigin}/api/${endpoint}`, {
          method: 'POST',
          headers: {
            host: this.parsedUrl.host,
            'content-type': 'application/json',
            cookie,
          },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: endpoint,
            payload: { args: args ?? {} },
          }),
          signal: combinedSignal,
        })
      } catch (err) {
        return {
          ok: false,
          error: {
            code: signal?.aborted ? 'gateway/cancelled' : 'gateway/internal',
            message: err instanceof Error ? err.message : String(err),
            details: {},
          },
        }
      }

      if (res.status === 401 || res.status === 403) {
        this.authCookie = null
        continue
      }

      if (!res.ok) {
        return {
          ok: false,
          error: {
            code: 'gateway/internal',
            message: `Remote HTTP ${res.status} for ${endpoint} on ${this.host}`,
            details: {},
          },
        }
      }

      const contentType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType === 'multipart/form-data') {
        try {
          const formData = await res.formData()
          const metaStr = formData.get('metadata')
          const meta = JSON.parse(String(metaStr))
          const attachments = []
          for (const att of meta.attachments ?? []) {
            const blob = formData.get(att.part)
            if (blob && typeof blob.arrayBuffer === 'function') {
              const bytes = new Uint8Array(await blob.arrayBuffer())
              attachments.push({ path: att.path, bytes })
            }
          }
          return {
            ...meta.result,
            ...(attachments.length > 0 ? { attachments } : {}),
          }
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'gateway/internal',
              message: err instanceof Error ? err.message : String(err),
              details: {},
            },
          }
        }
      }

      try {
        const envelope = await res.json()
        if (envelope && envelope.type === 'server-response' && envelope.result) {
          return envelope.result
        }
      } catch {}

      return {
        ok: false,
        error: {
          code: 'gateway/internal',
          message: `Invalid RPC response from ${this.host} for ${endpoint}`,
          details: {},
        },
      }
    }

    return {
      ok: false,
      error: {
        code: 'gateway/unavailable',
        message: `Authentication failed with remote DSH on host "${this.host}"`,
        details: {},
      },
    }
  }

  async _ensureWs() {
    if (this.disposed) throw new Error(`Remote client for "${this.host}" is disposed`)
    if (this.ws && this.ws.readyState === 1) return this.ws
    if (this.wsConnectingPromise) return this.wsConnectingPromise

    this.wsConnectingPromise = (async () => {
      const cookie = await this.ensureAuthCookie()
      if (!cookie) throw new Error(`Cannot open WebSocket to "${this.host}": no auth cookie`)

      return new Promise((resolve, reject) => {
        const ws = this.createWs(`${this.wsOrigin}/api/remote.mux`, {
          headers: {
            Cookie: cookie,
            Host: this.parsedUrl.host,
            Origin: this.baseOrigin,
          },
        })

        let settled = false
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            ws.close()
            reject(new Error(`WebSocket connection to ${this.host} timed out`))
          }
        }, 10_000)

        ws.once('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.ws = ws
          this.wsConnectingPromise = null
          resolve(ws)
        })

        ws.on('message', (ev) => {
          this._handleWsMessage(ev.data)
        })

        ws.once('error', (err) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            this.wsConnectingPromise = null
            reject(err)
          }
        })

        ws.once('close', () => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            this.wsConnectingPromise = null
            reject(new Error(`WebSocket closed before opening on ${this.host}`))
          }
          if (this.ws === ws) {
            this.ws = null
          }
          const closeErr = new Error(`Remote stream connection to "${this.host}" closed`)
          for (const [, q] of this.activeStreams) {
            q.fail(closeErr)
          }
          this.activeStreams.clear()
        })
      })
    })()

    try {
      return await this.wsConnectingPromise
    } finally {
      this.wsConnectingPromise = null
    }
  }

  _handleWsMessage(rawText) {
    let msg
    try {
      msg = JSON.parse(String(rawText))
    } catch {
      return
    }
    if (!msg || typeof msg.streamId !== 'string') return
    const queue = this.activeStreams.get(msg.streamId)
    if (!queue) return

    if (msg.type === 'item') {
      queue.push(msg.value)
    } else if (msg.type === 'end') {
      this.activeStreams.delete(msg.streamId)
      queue.end()
    } else if (msg.type === 'error') {
      this.activeStreams.delete(msg.streamId)
      const errObj = msg.error ?? { code: 'gateway/internal', message: 'Remote stream error', details: {} }
      queue.fail(createRemoteGatewayError(errObj.code, errObj.message, errObj.details))
    }
  }

  /**
   * Open a logical multiplexed stream on `/api/remote.mux` of the remote DSH.
   * @param {string} endpoint
   * @param {object} payload - `{ args: ... }`
   * @param {AbortSignal} [signal]
   * @param {AsyncIterable<any>} [uplink]
   * @returns {AsyncIterable<any>}
   */
  async *openStream(endpoint, payload = { args: {} }, signal = undefined, uplink = undefined) {
    const ws = await this._ensureWs()
    const streamId = `rc-s-${++this.streamSeq}-${randomUUID().slice(0, 8)}`

    const sendCancel = () => {
      if (this.activeStreams.has(streamId)) {
        this.activeStreams.delete(streamId)
        if (this.ws && this.ws.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ type: 'cancel', streamId }))
          } catch {}
        }
      }
    }

    const queue = new AsyncStreamQueue(sendCancel)
    this.activeStreams.set(streamId, queue)

    const onAbort = () => {
      sendCancel()
      queue.end()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint,
        payload: payload ?? { args: {} },
      }))

      if (uplink && typeof uplink[Symbol.asyncIterator] === 'function') {
        ;(async () => {
          try {
            for await (const item of uplink) {
              if (!this.activeStreams.has(streamId) || this.ws?.readyState !== 1) return
              this.ws.send(JSON.stringify({
                type: 'item',
                streamId,
                ...(item === undefined ? {} : { value: item }),
              }))
            }
            if (this.activeStreams.has(streamId) && this.ws?.readyState === 1) {
              this.ws.send(JSON.stringify({ type: 'end', streamId }))
            }
          } catch {}
        })()
      }

      yield* queue
    } finally {
      signal?.removeEventListener('abort', onAbort)
      sendCancel()
    }
  }

  /**
   * Start background synchronization of workspaces, session list, session control projections,
   * and forwarded events from the remote host.
   */
  async startSync() {
    if (this.disposed) return
    await this.ensureAuthCookie()
    void this._watchWorkspacesLoop()
    void this._watchSessionControlLoop()
    void this._watchEventsLoop()
    await this.fetchRemoteWorkspacesSnapshot(5_000).catch(() => {})
    await this.refreshSessionList().catch(() => {})
  }

  /**
   * Pull the latest `session/list` from the remote DSH and index sessions belonging to synced workspaces.
   */
  async refreshSessionList() {
    if (this.disposed) return []
    let res = await this.callRpc('session/list', { _request: {} })
    if (!res?.ok && res?.error?.code === 'gateway/arguments-invalid') {
      res = await this.callRpc('session/list', {})
    }
    if (res && res.ok && Array.isArray(res.value?.items)) {
      this.remoteSessions.clear()
      for (const summary of res.value.items) {
        if (summary && typeof summary.sessionId === 'string') {
          this.remoteSessions.set(summary.sessionId, summary)
        }
      }
      this.bridge._reconcileHostSessions(this.host)
      return res.value.items
    }
    return []
  }

  /**
   * Perform an on-demand pull of the remote host's workspace baseline if the stream hasn't delivered it yet.
   */
  async fetchRemoteWorkspacesSnapshot(timeoutMs = 8_000) {
    if (this.workspaceBaselineReceived) {
      return [...this.remoteWorkspaces.values()]
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      for await (const frame of this.openStream('workspace/follow', { args: {} }, ctrl.signal)) {
        if (frame && frame.type === 'baseline' && frame.value) {
          this._applyWorkspaceBaseline(frame.value)
          ctrl.abort()
          break
        }
      }
    } catch {
      /* ignore stream abort or fallback */
    } finally {
      clearTimeout(timer)
    }
    return [...this.remoteWorkspaces.values()]
  }

  _applyWorkspaceBaseline(baselineValue) {
    if (!baselineValue || typeof baselineValue !== 'object') return
    const items = Array.isArray(baselineValue.items) ? baselineValue.items : []
    this.remoteWorkspaces.clear()
    this.remoteWorkspaceOrder = []
    for (const item of items) {
      if (item && typeof item.workspaceId === 'string') {
        this.remoteWorkspaces.set(item.workspaceId, item)
        this.remoteWorkspaceOrder.push(item.workspaceId)
      }
    }
    this.remoteArchivedSessionIds = Array.isArray(baselineValue.archivedSessionIds)
      ? [...baselineValue.archivedSessionIds]
      : []
    this.remotePinnedSessionIds = Array.isArray(baselineValue.pinnedSessionIds)
      ? [...baselineValue.pinnedSessionIds]
      : []
    this.workspaceBaselineReceived = true
    this.bridge._handleRemoteWorkspaceBaseline(this.host)
  }

  async _watchWorkspacesLoop() {
    while (!this.disposed && !this.lifetime.signal.aborted) {
      try {
        for await (const frame of this.openStream('workspace/follow', { args: {} }, this.lifetime.signal)) {
          if (this.disposed) return
          if (!frame || typeof frame !== 'object') continue
          switch (frame.type) {
            case 'baseline':
            case 'replace':
              this._applyWorkspaceBaseline(frame.value)
              void this.refreshSessionList().catch(() => {})
              break
            case 'upsert':
              if (frame.workspace && typeof frame.workspace.workspaceId === 'string') {
                const wsId = frame.workspace.workspaceId
                const isNew = !this.remoteWorkspaces.has(wsId)
                this.remoteWorkspaces.set(wsId, frame.workspace)
                if (isNew && !this.remoteWorkspaceOrder.includes(wsId)) {
                  this.remoteWorkspaceOrder.unshift(wsId)
                }
                this.bridge._handleRemoteWorkspaceUpsert(this.host, frame.workspace)
                void this.refreshSessionList().catch(() => {})
              }
              break
            case 'remove':
              if (typeof frame.workspaceId === 'string') {
                this.remoteWorkspaces.delete(frame.workspaceId)
                this.remoteWorkspaceOrder = this.remoteWorkspaceOrder.filter((id) => id !== frame.workspaceId)
                this.bridge._handleRemoteWorkspaceRemoved(this.host, frame.workspaceId)
              }
              break
            case 'order':
              if (Array.isArray(frame.workspaceIds)) {
                this.remoteWorkspaceOrder = [...frame.workspaceIds]
                this.bridge._handleRemoteWorkspaceOrderChanged(this.host)
              }
              break
            case 'archived':
              if (Array.isArray(frame.archivedSessionIds)) {
                this.remoteArchivedSessionIds = [...frame.archivedSessionIds]
                this.bridge._handleRemoteArchivedChanged(this.host)
              }
              break
            case 'pinned':
              if (Array.isArray(frame.pinnedSessionIds)) {
                this.remotePinnedSessionIds = [...frame.pinnedSessionIds]
                this.bridge._handleRemotePinnedChanged(this.host)
              }
              break
          }
        }
      } catch {
        /* retry after delay */
      }
      if (this.disposed || this.lifetime.signal.aborted) return
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  async _watchSessionControlLoop() {
    while (!this.disposed && !this.lifetime.signal.aborted) {
      try {
        for await (const frame of this.openStream('session/control', { args: {} }, this.lifetime.signal)) {
          if (this.disposed) return
          if (!frame || typeof frame !== 'object') continue
          if (frame.type === 'baseline' && frame.value?.projections) {
            this.remoteProjections.clear()
            for (const [sessionId, proj] of Object.entries(frame.value.projections)) {
              this.remoteProjections.set(sessionId, proj)
            }
            this.bridge._handleRemoteControlBaseline(this.host)
          } else if (frame.type === 'projection' && typeof frame.sessionId === 'string') {
            const normalized = normalizeProjectionFrame(frame)
            if (!normalized) continue
            const existing = this.remoteProjections.get(normalized.sessionId) ?? { asOfSeq: normalized.seq, values: {} }
            const values = { ...existing.values }
            for (const change of normalized.changes) {
              values[change.key] = change.val
            }
            this.remoteProjections.set(normalized.sessionId, {
              asOfSeq: normalized.seq,
              values,
            })
            this.bridge._handleRemoteControlProjection(this.host, normalized)
          }
        }
      } catch {
        /* retry */
      }
      if (this.disposed || this.lifetime.signal.aborted) return
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  async _watchEventsLoop() {
    while (!this.disposed && !this.lifetime.signal.aborted) {
      try {
        for await (const frame of this.openStream('$events', { args: {} }, this.lifetime.signal)) {
          if (this.disposed) return
          if (!frame || typeof frame !== 'object') continue
          if (frame.type === 'ready') {
            this.remoteEventClientId = frame.clientId ?? null
            this.remoteHome = frame.host?.home ?? null
            continue
          }
          if (frame.type === 'emit') {
            this._handleRemoteEmitEvent(frame)
          } else if (frame.type === 'waterfall') {
            this.bridge._handleRemoteWaterfallFrame(this.host, this.remoteEventClientId, frame)
          } else if (frame.type === 'cancel') {
            this.bridge._handleRemoteCancelFrame(this.host, frame)
          }
        }
      } catch {
        /* retry */
      }
      if (this.disposed || this.lifetime.signal.aborted) return
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  _handleRemoteEmitEvent(frame) {
    const { event, args } = frame
    if (!Array.isArray(args)) return
    if (event === 'api-session/added' && args[0] && typeof args[0].sessionId === 'string') {
      const summary = args[0]
      this.remoteSessions.set(summary.sessionId, summary)
      this.bridge._reconcileHostSessions(this.host)
      if (this.bridge.isSessionVisibleLocally(summary.sessionId)) {
        this.bridge._broadcastEventFrame({ type: 'emit', event, args: [summary] })
      }
      return
    }
    if (event === 'api-session/removed' && typeof args[0] === 'string') {
      const sessionId = args[0]
      const wasVisible = this.bridge.isSessionVisibleLocally(sessionId)
      this.remoteSessions.delete(sessionId)
      this.bridge._reconcileHostSessions(this.host)
      if (wasVisible) {
        this.bridge._broadcastEventFrame({ type: 'emit', event, args: [sessionId] })
      }
      return
    }
    if (event === 'api-session/status' && typeof args[0] === 'string') {
      const [sessionId, running] = args
      const existing = this.remoteSessions.get(sessionId)
      if (existing) {
        this.remoteSessions.set(sessionId, { ...existing, running: Boolean(running) })
      }
      if (this.bridge.isSessionVisibleLocally(sessionId)) {
        this.bridge._broadcastEventFrame({ type: 'emit', event, args })
      }
      return
    }
    if (event === 'api-session/activity' && typeof args[0] === 'string') {
      const [sessionId, updatedAt] = args
      const existing = this.remoteSessions.get(sessionId)
      if (existing && typeof updatedAt === 'number') {
        this.remoteSessions.set(sessionId, { ...existing, updatedAt })
      }
      if (this.bridge.isSessionVisibleLocally(sessionId)) {
        this.bridge._broadcastEventFrame({ type: 'emit', event, args })
      }
      return
    }
    if (event === 'api-session/error' && typeof args[0] === 'string') {
      const [sessionId] = args
      if (this.bridge.isSessionVisibleLocally(sessionId)) {
        this.bridge._broadcastEventFrame({ type: 'emit', event, args })
      }
      return
    }
    // Forward other session-scoped emit events (e.g. goal/activation-changed) if they match a visible remote session
    this.bridge._broadcastEventFrame({ type: 'emit', event, args })
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    for (const [, q] of this.activeStreams) {
      q.end()
    }
    this.activeStreams.clear()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
  }
}

/**
 * Central coordinator that manages persisted synced remote workspaces, active `RemoteHostGatewayClient`s,
 * and bridges local `typertGateway` RPC/stream traffic to connected remote hosts.
 */
export class RemoteWorkspaceBridge {
  /**
   * @param {object} [options]
   * @param {(localWorkspaceId: string, record: object | null) => Promise<void>} [options.onSaveWorkspace]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(url: string, opts: object) => MinimalWsClient} [options.createWs]
   */
  constructor(options = {}) {
    this.onSaveWorkspace = options.onSaveWorkspace ?? (async () => {})
    this.onSaveWorkspaceOrder = options.onSaveWorkspaceOrder ?? (async () => {})
    this.fetchImpl = options.fetchImpl
    this.createWs = options.createWs

    /** @type {Map<string, ReturnType<typeof normalizeSyncedWorkspaceRecord>>} localWorkspaceId -> record */
    this.syncedWorkspaces = new Map()
    /** @type {string[]} ordered localWorkspaceIds */
    this.syncedWorkspaceOrder = []
    /** @type {string[]} interleaved local + remote workspaceIds */
    this.combinedWorkspaceOrder = []

    /** @type {Map<string, RemoteHostGatewayClient>} host -> client */
    this.hostClients = new Map()

    /** @type {Map<string, string>} sessionId -> host */
    this.sessionToHost = new Map()

    /** @type {Set<AsyncStreamQueue>} active local workspace/follow followers */
    this.workspaceFollowers = new Set()
    /** @type {Set<AsyncStreamQueue>} active local session/control followers */
    this.controlFollowers = new Set()
    /** @type {Set<AsyncStreamQueue>} active local $events followers */
    this.eventFollowers = new Set()

    /** @type {Map<string, { host: string, remoteClientId: string }>} eventId -> remote info */
    this.pendingWaterfalls = new Map()

    this.localWorkspaceBaseline = {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }

    this.attachedGateway = null
    this.attachedWorkspaceFeed = null
    this.attachedControlState = null
    /** @type {(() => void) | null} restores `workspaceController.feed.baseline` */
    this._restoreFeedBaseline = null
    /** @type {Map<string, { ms: number, sig: string }>} */
    this._projectedUpdatedAtState = new Map()
    /** @type {Set<string>} */
    this._announcedLocalSessions = new Set()
  }

  /**
   * Attach live Host controllers (`typertGateway`, `workspaceController`, `sessionController`) so that
   * even browser tabs whose WebSocket streams opened before this plugin initialized receive real-time
   * `workspace/follow`, `session/control`, and `$events` frames.
   *
   * Compatibility note: DSH exposes no public extension point for federating Gateway streams (the
   * `/api` RPC channel admits a single interceptor, already owned by `typertGateway`). This bridge
   * therefore relies on these non-public members, verified against DSH 0.2.2-rc.5; every access is
   * feature-detected so a missing member degrades to "no federation" instead of throwing:
   * - `typertGateway.dispatchRpc` / `openWireStream` (wrapped in index.js, restored on dispose)
   * - `typertGateway.remoteEventClients` (fallback delivery to pre-existing `$events` streams)
   * - `workspaceController.feed.baseline` (wrapped here, restored by `detachHostControllers`)
   * - `workspaceController.feed.followers` / `sessionController.controlState.streams`
   *   (fallback delivery to pre-existing streams only while no merged stream is open)
   */
  attachHostControllers({ gateway, workspaceController, sessionController } = {}) {
    if (gateway) this.attachedGateway = gateway
    if (workspaceController?.feed) {
      this.attachedWorkspaceFeed = workspaceController.feed
      try {
        const base = workspaceController.feed.baseline?.()
        if (base) {
          this.localWorkspaceBaseline = {
            items: (base.items ?? []).filter((w) => parseLocalWorkspaceId(w.workspaceId) === null),
            archivedSessionIds: [...(base.archivedSessionIds ?? [])],
            pinnedSessionIds: [...(base.pinnedSessionIds ?? [])],
          }
        }
        if (typeof workspaceController.feed.baseline === 'function' && !workspaceController.feed._rcBaselineWrapped) {
          const feed = workspaceController.feed
          const hadOwnBaseline = Object.prototype.hasOwnProperty.call(feed, 'baseline')
          const ownBaseline = hadOwnBaseline ? feed.baseline : undefined
          const origBaseline = feed.baseline.bind(feed)
          const patchedBaseline = () => {
            const raw = origBaseline()
            const localItems = (raw?.items ?? []).filter((w) => parseLocalWorkspaceId(w.workspaceId) === null)
            this.localWorkspaceBaseline = {
              items: [...localItems],
              archivedSessionIds: [...(raw?.archivedSessionIds ?? [])],
              pinnedSessionIds: [...(raw?.pinnedSessionIds ?? [])],
            }
            return {
              items: this.getOrderedWorkspaceViews(localItems),
              archivedSessionIds: this.getCombinedArchivedSessionIds(),
              pinnedSessionIds: this.getCombinedPinnedSessionIds(),
            }
          }
          patchedBaseline._rcBaselineWrapped = true
          feed.baseline = patchedBaseline
          feed._rcBaselineWrapped = true
          this._restoreFeedBaseline = () => {
            if (feed.baseline !== patchedBaseline) return
            if (hadOwnBaseline) feed.baseline = ownBaseline
            else delete feed.baseline
            delete feed._rcBaselineWrapped
          }
        }
      } catch {}
      this.publishAllSyncedWorkspacesToLiveFollowers()
    }
    if (sessionController?.controlState) {
      this.attachedControlState = sessionController.controlState
    }
  }

  /**
   * Undo `attachHostControllers`: restore the wrapped workspace feed baseline and drop
   * references to Host internals so a disposed plugin leaves no live hooks behind.
   * @param {{ gateway?: boolean, workspaceController?: boolean, sessionController?: boolean }} [which]
   */
  detachHostControllers({ gateway = true, workspaceController = true, sessionController = true } = {}) {
    if (gateway) this.attachedGateway = null
    if (workspaceController) {
      try {
        this._restoreFeedBaseline?.()
      } catch {}
      this._restoreFeedBaseline = null
      this.attachedWorkspaceFeed = null
    }
    if (sessionController) this.attachedControlState = null
  }

  publishAllSyncedWorkspacesToLiveFollowers() {
    const remoteViews = this.getProjectedWorkspaceViews()
    if (remoteViews.length === 0) return
    for (const view of remoteViews) {
      this._broadcastWorkspaceFrame({
        type: 'upsert',
        workspace: view,
      })
    }
    this._broadcastWorkspaceOrder()
  }

  /**
   * Load persisted interleaved workspace order (`local` + `remote:*` IDs).
   * @param {string[]} order
   */
  loadInitialWorkspaceOrder(order) {
    if (!Array.isArray(order)) return
    const seen = new Set()
    const clean = []
    for (const id of order) {
      if (typeof id === 'string' && id.trim() && !seen.has(id.trim())) {
        seen.add(id.trim())
        clean.push(id.trim())
      }
    }
    this.combinedWorkspaceOrder = clean
    const remoteInOrder = clean.filter((id) => parseLocalWorkspaceId(id) !== null)
    if (remoteInOrder.length > 0) {
      const rest = this.syncedWorkspaceOrder.filter((id) => !remoteInOrder.includes(id))
      this.syncedWorkspaceOrder = [...remoteInOrder, ...rest]
    }
  }

  /**
   * Reconcile `this.combinedWorkspaceOrder` against current local workspace items and synced remote workspaces.
   * @param {object[]} [localItemsOverride]
   * @returns {string[]}
   */
  getOrderedWorkspaceIds(localItemsOverride) {
    const localItems = Array.isArray(localItemsOverride)
      ? localItemsOverride
      : (this.localWorkspaceBaseline.items ?? [])
    const localIds = localItems
      .map((w) => w?.workspaceId)
      .filter((id) => typeof id === 'string' && parseLocalWorkspaceId(id) === null)
    const remoteViews = this.getProjectedWorkspaceViews()
    const remoteIds = remoteViews.map((w) => w.workspaceId)
    const validSet = new Set([...localIds, ...remoteIds])

    const result = []
    const seen = new Set()
    for (const id of this.combinedWorkspaceOrder) {
      if (validSet.has(id) && !seen.has(id)) {
        seen.add(id)
        result.push(id)
      }
    }
    for (const id of localIds) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push(id)
      }
    }
    for (const id of remoteIds) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push(id)
      }
    }
    this.combinedWorkspaceOrder = result
    return result
  }

  /**
   * Return interleaved local and remote `WorkspaceView[]` in `getOrderedWorkspaceIds()` order.
   * @param {object[]} [localItemsOverride]
   */
  getOrderedWorkspaceViews(localItemsOverride) {
    const localItems = Array.isArray(localItemsOverride)
      ? localItemsOverride
      : (this.localWorkspaceBaseline.items ?? [])
    const byId = new Map()
    for (const w of localItems) {
      if (w?.workspaceId && parseLocalWorkspaceId(w.workspaceId) === null) {
        byId.set(w.workspaceId, w)
      }
    }
    for (const w of this.getProjectedWorkspaceViews()) {
      if (w?.workspaceId) {
        byId.set(w.workspaceId, w)
      }
    }
    const orderedIds = this.getOrderedWorkspaceIds(localItems)
    return orderedIds.map((id) => byId.get(id)).filter(Boolean)
  }

  /**
   * Load initial synced workspace records from storageDomain.
   * @param { Iterable<[string, object]> | Record<string, object> } entries
   */
  loadInitialWorkspaces(entries) {
    const iter = Array.isArray(entries) || typeof entries?.[Symbol.iterator] === 'function'
      ? entries
      : Object.entries(entries ?? {})
    for (const [key, raw] of iter) {
      try {
        const record = normalizeSyncedWorkspaceRecord({ ...raw, localWorkspaceId: key })
        this.syncedWorkspaces.set(record.localWorkspaceId, record)
        if (!this.syncedWorkspaceOrder.includes(record.localWorkspaceId)) {
          this.syncedWorkspaceOrder.push(record.localWorkspaceId)
        }
      } catch {}
    }
    if (this.combinedWorkspaceOrder.length > 0) {
      const remoteInOrder = this.combinedWorkspaceOrder.filter(
        (id) => this.syncedWorkspaces.has(id),
      )
      const rest = this.syncedWorkspaceOrder.filter((id) => !remoteInOrder.includes(id))
      this.syncedWorkspaceOrder = [...remoteInOrder, ...rest]
    }
  }

  /**
   * Called by `RemoteConnectionManager` when a remote SSH host becomes `connected`.
   * @param {string} host
   * @param {string} url - mapped local URL with launch token
   */
  async onHostConnected(host, url) {
    const hostKey = String(host || '').trim()
    if (!hostKey || !url) return null

    const existing = this.hostClients.get(hostKey)
    if (existing && existing.url === url && !existing.disposed) {
      return existing
    }
    if (existing) {
      existing.dispose()
    }

    const client = new RemoteHostGatewayClient({
      host: hostKey,
      url,
      bridge: this,
      fetchImpl: this.fetchImpl,
      createWs: this.createWs,
    })
    this.hostClients.set(hostKey, client)
    await client.startSync()
    return client
  }

  /**
   * Called by `RemoteConnectionManager` when a remote SSH host disconnects or errors.
   * Immediately hides all sessions under that host's workspaces (`sessionIds: []`)
   * and emits `api-session/removed` + `workspace/follow` `upsert` frames.
   * @param {string} host
   */
  onHostDisconnected(host) {
    const hostKey = String(host || '').trim()
    const client = this.hostClients.get(hostKey)
    if (client) {
      client.dispose()
      this.hostClients.delete(hostKey)
    }

    // Collect sessions that belonged to this host and remove them from local view
    const removedSessions = []
    for (const [sessionId, ownerHost] of this.sessionToHost.entries()) {
      if (ownerHost === hostKey) {
        this.sessionToHost.delete(sessionId)
        removedSessions.push(sessionId)
      }
    }

    for (const sessionId of removedSessions) {
      this._announcedLocalSessions.delete(sessionId)
      this._broadcastEventFrame({
        type: 'emit',
        event: 'api-session/removed',
        args: [sessionId],
      })
    }

    // Emit updated WorkspaceViews (with sessionIds: []) for every synced workspace on this host
    for (const ws of this.syncedWorkspaces.values()) {
      if (ws.host === hostKey && !ws.invalidated) {
        this._broadcastWorkspaceFrame({
          type: 'upsert',
          workspace: this.projectWorkspaceView(ws),
        })
      }
    }
  }

  /**
   * Return whether `host` currently has an active connected gateway client.
   * @param {string} host
   */
  isHostConnected(host) {
    const client = this.hostClients.get(host)
    return Boolean(client && !client.disposed)
  }

  /**
   * Project a persisted `SyncedWorkspaceRecord` into a DSH `WorkspaceView`.
   * - When the host is disconnected (or the workspace is invalidated), `sessionIds` is `[]`
   *   so sessions under this workspace cannot be viewed.
   * - When the host is connected, `sessionIds` is synchronized from the remote workspace.
   */
  projectWorkspaceView(record) {
    const client = this.hostClients.get(record.host)
    const isConnected = Boolean(client && !client.disposed) && !record.invalidated
    const remoteWs = isConnected ? client.remoteWorkspaces.get(record.remoteWorkspaceId) : null
    const sessionIds = isConnected && Array.isArray(remoteWs?.sessionIds)
      ? [...remoteWs.sessionIds]
      : []

    const rawUpdatedAt = remoteWs?.updatedAt || record.updatedAt
    const candidateMs = Date.parse(rawUpdatedAt)
    const sig = `${record.title}|${record.remotePath}|${isConnected ? '1' : '0'}|${sessionIds.join(',')}`
    const prev = this._projectedUpdatedAtState.get(record.localWorkspaceId)
    let resolvedMs = Number.isFinite(candidateMs) ? candidateMs : Date.now()
    if (prev) {
      if (prev.sig !== sig) {
        resolvedMs = Math.max(resolvedMs, prev.ms + 1, Date.now())
      } else {
        resolvedMs = Math.max(resolvedMs, prev.ms)
      }
    }
    this._projectedUpdatedAtState.set(record.localWorkspaceId, { ms: resolvedMs, sig })

    return {
      workspaceId: record.localWorkspaceId,
      path: record.remotePath,
      title: record.title,
      sessionIds,
      createdAt: remoteWs?.createdAt || record.createdAt,
      updatedAt: new Date(resolvedMs).toISOString(),
    }
  }

  /**
   * Return all non-invalidated synced remote workspaces as `WorkspaceView[]`.
   */
  getProjectedWorkspaceViews() {
    const views = []
    for (const id of this.syncedWorkspaceOrder) {
      const rec = this.syncedWorkspaces.get(id)
      if (rec) {
        views.push(this.projectWorkspaceView(rec))
      }
    }
    for (const [id, rec] of this.syncedWorkspaces.entries()) {
      if (!this.syncedWorkspaceOrder.includes(id)) {
        this.syncedWorkspaceOrder.push(id)
        views.push(this.projectWorkspaceView(rec))
      }
    }
    return views
  }

  /**
   * Return all synced workspace records enriched with live connection and invalidation status.
   * @param {(host: string) => string} [getHostStatusFn]
   */
  listSyncedWorkspaces(getHostStatusFn) {
    const result = []
    for (const id of this.syncedWorkspaceOrder) {
      const rec = this.syncedWorkspaces.get(id)
      if (!rec) continue
      const connected = this.isHostConnected(rec.host)
      const hostStatus = typeof getHostStatusFn === 'function'
        ? getHostStatusFn(rec.host)
        : (connected ? 'connected' : 'disconnected')
      const view = this.projectWorkspaceView(rec)
      const client = connected ? this.hostClients.get(rec.host) : null
      const rawSummaries = []
      if (client) {
        for (const sid of view.sessionIds) {
          const summary = client.remoteSessions.get(sid)
          if (summary) rawSummaries.push(summary)
        }
      }
      result.push({
        ...rec,
        hostStatus,
        connected,
        sessionCount: view.sessionIds.length,
        sessionIds: view.sessionIds,
        rawSummaries,
      })
    }
    return result
  }

  /**
   * List all workspaces on a connected remote host, marking which ones are already synced locally.
   * @param {string} host
   */
  async listRemoteWorkspaces(host) {
    const hostKey = String(host || '').trim()
    const client = this.hostClients.get(hostKey)
    if (!client || client.disposed) {
      throw new Error(`Host "${hostKey}" is not connected.`)
    }
    const items = await client.fetchRemoteWorkspacesSnapshot()
    return items.map((ws) => {
      const localWorkspaceId = makeLocalWorkspaceId(hostKey, ws.workspaceId)
      const syncedRecord = this.syncedWorkspaces.get(localWorkspaceId)
      return {
        remoteWorkspaceId: ws.workspaceId,
        localWorkspaceId,
        host: hostKey,
        path: ws.path,
        title: ws.title,
        sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds : [],
        sessionCount: Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0,
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
        synced: Boolean(syncedRecord && !syncedRecord.invalidated),
      }
    })
  }

  /**
   * Synchronize a remote workspace to the local DSH.
   * Accepts either an existing `remoteWorkspaceId` or a `path` on the remote host (which creates/resolves it remotely first).
   * @param {string} host
   * @param {object} options
   * @param {string} [options.remoteWorkspaceId]
   * @param {string} [options.path]
   * @param {string} [options.title]
   */
  async syncRemoteWorkspace(host, options = {}) {
    const hostKey = String(host || '').trim()
    if (!hostKey) throw new Error('Host alias is required.')
    const client = this.hostClients.get(hostKey)
    if (!client || client.disposed) {
      throw new Error(`Host "${hostKey}" must be connected before syncing a remote workspace.`)
    }

    await client.fetchRemoteWorkspacesSnapshot()

    let remoteWs = null
    if (options.remoteWorkspaceId) {
      remoteWs = client.remoteWorkspaces.get(String(options.remoteWorkspaceId).trim())
    }
    if (!remoteWs && options.path) {
      const cleanPath = String(options.path).trim()
      let createRes = await client.callRpc('workspace/create', { request: { path: cleanPath } })
      if (!createRes?.ok && createRes?.error?.code === 'gateway/arguments-invalid') {
        createRes = await client.callRpc('workspace/create', { path: cleanPath })
      }
      if (!createRes.ok) {
        throw new Error(createRes.error?.message || `Failed to create workspace at "${options.path}" on ${hostKey}`)
      }
      remoteWs = createRes.value?.workspace
      if (remoteWs && remoteWs.workspaceId) {
        client.remoteWorkspaces.set(remoteWs.workspaceId, remoteWs)
      }
    }
    if (!remoteWs && options.remoteWorkspaceId) {
      // Fallback if remote workspace metadata was passed directly
      if (options.remotePath || options.path) {
        remoteWs = {
          workspaceId: String(options.remoteWorkspaceId).trim(),
          path: String(options.remotePath || options.path).trim(),
          title: String(options.title || '').trim() || String(options.remotePath || options.path).split('/').pop(),
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        client.remoteWorkspaces.set(remoteWs.workspaceId, remoteWs)
      }
    }

    if (!remoteWs || !remoteWs.workspaceId) {
      throw new Error(`Remote workspace was not found on host "${hostKey}".`)
    }

    const localWorkspaceId = makeLocalWorkspaceId(hostKey, remoteWs.workspaceId)
    const displayTitle = options.title
      ? String(options.title).trim()
      : String(remoteWs.title || '').trim()

    const record = normalizeSyncedWorkspaceRecord({
      localWorkspaceId,
      host: hostKey,
      remoteWorkspaceId: remoteWs.workspaceId,
      remotePath: remoteWs.path,
      title: displayTitle,
      createdAt: remoteWs.createdAt,
      updatedAt: remoteWs.updatedAt,
      invalidated: false,
      invalidationReason: null,
    })

    const isNew = !this.syncedWorkspaces.has(localWorkspaceId)
    this.syncedWorkspaces.set(localWorkspaceId, record)
    if (isNew) {
      this.syncedWorkspaceOrder = [
        localWorkspaceId,
        ...this.syncedWorkspaceOrder.filter((id) => id !== localWorkspaceId),
      ]
      if (!this.combinedWorkspaceOrder.includes(localWorkspaceId)) {
        this.combinedWorkspaceOrder = [localWorkspaceId, ...this.combinedWorkspaceOrder]
        await this.onSaveWorkspaceOrder(this.combinedWorkspaceOrder)
      }
    }
    await this.onSaveWorkspace(localWorkspaceId, record)

    await client.refreshSessionList()
    this._reconcileHostSessions(hostKey)

    const view = this.projectWorkspaceView(record)
    this._broadcastWorkspaceFrame({
      type: 'upsert',
      workspace: view,
    })
    this._broadcastWorkspaceOrder()

    // Also announce all sessions of this newly synced workspace to local clients
    for (const sessionId of view.sessionIds) {
      const summary = client.remoteSessions.get(sessionId)
      if (summary) {
        this._broadcastEventFrame({
          type: 'emit',
          event: 'api-session/added',
          args: [summary],
        })
      }
    }

    return {
      synced: true,
      workspace: record,
      view,
    }
  }

  /**
   * Remove a synced remote workspace from local persistence and emit `remove` to the UI.
   * @param {string} localWorkspaceId
   */
  async removeSyncedWorkspace(localWorkspaceId) {
    const id = String(localWorkspaceId || '').trim()
    const record = this.syncedWorkspaces.get(id)
    if (!record) return { removed: false }

    const client = this.hostClients.get(record.host)
    const remoteWs = client?.remoteWorkspaces.get(record.remoteWorkspaceId)
    const oldSessionIds = Array.isArray(remoteWs?.sessionIds) ? [...remoteWs.sessionIds] : []

    this.syncedWorkspaces.delete(id)
    this._projectedUpdatedAtState.delete(id)
    this.syncedWorkspaceOrder = this.syncedWorkspaceOrder.filter((k) => k !== id)
    if (this.combinedWorkspaceOrder.includes(id)) {
      this.combinedWorkspaceOrder = this.combinedWorkspaceOrder.filter((k) => k !== id)
      await this.onSaveWorkspaceOrder(this.combinedWorkspaceOrder)
    }
    await this.onSaveWorkspace(id, null)

    this._reconcileHostSessions(record.host)

    this._broadcastWorkspaceFrame({
      type: 'remove',
      workspaceId: id,
    })

    for (const sessionId of oldSessionIds) {
      if (!this.isSessionVisibleLocally(sessionId)) {
        this._announcedLocalSessions.delete(sessionId)
        this._broadcastEventFrame({
          type: 'emit',
          event: 'api-session/removed',
          args: [sessionId],
        })
      }
    }

    return { removed: true, localWorkspaceId: id }
  }

  /**
   * Recompute which sessions on `host` belong to synced workspaces (plus their subagent descendants).
   */
  _reconcileHostSessions(host) {
    const client = this.hostClients.get(host)
    // Clear previous mappings for this host
    for (const [sid, h] of this.sessionToHost.entries()) {
      if (h === host) this.sessionToHost.delete(sid)
    }
    if (!client || client.disposed) return

    const syncedRemoteWsIds = new Set()
    for (const rec of this.syncedWorkspaces.values()) {
      if (rec.host === host && !rec.invalidated) {
        syncedRemoteWsIds.add(rec.remoteWorkspaceId)
      }
    }

    const admittedSessions = new Set()
    for (const remoteWsId of syncedRemoteWsIds) {
      const ws = client.remoteWorkspaces.get(remoteWsId)
      if (ws && Array.isArray(ws.sessionIds)) {
        for (const sid of ws.sessionIds) {
          admittedSessions.add(sid)
          this.sessionToHost.set(sid, host)
        }
      }
    }

    // Also admit subagent children of admitted sessions
    let addedChild = true
    while (addedChild) {
      addedChild = false
      for (const [sid, summary] of client.remoteSessions.entries()) {
        if (!admittedSessions.has(sid) && summary.parentSessionId && admittedSessions.has(summary.parentSessionId)) {
          admittedSessions.add(sid)
          this.sessionToHost.set(sid, host)
          addedChild = true
        }
      }
      for (const [parentId, proj] of client.remoteProjections.entries()) {
        if (!admittedSessions.has(parentId)) continue
        for (const child of proj?.values?.subagentCatalog ?? []) {
          if (child?.id && !admittedSessions.has(child.id)) {
            admittedSessions.add(child.id)
            this.sessionToHost.set(child.id, host)
            addedChild = true
          }
        }
      }
    }

    // Announce any newly admitted session summaries to live local clients
    for (const sid of admittedSessions) {
      const summary = client.remoteSessions.get(sid)
      if (summary && !this._announcedLocalSessions.has(sid)) {
        this._announcedLocalSessions.add(sid)
        this._broadcastEventFrame({
          type: 'emit',
          event: 'api-session/added',
          args: [summary],
        })
      }
    }
  }

  isSessionVisibleLocally(sessionId) {
    return this.sessionToHost.has(sessionId)
  }

  getHostForSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null
    return this.sessionToHost.get(sessionId) ?? null
  }

  getClientForSession(sessionId) {
    const host = this.getHostForSession(sessionId)
    if (!host) return null
    const client = this.hostClients.get(host)
    return client && !client.disposed ? client : null
  }

  _handleRemoteWorkspaceBaseline(host) {
    const client = this.hostClients.get(host)
    if (!client) return

    this._reconcileHostSessions(host)

    for (const [localId, rec] of this.syncedWorkspaces.entries()) {
      if (rec.host !== host) continue
      const remoteWs = client.remoteWorkspaces.get(rec.remoteWorkspaceId)
      if (!remoteWs) {
        // Remote workspace was deleted on the remote DSH!
        if (!rec.invalidated) {
          const updated = {
            ...rec,
            invalidated: true,
            invalidationReason: 'deleted_on_remote',
            updatedAt: new Date().toISOString(),
          }
          this.syncedWorkspaces.set(localId, updated)
          void this.onSaveWorkspace(localId, updated)
        }
        this._broadcastWorkspaceFrame({
          type: 'upsert',
          workspace: this.projectWorkspaceView(this.syncedWorkspaces.get(localId)),
        })
      } else {
        if (rec.invalidated) {
          const restored = { ...rec, invalidated: false, invalidationReason: null }
          this.syncedWorkspaces.set(localId, restored)
          void this.onSaveWorkspace(localId, restored)
        }
        this._broadcastWorkspaceFrame({
          type: 'upsert',
          workspace: this.projectWorkspaceView(this.syncedWorkspaces.get(localId)),
        })
      }
    }
    this._handleRemoteArchivedChanged(host)
    this._handleRemotePinnedChanged(host)
  }

  _handleRemoteWorkspaceUpsert(host, remoteWs) {
    const localId = makeLocalWorkspaceId(host, remoteWs.workspaceId)
    const rec = this.syncedWorkspaces.get(localId)
    if (!rec) return
    this._reconcileHostSessions(host)
    this._broadcastWorkspaceFrame({
      type: 'upsert',
      workspace: this.projectWorkspaceView(rec),
    })
  }

  _handleRemoteWorkspaceRemoved(host, remoteWorkspaceId) {
    const localId = makeLocalWorkspaceId(host, remoteWorkspaceId)
    const rec = this.syncedWorkspaces.get(localId)
    if (!rec) return

    // Mark as invalidated so the UI pops up the confirmation dialog before removing
    const updated = {
      ...rec,
      invalidated: true,
      invalidationReason: 'deleted_on_remote',
      updatedAt: new Date().toISOString(),
    }
    this.syncedWorkspaces.set(localId, updated)
    void this.onSaveWorkspace(localId, updated)
    this._reconcileHostSessions(host)

    this._broadcastWorkspaceFrame({
      type: 'upsert',
      workspace: this.projectWorkspaceView(updated),
    })
  }

  _handleRemoteWorkspaceOrderChanged(_host) {
    this._broadcastWorkspaceOrder()
  }

  _handleRemoteArchivedChanged(_host) {
    this._broadcastWorkspaceFrame({
      type: 'archived',
      archivedSessionIds: this.getCombinedArchivedSessionIds(),
    })
  }

  _handleRemotePinnedChanged(_host) {
    this._broadcastWorkspaceFrame({
      type: 'pinned',
      pinnedSessionIds: this.getCombinedPinnedSessionIds(),
    })
  }

  _handleRemoteControlBaseline(host) {
    this._reconcileHostSessions(host)
    const client = this.hostClients.get(host)
    if (!client) return
    for (const [sessionId, projection] of client.remoteProjections.entries()) {
      if (this.isSessionVisibleLocally(sessionId)) {
        const changes = Object.entries(projection?.values ?? {}).map(([key, val]) => ({ key, val }))
        if (changes.length > 0) {
          this._broadcastControlFrame({
            type: 'projection',
            sessionId,
            seq: projection.asOfSeq ?? 0,
            changes,
          })
        }
      }
    }
  }

  _handleRemoteControlProjection(host, frame) {
    this._reconcileHostSessions(host)
    if (this.isSessionVisibleLocally(frame.sessionId)) {
      this._broadcastControlFrame(frame)
    }
  }

  _handleRemoteWaterfallFrame(host, remoteClientId, frame) {
    if (frame?.eventId && remoteClientId) {
      this.pendingWaterfalls.set(frame.eventId, { host, remoteClientId })
    }
    this._broadcastEventFrame(frame)
  }

  _handleRemoteCancelFrame(_host, frame) {
    if (frame?.eventId) {
      this.pendingWaterfalls.delete(frame.eventId)
    }
    this._broadcastEventFrame(frame)
  }

  getCombinedArchivedSessionIds() {
    const set = new Set(this.localWorkspaceBaseline.archivedSessionIds)
    for (const [host, client] of this.hostClients.entries()) {
      if (client.disposed) continue
      for (const sid of client.remoteArchivedSessionIds) {
        if (this.sessionToHost.get(sid) === host) {
          set.add(sid)
        }
      }
    }
    return [...set]
  }

  getCombinedPinnedSessionIds() {
    const set = new Set(this.localWorkspaceBaseline.pinnedSessionIds)
    for (const [host, client] of this.hostClients.entries()) {
      if (client.disposed) continue
      for (const sid of client.remotePinnedSessionIds) {
        if (this.sessionToHost.get(sid) === host) {
          set.add(sid)
        }
      }
    }
    return [...set]
  }

  getCombinedSessionSummaries(localItems = []) {
    const byId = new Map()
    for (const item of localItems) {
      if (item && typeof item.sessionId === 'string') {
        byId.set(item.sessionId, item)
      }
    }
    for (const [host, client] of this.hostClients.entries()) {
      if (client.disposed) continue
      for (const [sid, summary] of client.remoteSessions.entries()) {
        if (this.sessionToHost.get(sid) === host) {
          byId.set(sid, summary)
        }
      }
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  getCombinedProjections(localProjections = {}) {
    const merged = { ...localProjections }
    for (const [host, client] of this.hostClients.entries()) {
      if (client.disposed) continue
      for (const [sid, proj] of client.remoteProjections.entries()) {
        if (this.sessionToHost.get(sid) === host) {
          merged[sid] = proj
        }
      }
    }
    return merged
  }

  _broadcastWorkspaceFrame(frame) {
    for (const q of this.workspaceFollowers) {
      q.push(frame)
    }
    // Fallback for `workspace/follow` streams opened before the gateway interception was installed
    // (e.g. pages already open when the plugin is enabled). Once any merged follower exists, every
    // local feed follower may be the one backing a merged stream; pushing remote frames into it would
    // echo them back through `_openMergedWorkspaceFollowStream` (duplicates and a polluted local
    // baseline), so the fallback only applies while no merged follower is open, as for control/events.
    if (this.workspaceFollowers.size === 0 && this.attachedWorkspaceFeed?.followers) {
      for (const follower of this.attachedWorkspaceFeed.followers) {
        try {
          follower.push(frame)
        } catch {}
      }
    }
  }

  _broadcastWorkspaceOrder() {
    if (this.attachedWorkspaceFeed?.baseline) {
      try {
        const base = this.attachedWorkspaceFeed.baseline()
        if (base?.items) {
          this.localWorkspaceBaseline.items = base.items.filter(
            (w) => parseLocalWorkspaceId(w.workspaceId) === null,
          )
        }
      } catch {}
    }
    const workspaceIds = [...this.getOrderedWorkspaceIds()]
    this._broadcastWorkspaceFrame({
      type: 'order',
      workspaceIds,
    })
  }

  _broadcastControlFrame(frame) {
    for (const q of this.controlFollowers) {
      q.push(frame)
    }
    if (this.controlFollowers.size === 0 && this.attachedControlState?.streams) {
      for (const stream of this.attachedControlState.streams) {
        try {
          stream.push(frame)
        } catch {}
      }
    }
  }

  _broadcastEventFrame(frame) {
    for (const q of this.eventFollowers) {
      q.push(frame)
    }
    if (this.eventFollowers.size === 0 && this.attachedGateway?.remoteEventClients) {
      for (const client of this.attachedGateway.remoteEventClients.values()) {
        try {
          client.queue?.push?.(frame)
        } catch {}
      }
    }
  }

  /**
   * Intercept a unary RPC on `typertGateway.dispatchRpc(endpoint, payload, signal, peer)`.
   * Returns `undefined` when the call should be handled normally by the local Host.
   */
  async interceptRpc(endpoint, payload, signal, peer, callLocalRpc) {
    const args = payload?.args ?? {}

    // 1. $events/result for a remote waterfall event (e.g. approval/request or user-questions/request)
    if (endpoint === '$events/result') {
      const eventId = args?.eventId
      const pending = eventId ? this.pendingWaterfalls.get(eventId) : undefined
      if (pending) {
        this.pendingWaterfalls.delete(eventId)
        const client = this.hostClients.get(pending.host)
        if (!client || client.disposed) {
          return { ok: true, value: undefined }
        }
        return client.callRpc('$events/result', {
          ...args,
          clientId: pending.remoteClientId,
        }, signal)
      }
      return undefined
    }

    // 2. Workspace endpoints targeting a synced remote workspace or remote session
    if (endpoint.startsWith('workspace/')) {
      const sub = endpoint.slice('workspace/'.length)
      const req = args.request ?? args

      if (sub === 'rename' && typeof req?.workspaceId === 'string') {
        const parsed = parseLocalWorkspaceId(req.workspaceId)
        if (parsed) {
          const rec = this.syncedWorkspaces.get(req.workspaceId)
          if (!rec) {
            return {
              ok: false,
              error: { code: 'workspace/not-found', message: `Workspace "${req.workspaceId}" not found`, details: {} },
            }
          }
          const newTitle = String(req.title ?? '').trim()
          if (!newTitle) {
            return {
              ok: false,
              error: { code: 'workspace/title-invalid', message: 'Workspace title cannot be empty', details: {} },
            }
          }
          const updated = { ...rec, title: newTitle, updatedAt: new Date().toISOString() }
          this.syncedWorkspaces.set(req.workspaceId, updated)
          await this.onSaveWorkspace(req.workspaceId, updated)
          const client = this.hostClients.get(parsed.host)
          if (client && !client.disposed) {
            await client.callRpc('workspace/rename', {
              request: { workspaceId: parsed.remoteWorkspaceId, title: newTitle },
            }, signal).catch(() => {})
          }
          const view = this.projectWorkspaceView(updated)
          this._broadcastWorkspaceFrame({ type: 'upsert', workspace: view })
          return { ok: true, value: { workspace: view } }
        }
      }

      if (sub === 'delete' && typeof req?.workspaceId === 'string') {
        const parsed = parseLocalWorkspaceId(req.workspaceId)
        if (parsed) {
          await this.removeSyncedWorkspace(req.workspaceId)
          return { ok: true, value: { deleted: true } }
        }
      }

      if (sub === 'insertBefore' && typeof req?.workspaceId === 'string') {
        const currentOrder = this.getOrderedWorkspaceIds()
        const movedId = req.workspaceId
        const beforeId = typeof req.beforeWorkspaceId === 'string' && req.beforeWorkspaceId
          ? req.beforeWorkspaceId
          : undefined
        if (currentOrder.includes(movedId)) {
          if (beforeId !== movedId && (beforeId === undefined || currentOrder.includes(beforeId))) {
            const without = currentOrder.filter((id) => id !== movedId)
            const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
            this.combinedWorkspaceOrder = [...without.slice(0, at), movedId, ...without.slice(at)]
          }
          this.syncedWorkspaceOrder = this.combinedWorkspaceOrder.filter(
            (id) => parseLocalWorkspaceId(id) !== null,
          )
          await this.onSaveWorkspaceOrder(this.combinedWorkspaceOrder)
          if (parseLocalWorkspaceId(movedId) === null && typeof callLocalRpc === 'function') {
            const movedIdx = this.combinedWorkspaceOrder.indexOf(movedId)
            const nextLocalAnchor = this.combinedWorkspaceOrder
              .slice(movedIdx + 1)
              .find((id) => parseLocalWorkspaceId(id) === null)
            await callLocalRpc(
              endpoint,
              {
                ...payload,
                args: {
                  request: {
                    workspaceId: movedId,
                    ...(nextLocalAnchor ? { beforeWorkspaceId: nextLocalAnchor } : {}),
                  },
                },
              },
              signal,
              peer,
            ).catch(() => {})
          }
          const workspaceIds = [...this.combinedWorkspaceOrder]
          this._broadcastWorkspaceFrame({ type: 'order', workspaceIds })
          return { ok: true, value: { workspaceIds } }
        }
      }

      if (sub === 'insertSessionBefore' && typeof req?.workspaceId === 'string') {
        const parsed = parseLocalWorkspaceId(req.workspaceId)
        if (parsed) {
          const client = this.hostClients.get(parsed.host)
          if (!client || client.disposed) {
            return {
              ok: false,
              error: { code: 'workspace/not-connected', message: `Host "${parsed.host}" is not connected`, details: {} },
            }
          }
          const res = await client.callRpc('workspace/insertSessionBefore', {
            request: {
              workspaceId: parsed.remoteWorkspaceId,
              sessionId: req.sessionId,
              ...(req.beforeSessionId !== undefined ? { beforeSessionId: req.beforeSessionId } : {}),
            },
          }, signal)
          if (!res.ok) return res
          if (res.value?.workspace) {
            client.remoteWorkspaces.set(parsed.remoteWorkspaceId, res.value.workspace)
          }
          const rec = this.syncedWorkspaces.get(req.workspaceId)
          const view = rec ? this.projectWorkspaceView(rec) : res.value?.workspace
          return { ok: true, value: { workspace: view } }
        }
      }

      if ((sub === 'archiveSession' || sub === 'unarchiveSession' || sub === 'pinSession' || sub === 'unpinSession') && typeof req?.sessionId === 'string') {
        const client = this.getClientForSession(req.sessionId)
        if (client) {
          const res = await client.callRpc(endpoint, args, signal)
          if (!res.ok) return res
          if (sub === 'archiveSession' || sub === 'unarchiveSession') {
            client.remoteArchivedSessionIds = Array.isArray(res.value?.archivedSessionIds)
              ? [...res.value.archivedSessionIds]
              : client.remoteArchivedSessionIds
            return { ok: true, value: { archivedSessionIds: this.getCombinedArchivedSessionIds() } }
          }
          if (sub === 'pinSession' || sub === 'unpinSession') {
            client.remotePinnedSessionIds = Array.isArray(res.value?.pinnedSessionIds)
              ? [...res.value.pinnedSessionIds]
              : client.remotePinnedSessionIds
            return { ok: true, value: { pinnedSessionIds: this.getCombinedPinnedSessionIds() } }
          }
        }
      }

      return undefined
    }

    // 3. session/list and session/search: aggregate local + connected remote hosts
    if (endpoint === 'session/list') {
      const localRes = await callLocalRpc(endpoint, payload, signal, peer)
      if (!localRes.ok) return localRes
      await Promise.allSettled(
        [...this.hostClients.values()].map((c) => c.refreshSessionList()),
      )
      const combined = this.getCombinedSessionSummaries(localRes.value?.items ?? [])
      return {
        ok: true,
        value: { items: combined },
      }
    }

    if (endpoint === 'session/search') {
      const localRes = await callLocalRpc(endpoint, payload, signal, peer)
      const remoteResults = await Promise.allSettled(
        [...this.hostClients.entries()].map(async ([host, client]) => {
          const r = await client.callRpc('session/search', args, signal)
          return { host, r }
        }),
      )
      const baseItems = localRes.ok && Array.isArray(localRes.value?.items) ? [...localRes.value.items] : []
      let hasMore = Boolean(localRes.ok && localRes.value?.hasMore)
      const seen = new Set(baseItems.map((i) => i.sessionId))
      for (const settled of remoteResults) {
        if (settled.status !== 'fulfilled') continue
        const { host, r } = settled.value
        if (r?.ok && Array.isArray(r.value?.items)) {
          if (r.value.hasMore) hasMore = true
          for (const item of r.value.items) {
            if (item?.sessionId && !seen.has(item.sessionId) && this.sessionToHost.get(item.sessionId) === host) {
              seen.add(item.sessionId)
              baseItems.push(item)
            }
          }
        }
      }
      return {
        ok: true,
        value: { items: baseItems, hasMore },
      }
    }

    // 4. session/create: check if workspaceId is a remote workspace (or sessionId is a remote session)
    if (endpoint === 'session/create') {
      const req = args.request ?? args
      const parsedWs = typeof req?.workspaceId === 'string' ? parseLocalWorkspaceId(req.workspaceId) : null
      const existingHost = typeof req?.sessionId === 'string' ? this.getHostForSession(req.sessionId) : null
      const targetHost = parsedWs?.host ?? existingHost

      if (targetHost) {
        const rec = parsedWs ? this.syncedWorkspaces.get(req.workspaceId) : null
        if (rec?.invalidated) {
          return {
            ok: false,
            error: {
              code: 'workspace/not-found',
              message: `Remote workspace "${rec.title}" has been deleted on host "${targetHost}".`,
              details: { workspaceId: req.workspaceId },
            },
          }
        }
        const client = this.hostClients.get(targetHost)
        if (!client || client.disposed) {
          return {
            ok: false,
            error: {
              code: 'workspace/not-connected',
              message: `Remote host "${targetHost}" is not connected. Please connect to the host first.`,
              details: { host: targetHost },
            },
          }
        }
        const remoteReq = {
          ...req,
          ...(parsedWs ? { workspaceId: parsedWs.remoteWorkspaceId } : {}),
        }
        const res = await client.callRpc('session/create', { request: remoteReq }, signal)
        if (res.ok && res.value?.sessionId) {
          const newSessionId = res.value.sessionId
          this.sessionToHost.set(newSessionId, targetHost)
          if (parsedWs) {
            const rws = client.remoteWorkspaces.get(parsedWs.remoteWorkspaceId)
            if (rws && Array.isArray(rws.sessionIds) && !rws.sessionIds.includes(newSessionId)) {
              client.remoteWorkspaces.set(parsedWs.remoteWorkspaceId, {
                ...rws,
                sessionIds: [newSessionId, ...rws.sessionIds],
              })
            }
          }
          await client.refreshSessionList().catch(() => {})
          if (rec) {
            this._broadcastWorkspaceFrame({
              type: 'upsert',
              workspace: this.projectWorkspaceView(rec),
            })
          }
        }
        return res
      }
      return undefined
    }

    // 5. session/modelCatalog: if targeted at a specific remote host or remote session, return that remote host's catalog;
    //    otherwise delegate to the local Host so local sessions see only locally configured models.
    if (endpoint === 'session/modelCatalog') {
      const targetSessionId = extractSessionIdFromArgs(args)
      const targetHost = (typeof args?.host === 'string' && args.host.trim())
        ? args.host.trim()
        : (targetSessionId ? this.getHostForSession(targetSessionId) : null)
      if (targetHost) {
        const client = this.hostClients.get(targetHost)
        if (!client || client.disposed) {
          return {
            ok: false,
            error: {
              code: 'workspace/not-connected',
              message: `Remote host "${targetHost}" is not connected.`,
              details: { host: targetHost },
            },
          }
        }
        return client.callRpc('session/modelCatalog', {}, signal, 15_000)
      }
      return undefined
    }

    // 6. Any Session-scoped / Agent-scoped RPC (session/*, workspaceFiles/*, terminal/*, jobs/*, commands/*, skills/*, fileReferences/*, fileUploads/*, actionCards/*, userQuestions/*, etc.)
    const sessionId = extractSessionIdFromArgs(args)
    if (sessionId) {
      const client = this.getClientForSession(sessionId)
      if (client) {
        const res = await client.callRpc(endpoint, args, signal)
        // If a forked child session was created on the remote host, register its sessionId immediately
        if (endpoint === 'session/fork' && res.ok && res.value?.sessionId) {
          this.sessionToHost.set(res.value.sessionId, client.host)
          await client.refreshSessionList().catch(() => {})
        }
        // Graceful fallback when a local-only plugin invokes an RPC endpoint that does not exist on the remote host
        if (!res.ok && (
          res.error?.code === 'gateway/invocation-unavailable' ||
          res.error?.code === 'gateway/service-unavailable' ||
          res.error?.code === 'gateway/method-unavailable'
        )) {
          if (endpoint.endsWith('/list') || endpoint.endsWith('/candidates')) {
            return { ok: true, value: [] }
          }
        }
        return res
      }
    }

    return undefined
  }

  /**
   * Intercept a stream opening on `typertGateway.openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow)`.
   * Returns `undefined` when the stream is purely local.
   */
  interceptStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow, openLocalStream) {
    const args = payload?.args ?? {}

    // 1. workspace/follow: merge local workspace/follow stream with synced remote workspaces
    if (endpoint === 'workspace/follow') {
      return this._openMergedWorkspaceFollowStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream)
    }

    // 2. session/control: merge local session/control stream with connected remote hosts' projections
    if (endpoint === 'session/control') {
      return this._openMergedSessionControlStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream)
    }

    // 3. $events: merge local $events stream with connected remote hosts' $events
    if (endpoint === '$events') {
      return this._openMergedEventsStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream)
    }

    // 4. Per-session streams (session/follow, session/observe*, workspaceFiles/changes, terminal/*, userQuestions/attachWait, etc.)
    const sessionId = extractSessionIdFromArgs(args)
    if (sessionId) {
      const client = this.getClientForSession(sessionId)
      if (client) {
        return Promise.resolve(client.openStream(endpoint, payload, signal, uplink))
      }
    }

    return undefined
  }

  async _openMergedWorkspaceFollowStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream) {
    const localStream = await openLocalStream('workspace/follow', payload, uplink, peer, signal, control, uplinkWindow)
    const queue = new AsyncStreamQueue(() => {
      this.workspaceFollowers.delete(queue)
    })
    this.workspaceFollowers.add(queue)

    ;(async () => {
      try {
        for await (const frame of localStream) {
          if (signal?.aborted) break
          if (frame.type === 'baseline' || frame.type === 'replace') {
            this.localWorkspaceBaseline = {
              items: [...(frame.value?.items ?? [])].filter((w) => parseLocalWorkspaceId(w.workspaceId) === null),
              archivedSessionIds: [...(frame.value?.archivedSessionIds ?? [])],
              pinnedSessionIds: [...(frame.value?.pinnedSessionIds ?? [])],
            }
            queue.push({
              type: frame.type,
              value: {
                items: this.getOrderedWorkspaceViews(this.localWorkspaceBaseline.items),
                archivedSessionIds: this.getCombinedArchivedSessionIds(),
                pinnedSessionIds: this.getCombinedPinnedSessionIds(),
              },
            })
          } else if (frame.type === 'upsert') {
            if (parseLocalWorkspaceId(frame.workspace?.workspaceId) !== null) continue
            const wsId = frame.workspace.workspaceId
            const idx = this.localWorkspaceBaseline.items.findIndex((w) => w.workspaceId === wsId)
            if (idx >= 0) {
              this.localWorkspaceBaseline.items[idx] = frame.workspace
            } else {
              this.localWorkspaceBaseline.items.unshift(frame.workspace)
              if (!this.combinedWorkspaceOrder.includes(wsId)) {
                this.combinedWorkspaceOrder = [wsId, ...this.combinedWorkspaceOrder]
                void this.onSaveWorkspaceOrder(this.combinedWorkspaceOrder)
              }
            }
            queue.push(frame)
          } else if (frame.type === 'remove') {
            if (parseLocalWorkspaceId(frame.workspaceId) !== null) continue
            this.localWorkspaceBaseline.items = this.localWorkspaceBaseline.items.filter((w) => w.workspaceId !== frame.workspaceId)
            if (this.combinedWorkspaceOrder.includes(frame.workspaceId)) {
              this.combinedWorkspaceOrder = this.combinedWorkspaceOrder.filter((id) => id !== frame.workspaceId)
              void this.onSaveWorkspaceOrder(this.combinedWorkspaceOrder)
            }
            queue.push(frame)
          } else if (frame.type === 'order') {
            queue.push({
              type: 'order',
              workspaceIds: [...this.getOrderedWorkspaceIds()],
            })
          } else if (frame.type === 'archived') {
            this.localWorkspaceBaseline.archivedSessionIds = [...frame.archivedSessionIds]
            queue.push({
              type: 'archived',
              archivedSessionIds: this.getCombinedArchivedSessionIds(),
            })
          } else if (frame.type === 'pinned') {
            this.localWorkspaceBaseline.pinnedSessionIds = [...frame.pinnedSessionIds]
            queue.push({
              type: 'pinned',
              pinnedSessionIds: this.getCombinedPinnedSessionIds(),
            })
          } else {
            queue.push(frame)
          }
        }
        queue.end()
      } catch (err) {
        queue.fail(err)
      } finally {
        this.workspaceFollowers.delete(queue)
      }
    })()

    return queue
  }

  async _openMergedSessionControlStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream) {
    const localStream = await openLocalStream('session/control', payload, uplink, peer, signal, control, uplinkWindow)
    const queue = new AsyncStreamQueue(() => {
      this.controlFollowers.delete(queue)
    })
    this.controlFollowers.add(queue)

    ;(async () => {
      try {
        for await (const frame of localStream) {
          if (signal?.aborted) break
          if (frame.type === 'baseline') {
            queue.push({
              type: 'baseline',
              value: {
                ...frame.value,
                projections: this.getCombinedProjections(frame.value?.projections ?? {}),
              },
            })
          } else {
            queue.push(frame)
          }
        }
        queue.end()
      } catch (err) {
        queue.fail(err)
      } finally {
        this.controlFollowers.delete(queue)
      }
    })()

    return queue
  }

  async _openMergedEventsStream(payload, uplink, peer, signal, control, uplinkWindow, openLocalStream) {
    const localStream = await openLocalStream('$events', payload, uplink, peer, signal, control, uplinkWindow)
    const queue = new AsyncStreamQueue(() => {
      this.eventFollowers.delete(queue)
    })
    this.eventFollowers.add(queue)

    ;(async () => {
      try {
        for await (const frame of localStream) {
          if (signal?.aborted) break
          queue.push(frame)
        }
        queue.end()
      } catch (err) {
        queue.fail(err)
      } finally {
        this.eventFollowers.delete(queue)
      }
    })()

    return queue
  }

  /**
   * Proxy raw binary file uploads (`/api/session/uploadFileBinary?sessionId=...`) when `sessionId`
   * belongs to a connected remote host. Called only from the `connection/request` waterfall, which
   * client-connection runs after `connection.admit(req)` accepted the request, so the caller is an
   * authenticated same-origin browser of this Host.
   */
  async tryProxyRawHttpRequest(req, res) {
    if (!req.url || !req.url.startsWith('/api/session/uploadFileBinary')) {
      return false
    }
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      return false
    }
    let parsed
    try {
      parsed = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return false
    }
    if (parsed.pathname !== '/api/session/uploadFileBinary') {
      return false
    }
    const sessionId = parsed.searchParams.get('sessionId')
    if (!sessionId) return false
    const client = this.getClientForSession(sessionId)
    if (!client) return false

    const cookie = await client.ensureAuthCookie()
    if (!cookie) return false

    const chunks = []
    let totalBytes = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.length
      if (totalBytes > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'Upload payload too large' }))
        return true
      }
      chunks.push(buf)
    }
    const bodyBuf = Buffer.concat(chunks)

    const targetUrl = `${client.baseOrigin}${parsed.pathname}${parsed.search}`
    const upstreamRes = await client.fetchImpl(targetUrl, {
      method: 'POST',
      headers: {
        host: client.parsedUrl.host,
        'content-type': req.headers['content-type'] || 'application/octet-stream',
        cookie,
      },
      body: bodyBuf,
    })

    const text = await upstreamRes.text()
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
    return true
  }

  dispose() {
    this.detachHostControllers()
    for (const client of this.hostClients.values()) {
      client.dispose()
    }
    this.hostClients.clear()
    this.sessionToHost.clear()
    for (const q of this.workspaceFollowers) q.end()
    for (const q of this.controlFollowers) q.end()
    for (const q of this.eventFollowers) q.end()
    this.workspaceFollowers.clear()
    this.controlFollowers.clear()
    this.eventFollowers.clear()
  }
}
