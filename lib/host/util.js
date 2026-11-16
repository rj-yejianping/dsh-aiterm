/**
 * Small helpers shared by the host half: a byte ring buffer for session replay,
 * base64 helpers, bounded JSON body reading, atomic JSON persistence, and HTTP
 * error objects carrying a stable code.
 *
 * Nothing here imports `@deepseek-ai/*`: this plugin lives outside the harness
 * package tree and reaches every capability through runtime services.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Fixed-capacity byte FIFO that keeps the most recent output for replay.
 *
 * Bytes are kept in one contiguous buffer with a moving tail; when the write
 * would overflow, the oldest bytes are dropped. `toBuffer()` returns the
 * retained bytes in arrival order, which is exactly what a reconnecting xterm
 * needs to rebuild the screen.
 */
export class ByteRing {
  /**
   * @param {number} capacity maximum retained bytes.
   */
  constructor(capacity) {
    this.capacity = Math.max(1024, Math.floor(capacity))
    this.buffer = Buffer.allocUnsafe(this.capacity)
    this.start = 0
    this.length = 0
    /** Total bytes ever written (monotonic), useful for diagnostics. */
    this.total = 0
  }

  /**
   * Append bytes, dropping the oldest retained bytes on overflow.
   * @param {Buffer|Uint8Array|string} chunk bytes (strings are UTF-8 encoded).
   * @returns {void}
   */
  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (data.length === 0) return
    this.total += data.length
    if (data.length >= this.capacity) {
      // The new chunk alone fills the ring: keep only its tail.
      data.copy(this.buffer, 0, data.length - this.capacity)
      this.start = 0
      this.length = this.capacity
      return
    }
    const end = (this.start + this.length) % this.capacity
    const first = Math.min(data.length, this.capacity - end)
    data.copy(this.buffer, end, 0, first)
    if (first < data.length) data.copy(this.buffer, 0, first)
    this.length = Math.min(this.capacity, this.length + data.length)
    const overflow = this.length - this.capacity
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity
      this.length = this.capacity
    }
  }

  /**
   * @returns {Buffer} retained bytes, oldest first.
   */
  toBuffer() {
    if (this.length === 0) return Buffer.alloc(0)
    const out = Buffer.allocUnsafe(this.length)
    const first = Math.min(this.length, this.capacity - this.start)
    this.buffer.copy(out, 0, this.start, this.start + first)
    if (first < this.length) this.buffer.copy(out, first, 0, this.length - first)
    return out
  }

  /** @returns {string} retained bytes decoded as UTF-8. */
  toString() {
    return this.toBuffer().toString('utf8')
  }

  /** Forget everything retained (keeps the capacity). @returns {void} */
  clear() {
    this.start = 0
    this.length = 0
  }
}

/**
 * @param {Buffer|Uint8Array|string} value bytes to encode.
 * @returns {string} standard base64.
 */
export function toBase64(value) {
  return Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(value).toString('base64')
}

/**
 * An error carrying a stable machine-readable code and an HTTP status.
 */
export class CodedError extends Error {
  /**
   * @param {string} code stable code such as `AI_WRITE_DENIED`.
   * @param {string} message human readable explanation.
   * @param {number} [statusCode] HTTP status for the RPC surface.
   */
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'CodedError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * Build a coded error.
 * @param {string} code stable code.
 * @param {string} message explanation.
 * @param {number} [statusCode] HTTP status.
 * @returns {CodedError} the error.
 */
export function coded(code, message, statusCode = 400) {
  return new CodedError(code, message, statusCode)
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} [maxBytes] accepted body size.
 * @returns {Promise<Record<string, unknown>>} parsed object (an empty object for an empty body).
 */
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw coded('BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`, 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw coded('BAD_JSON', 'request body is not valid JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw coded('BAD_JSON', 'request body must be a JSON object', 400)
  }
  return parsed
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON-serialisable payload.
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  if (res.headersSent) {
    try {
      res.destroy()
    } catch {
      // already gone
    }
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Ensure a directory exists.
 * @param {string} directory absolute path.
 * @returns {Promise<void>} completion.
 */
export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
}

/**
 * Persist JSON atomically (write a sibling temp file, then rename).
 * @param {string} file absolute path.
 * @param {unknown} value JSON value.
 * @returns {Promise<void>} completion.
 */
export async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
}

/**
 * Read JSON, returning `undefined` when the file is missing or unreadable.
 * @param {string} file absolute path.
 * @returns {Promise<unknown | undefined>} parsed value.
 */
export async function readJsonIfPresent(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return undefined
  }
}

/**
 * Bounded integer coercion.
 * @param {unknown} value candidate.
 * @param {number} fallback default.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} bounded integer.
 */
export function boundInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Convert a value into lossless JSON.
 *
 * Tool results are validated before they reach the model, and a plain object
 * with an `undefined` property (or a `NaN`/`Infinity` number) is not lossless
 * JSON. Undefined object properties are dropped, undefined array holes become
 * `null`, and non-finite numbers become `null`.
 * @param {unknown} value candidate value.
 * @returns {unknown} JSON-safe value, or `undefined` when there is nothing to send.
 */
export function jsonSafe(value) {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const safe = jsonSafe(entry)
      return safe === undefined ? null : safe
    })
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      const safe = jsonSafe(entry)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return undefined
}

/**
 * Truncate a string to a byte budget from the head, appending a marker.
 * @param {string} text source text.
 * @param {number} maxBytes byte budget.
 * @returns {string} possibly truncated text.
 */
export function truncateHead(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8')
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n…[truncated at ${maxBytes} bytes]`
}

/**
 * Truncate a string to a byte budget from the tail, prepending a marker.
 * @param {string} text source text.
 * @param {number} maxBytes byte budget.
 * @returns {string} possibly truncated text.
 */
export function truncateTail(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8')
  return `…[truncated, showing last ${maxBytes} bytes]\n${buffer.subarray(buffer.length - maxBytes).toString('utf8')}`
}

/**
 * Strip control characters (except tab/newline) and bound a preview string so
 * audit records never carry terminal escape sequences or secrets in bulk.
 * @param {string} value raw text.
 * @param {number} [maxChars] preview length.
 * @returns {string} safe preview.
 */
export function auditPreview(value, maxChars = 200) {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const singleLine = stripped.replace(/\r\n|\n|\r/g, ' ↵ ')
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}…` : singleLine
}
