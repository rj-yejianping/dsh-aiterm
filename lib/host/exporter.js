/**
 * Human-readable export of stored terminal history.
 *
 * The durable journal is the source of truth: exporting reads it directly and
 * turns every output line into `<ISO timestamp> <line>`, prefixed by a small
 * `#` header block. Journals are streamed in bounded chunks, so a 512 MiB
 * `historyMaxBytesPerSession` journal is exported without materializing it in
 * memory and without an artificial size ceiling that would silently reject a
 * configured maximum.
 *
 * Selection is by **incarnation address**, not by logical session id alone:
 * - `all: true` — every readable catalog entry / live incarnation (duplicates
 *   with the same logical id are all included, each with its own file).
 * - `journalKey` — exactly one address (a `historyId` or a live/legacy id).
 * - `sessionId` — compatibility fallback: the first/newest matching address.
 * - neither — the only available incarnation; two or more is `BAD_TARGET`.
 *
 * Writes are atomic (unique temp file + rename) and final file names carry an
 * incarnation token plus a random suffix, so two concurrent exports — even of
 * the same incarnation — cannot overwrite each other.
 */

import { randomUUID } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { coded, ensureDir } from './util.js'

/** Longest export file name stem taken from a session title. */
const MAX_TITLE_SIZE = 40
/** Longest exported session id component in a file name. */
const MAX_ID_SIZE = 64
/** Hard cap on exported addresses per call. */
const MAX_EXPORT_SESSIONS = 5000
/** Chunk size for reading a journal and buffering the output. */
const STREAM_CHUNK_BYTES = 64 * 1024
/** Flush buffered output to disk at this size. */
const WRITE_CHUNK_BYTES = 64 * 1024

/**
 * @typedef {object} ExportFile
 * @property {string} sessionId
 * @property {string} [historyId]
 * @property {string} path absolute path of the written `.log` file.
 * @property {number} bytes file size in bytes.
 * @property {number} lines number of written lines (header included).
 */

/**
 * @typedef {object} ExportSkipped
 * @property {string} sessionId
 * @property {string} [historyId]
 * @property {string} code stable reason code.
 * @property {string} message explanation.
 */

/**
 * @typedef {object} ExportResult
 * @property {string} dir absolute export directory.
 * @property {ExportFile[]} files written files.
 * @property {ExportSkipped[]} skipped entries intentionally not written.
 */

/**
 * @typedef {object} ExportOptions
 * @property {import('./history-store.js').HistoryStore} historyStore journal facade.
 * @property {Array<Record<string, any>>} [sessions] live session metadata.
 * @property {string} dir output directory.
 * @property {string} [sessionId] compatibility logical session id.
 * @property {string} [journalKey] exact incarnation address.
 * @property {boolean} [all] export every address.
 * @property {number | string} [since] lower time bound.
 * @property {number | string} [until] upper time bound.
 */

/**
 * Export stored output history as text log files.
 * @param {ExportOptions} options export options.
 * @returns {Promise<ExportResult>} written files and skipped entries.
 * @throws {import('./util.js').CodedError} `HISTORY_UNAVAILABLE`, `SESSION_NOT_FOUND`
 *   or `BAD_TARGET`.
 */
export async function exportSessions(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const historyStore = opts.historyStore
  if (historyStore === undefined || historyStore === null || typeof historyStore.fileFor !== 'function') {
    throw coded('HISTORY_UNAVAILABLE', 'durable history is not available; enable history retention first', 503)
  }
  const dir = typeof opts.dir === 'string' && opts.dir.trim().length > 0 ? resolve(opts.dir.trim()) : ''
  if (dir.length === 0) throw coded('BAD_TARGET', 'an export directory is required')
  try {
    await ensureDir(dir)
  } catch (error) {
    throw coded('BAD_TARGET', `cannot create export directory ${dir}: ${message(error)}`)
  }
  const since = timeValue(opts.since)
  const until = timeValue(opts.until)
  const live = Array.isArray(opts.sessions) ? opts.sessions.filter((session) => session !== null && typeof session === 'object') : []
  /** @type {Array<Record<string, any>>} */
  let catalog = []
  try {
    catalog = await historyStore.listSessions({ limit: MAX_EXPORT_SESSIONS })
  } catch {
    catalog = []
  }
  const selection = resolveSelection({
    live,
    catalog,
    sessionId: opts.sessionId,
    journalKey: opts.journalKey,
    all: opts.all === true,
  })
  // A live journal may still hold buffered chunks; flush once before reading.
  try {
    if (typeof historyStore.flush === 'function') await historyStore.flush()
  } catch {
    // best effort: export whatever is already on disk
  }
  const exportedAt = Date.now()
  const stamp = fileStamp(new Date(exportedAt))
  /** @type {ExportFile[]} */
  const files = []
  /** @type {ExportSkipped[]} */
  const skipped = []
  for (const key of selection.keys) {
    const meta = selection.meta.get(key) ?? { id: key }
    const id = typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : key
    const historyId = typeof meta.historyId === 'string' && meta.historyId.length > 0 ? meta.historyId : undefined
    const skip = (code, detail) => {
      skipped.push({ sessionId: id, ...(historyId === undefined ? {} : { historyId }), code, message: detail })
    }
    const file = historyStore.fileFor(key)
    if (typeof file !== 'string' || file.length === 0) {
      if (selection.all === true) {
        skip('SESSION_NOT_FOUND', 'no journal file exists for this incarnation')
        continue
      }
      throw coded('SESSION_NOT_FOUND', `no history journal exists for session ${id}`, 404)
    }
    let info
    try {
      info = await stat(file)
    } catch (error) {
      const missing = error?.code === 'ENOENT'
      if (selection.all === true) {
        skip(missing ? 'SESSION_NOT_FOUND' : 'HISTORY_READ_FAILED', message(error))
        continue
      }
      throw missing
        ? coded('SESSION_NOT_FOUND', `no history journal exists for session ${id}`, 404)
        : coded('HISTORY_READ_FAILED', `cannot read the journal for session ${id}: ${message(error)}`, 500)
    }
    if (!info.isFile()) {
      if (selection.all === true) {
        skip('HISTORY_READ_FAILED', 'the journal source is not a regular file')
        continue
      }
      throw coded('HISTORY_READ_FAILED', `the journal for session ${id} is not a regular file`, 500)
    }
    const path = uniqueExportPath(dir, id, historyId, meta, stamp)
    let written
    try {
      written = await streamJournalExport({
        file,
        path,
        id,
        meta,
        since,
        until,
        exportedAt,
      })
    } catch (error) {
      if (selection.all === true) {
        skip('HISTORY_READ_FAILED', message(error))
        continue
      }
      throw coded('HISTORY_READ_FAILED', `cannot export the journal for session ${id}: ${message(error)}`, 500)
    }
    files.push({
      sessionId: id,
      ...(historyId === undefined ? {} : { historyId }),
      path,
      bytes: written.bytes,
      lines: written.lines,
    })
  }
  for (const key of selection.omitted ?? []) {
    const meta = selection.meta.get(key) ?? { id: key }
    const id = typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : key
    skipped.push({
      sessionId: id,
      ...(typeof meta.historyId === 'string' ? { historyId: meta.historyId } : {}),
      code: 'EXPORT_LIMIT',
      message: `this call exports at most ${MAX_EXPORT_SESSIONS} incarnations`,
    })
  }
  return { dir, files, skipped }
}

/**
 * @typedef {object} Selection
 * @property {string[]} keys incarnation addresses to export.
 * @property {Map<string, Record<string, any>>} meta metadata by address.
 * @property {boolean} all whether the caller asked for everything.
 * @property {string[]} [omitted] addresses beyond the per-call export limit.
 */

/**
 * Stable address for one catalog/live entry.
 * @param {Record<string, any>} entry entry.
 * @returns {string} address.
 */
function addressOf(entry) {
  if (typeof entry.address === 'string' && entry.address.length > 0) return entry.address
  return typeof entry.historyId === 'string' && entry.historyId.length > 0 ? entry.historyId : entry.id
}

/**
 * Decide which incarnations an export covers.
 * @param {{ live: Array<Record<string, any>>, catalog: Array<Record<string, any>>, sessionId?: unknown, journalKey?: unknown, all: boolean }} input candidates.
 * @returns {Selection} selection.
 */
function resolveSelection(input) {
  /** @type {Map<string, Record<string, any>>} */
  const meta = new Map()
  /** @type {string[]} */
  const ordered = []
  const seen = new Set()
  const add = (entry, override) => {
    if (entry === null || typeof entry !== 'object') return
    if (typeof entry.id !== 'string' || entry.id.length === 0) return
    const key = addressOf(entry)
    if (override === true || !meta.has(key)) meta.set(key, { ...(meta.get(key) ?? {}), ...entry })
    if (!seen.has(key)) {
      seen.add(key)
      ordered.push(key)
    }
  }
  for (const session of input.live) add(session, true)
  for (const entry of input.catalog) add(entry, false)
  // Catalog rows with no journal are still listed by the store; the exporter
  // decides skip/throw per the caller's scope below.

  if (typeof input.journalKey === 'string' && input.journalKey.length > 0) {
    if (!meta.has(input.journalKey)) throw coded('SESSION_NOT_FOUND', 'the requested history incarnation no longer exists', 404)
    return { keys: [input.journalKey], meta, all: false }
  }
  if (input.all === true) {
    return {
      keys: ordered.slice(0, MAX_EXPORT_SESSIONS),
      meta,
      all: true,
      omitted: ordered.slice(MAX_EXPORT_SESSIONS),
    }
  }
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    const matches = ordered.filter((key) => (meta.get(key)?.id ?? key) === input.sessionId)
    if (matches.length === 0) throw coded('SESSION_NOT_FOUND', `no session ${input.sessionId} to export`, 404)
    // Compatibility: a caller that only knows the logical id exports the first
    // (live, then newest catalog) incarnation. Exact callers pass journalKey.
    return { keys: [matches[0]], meta, all: false }
  }
  const liveKeys = input.live
    .filter((session) => typeof session.id === 'string' && session.id.length > 0)
    .map((session) => addressOf(session))
  const candidates = liveKeys.length > 0 ? liveKeys : ordered
  if (candidates.length === 0) throw coded('BAD_TARGET', 'no session to export; connect one or pass all: true')
  if (candidates.length === 1) return { keys: [candidates[0]], meta, all: false }
  throw coded(
    'BAD_TARGET',
    `several sessions are available (${candidates.slice(0, 8).join(', ')}); pass sessionId or all: true`,
  )
}

/**
 * Build a final path that cannot collide with another export.
 * @param {string} dir output directory.
 * @param {string} id logical session id.
 * @param {string | undefined} historyId incarnation address.
 * @param {Record<string, any>} meta metadata.
 * @param {string} stamp timestamp stem.
 * @returns {string} absolute output path.
 */
function uniqueExportPath(dir, id, historyId, meta, stamp) {
  const incarnation = historyId === undefined ? '' : `-${shortToken(historyId)}`
  // Random suffix: two concurrent exports of the same incarnation must not
  // overwrite each other or share a temp file.
  const nonce = randomUUID().slice(0, 8)
  return join(dir, `${safeId(id)}${incarnation}-${safeTitle(meta.title, id)}-${stamp}-${nonce}.log`)
}

/**
 * Stream one journal into a human-readable log file.
 *
 * Output chunks are reassembled into lines before timestamping, so a line split
 * across two journal records still appears once, carrying the timestamp of the
 * record that started it. Memory is bounded by the chunk buffer plus the
 * largest single output line.
 * @param {{ file: string, path: string, id: string, meta: Record<string, any>, since?: number, until?: number, exportedAt: number }} input export input.
 * @returns {Promise<{ bytes: number, lines: number }>} written size/line count.
 */
async function streamJournalExport({ file, path, id, meta, since, until, exportedAt }) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle
  let reader
  let bytes = 0
  let lines = 0
  /** @type {string[]} */
  const buffered = []
  let bufferedBytes = 0
  const write = async (text) => {
    if (text.length === 0) return
    buffered.push(text)
    bufferedBytes += Buffer.byteLength(text, 'utf8')
    if (bufferedBytes >= WRITE_CHUNK_BYTES) {
      const chunk = buffered.join('')
      buffered.length = 0
      bufferedBytes = 0
      await handle.write(chunk)
      bytes += Buffer.byteLength(chunk, 'utf8')
    }
  }
  const emitted = async (line) => {
    await write(`${line}\n`)
    lines += 1
  }
  try {
    handle = await open(temp, 'w', 0o600)
    const header = [headerLine(id, meta), `# exported ${new Date(exportedAt).toISOString()}`]
    if (since !== undefined || until !== undefined) {
      header.push(
        `# window since ${since === undefined ? '-' : new Date(since).toISOString()} until ${until === undefined ? '-' : new Date(until).toISOString()}`,
      )
    }
    for (const line of header) await emitted(line)

    let pending = ''
    let pendingAt = 0
    const consume = async (text, at) => {
      if (pending.length === 0) pendingAt = at
      pending += text
      let index
      while ((index = pending.indexOf('\n')) !== -1) {
        await emitted(`${new Date(pendingAt).toISOString()} ${trimCarriageReturn(pending.slice(0, index))}`)
        pending = pending.slice(index + 1)
        pendingAt = at
      }
    }
    const processLine = async (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
      if (parsed === null || typeof parsed !== 'object') return
      if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t) || typeof parsed.d !== 'string') return
      const at = Math.floor(parsed.t)
      if (since !== undefined && at < since) return
      if (until !== undefined && at > until) return
      let text
      try {
        text = Buffer.from(parsed.d, 'base64').toString('utf8')
      } catch {
        return
      }
      if (text.length === 0) return
      await consume(text, at)
    }

    reader = await open(file, 'r')
    const decoder = new StringDecoder('utf8')
    const raw = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
    let carry = ''
    while (true) {
      const { bytesRead } = await reader.read(raw, 0, raw.length, null)
      if (bytesRead === 0) break
      carry += decoder.write(raw.subarray(0, bytesRead))
      let index
      while ((index = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, index)
        carry = carry.slice(index + 1)
        await processLine(line)
      }
    }
    carry += decoder.end()
    if (carry.trim().length > 0) await processLine(carry)
    if (pending.length > 0) {
      await emitted(`${new Date(pendingAt).toISOString()} ${trimCarriageReturn(pending)}`)
    }
    if (bufferedBytes > 0) {
      const chunk = buffered.join('')
      buffered.length = 0
      bufferedBytes = 0
      await handle.write(chunk)
      bytes += Buffer.byteLength(chunk, 'utf8')
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await reader.close()
    } catch {
      // already closed
    }
    reader = undefined
    await rename(temp, path)
    return { bytes, lines }
  } catch (error) {
    try {
      if (reader !== undefined) await reader.close()
    } catch {
      // best effort
    }
    try {
      if (handle !== undefined) await handle.close()
    } catch {
      // best effort
    }
    try {
      await rm(temp, { force: true })
    } catch {
      // best effort
    }
    throw error
  } finally {
    try {
      if (reader !== undefined) await reader.close()
    } catch {
      // already closed
    }
  }
}

/**
 * Build the `# session ...` header line. Only routing metadata is written; no
 * credential can reach an export.
 * @param {string} id session id.
 * @param {Record<string, any>} meta session metadata.
 * @returns {string} header line.
 */
function headerLine(id, meta) {
  const port = typeof meta.port === 'number' && Number.isFinite(meta.port) && meta.port > 0 ? String(Math.floor(meta.port)) : '?'
  const started = typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) ? new Date(meta.createdAt).toISOString() : '-'
  const parts = [
    `# session ${token(id, MAX_ID_SIZE)}`,
    `transport ${token(meta.transport, 16)}`,
    `host:port ${token(meta.host, 253)}:${port}`,
    `username ${token(meta.username, 128)}`,
    `title "${token(meta.title ?? id, 200)}"`,
    `started ${started}`,
  ]
  return parts.join(' ')
}

/**
 * Parse a time argument the same way the RPC surface does: epoch ms, ISO
 * date-time, or a relative amount such as `10m`, `2h`, `90s`, `1d`.
 * @param {unknown} value raw value.
 * @returns {number | undefined} epoch ms.
 */
function timeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (/^\d{10,16}$/.test(text)) return Number(text)
  const relative = text.match(/^(\d{1,6})(ms|s|m|h|d)$/i)
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return Date.now() - amount * factor
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Short stable token for one incarnation, used to keep export filenames unique.
 * @param {string} historyId opaque address.
 * @returns {string} short token.
 */
function shortToken(historyId) {
  const parts = String(historyId).split('~')
  const raw = parts.length > 1 ? parts[parts.length - 1] : String(historyId)
  const safe = raw.replace(/[^A-Za-z0-9]/g, '')
  if (safe.length === 0) return safeId(historyId)
  return safe.slice(0, 8)
}

/**
 * `yyyyMMdd-HHmmss` in local time.
 * @param {Date} date date.
 * @returns {string} timestamp for a file name.
 */
function fileStamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Reduce a session id to a safe file-name component.
 * @param {string} value session id.
 * @returns {string} safe id.
 */
function safeId(value) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MAX_ID_SIZE)
  return safe.length === 0 || safe === '.' || safe === '..' ? 'session' : safe
}

/**
 * Reduce a session title to a safe file-name component.
 * @param {unknown} value title.
 * @param {string} fallback used when the title has no usable characters.
 * @returns {string} safe title.
 */
function safeTitle(value, fallback) {
  const text = typeof value === 'string' ? value : ''
  const safe = text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TITLE_SIZE)
  return safe.length > 0 ? safe : safeId(fallback)
}

/**
 * Strip control characters and quotes so a title cannot forge log lines.
 * @param {unknown} value raw value.
 * @param {number} maxBytes maximum characters kept.
 * @returns {string} safe token.
 */
function token(value, maxBytes) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").trim().slice(0, maxBytes)
}

/**
 * @param {string} line output line.
 * @returns {string} line without a trailing carriage return.
 */
function trimCarriageReturn(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
