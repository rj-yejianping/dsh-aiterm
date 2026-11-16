/**
 * Human-readable export of stored terminal history.
 *
 * The durable journal (`<dataDir>/history/<sessionId>.ndjson`) is the source of
 * truth: exporting reads the journal directly and turns every output line into
 * `<ISO timestamp> <line>`, prefixed by a small `#` header block describing the
 * session. Reading the journal beats re-querying the store because an export is
 * a bulk operation: `query()` returns at most `maxMatches` lines and only scans
 * the journal tail, while an export wants the whole window with no per-line
 * search machinery.
 *
 * Selection rules:
 * - `all: true` — every session known to the catalog (closed sessions included).
 * - `sessionId` — exactly that session.
 * - neither — the only session available; two or more is `BAD_TARGET`.
 *
 * Writes are atomic (temp file + rename) so an interrupted export never leaves a
 * half-written `.log` the user could pick up.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { coded, ensureDir } from './util.js'

/** Longest export file name stem taken from a session title. */
const MAX_TITLE_SIZE = 40
/** Longest exported session id component in a file name. */
const MAX_ID_SIZE = 64
/** Hard cap on exported sessions per call (matches the catalog cap). */
const MAX_EXPORT_SESSIONS = 500

/**
 * @typedef {object} ExportFile
 * @property {string} sessionId
 * @property {string} path absolute path of the written `.log` file.
 * @property {number} bytes file size in bytes.
 * @property {number} lines number of written lines (header included).
 */

/**
 * @typedef {object} ExportResult
 * @property {string} dir absolute export directory.
 * @property {ExportFile[]} files written files.
 */

/**
 * @typedef {object} ExportOptions
 * @property {import('./history-store.js').HistoryStore} historyStore durable journal store.
 * @property {Array<Record<string, any>>} [sessions] live sessions (`registry.list()`).
 * @property {string} dir output directory.
 * @property {string} [sessionId] export this session only.
 * @property {boolean} [all] export every known session.
 * @property {number | string} [since] lower time bound.
 * @property {number | string} [until] upper time bound.
 */

/**
 * Export stored output history as text log files.
 * @param {ExportOptions} options export options.
 * @returns {Promise<ExportResult>} written files.
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
    catalog = await historyStore.listSessions({ limit: 1000 })
  } catch {
    catalog = []
  }
  const selection = resolveSelection({ live, catalog, sessionId: opts.sessionId, all: opts.all === true })
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
  for (const id of selection.ids) {
    const meta = selection.meta.get(id) ?? { id }
    const journal = await readJournal(historyStore, id)
    // With `all`, a session that never produced output (no journal file) is not
    // an export target: an empty file per failed connect would only be noise.
    if (selection.all === true && !journal.exists) continue
    const records = journal.records.filter(
      (record) => (since === undefined || record.t >= since) && (until === undefined || record.t <= until),
    )
    const content = buildContent({ id, meta, records, since, until, exportedAt })
    const path = join(dir, `${safeId(id)}-${safeTitle(meta.title, id)}-${stamp}.log`)
    await writeAtomic(path, content)
    files.push({ sessionId: id, path, bytes: Buffer.byteLength(content, 'utf8'), lines: countLines(content) })
  }
  return { dir, files }
}

/**
 * @typedef {object} Selection
 * @property {string[]} ids session ids to export.
 * @property {Map<string, Record<string, any>>} meta metadata by id.
 * @property {boolean} all whether the caller asked for everything.
 */

/**
 * Decide which sessions an export covers.
 * @param {{ live: Array<Record<string, any>>, catalog: Array<Record<string, any>>, sessionId?: unknown, all: boolean }} input candidates.
 * @returns {Selection} selection.
 */
function resolveSelection(input) {
  /** @type {Map<string, Record<string, any>>} */
  const meta = new Map()
  for (const entry of input.catalog) {
    if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0) meta.set(entry.id, entry)
  }
  for (const session of input.live) {
    if (typeof session.id !== 'string' || session.id.length === 0) continue
    // A live session's metadata is fresher (title can be renamed mid-session).
    meta.set(session.id, { ...(meta.get(session.id) ?? {}), ...session })
  }
  /** @type {string[]} */
  const ordered = []
  const seen = new Set()
  for (const candidate of [...input.live.map((session) => session.id), ...input.catalog.map((entry) => entry.id)]) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    ordered.push(candidate)
  }
  if (input.all === true) return { ids: ordered.slice(0, MAX_EXPORT_SESSIONS), meta, all: true }
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    const id = input.sessionId
    if (!meta.has(id)) throw coded('SESSION_NOT_FOUND', `no session ${id} to export`, 404)
    return { ids: [id], meta, all: false }
  }
  const live = input.live.filter((session) => typeof session.id === 'string' && session.id.length > 0)
  const candidates = live.length > 0 ? live.map((session) => session.id) : ordered
  if (candidates.length === 0) throw coded('BAD_TARGET', 'no session to export; connect one or pass all: true')
  if (candidates.length === 1) return { ids: [candidates[0]], meta, all: false }
  throw coded(
    'BAD_TARGET',
    `several sessions are available (${candidates.slice(0, 8).join(', ')}); pass sessionId or all: true`,
  )
}

/**
 * Read and decode one session journal.
 * @param {import('./history-store.js').HistoryStore} historyStore journal store.
 * @param {string} id session id.
 * @returns {Promise<{ exists: boolean, records: Array<{ t: number, text: string }> }>} decoded records.
 */
async function readJournal(historyStore, id) {
  let buffer
  try {
    buffer = await readFile(historyStore.fileFor(id))
  } catch {
    return { exists: false, records: [] }
  }
  /** @type {Array<{ t: number, text: string }>} */
  const records = []
  let lineStart = 0
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 0x0a) continue
    if (index > lineStart) {
      const line = buffer.subarray(lineStart, index).toString('utf8').trim()
      if (line.length > 0) {
        const record = parseRecord(line)
        if (record !== undefined) records.push(record)
      }
    }
    lineStart = index + 1
  }
  return { exists: true, records }
}

/**
 * Decode one NDJSON journal line.
 * @param {string} line raw line.
 * @returns {{ t: number, text: string } | undefined} decoded record.
 */
function parseRecord(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    // A partially written line from a tail-truncated journal is skipped.
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t) || typeof parsed.d !== 'string') return undefined
  let text
  try {
    text = Buffer.from(parsed.d, 'base64').toString('utf8')
  } catch {
    return undefined
  }
  return text.length > 0 ? { t: Math.floor(parsed.t), text } : undefined
}

/**
 * Render the export file body.
 *
 * Output chunks are reassembled into lines before timestamping, so a line split
 * across two journal records still appears once, carrying the timestamp of the
 * record that started it.
 * @param {object} input content inputs.
 * @param {string} input.id session id.
 * @param {Record<string, any>} input.meta session metadata.
 * @param {Array<{ t: number, text: string }>} input.records time-filtered records.
 * @param {number | undefined} input.since window start.
 * @param {number | undefined} input.until window end.
 * @param {number} input.exportedAt export time.
 * @returns {string} file content.
 */
function buildContent({ id, meta, records, since, until, exportedAt }) {
  const header = [headerLine(id, meta), `# exported ${new Date(exportedAt).toISOString()}`]
  if (since !== undefined || until !== undefined) {
    header.push(
      `# window since ${since === undefined ? '-' : new Date(since).toISOString()} until ${until === undefined ? '-' : new Date(until).toISOString()}`,
    )
  }
  /** @type {string[]} */
  const lines = header.slice()
  let pending = ''
  let pendingAt = 0
  for (const record of records) {
    if (pending.length === 0) pendingAt = record.t
    pending += record.text
    let index
    while ((index = pending.indexOf('\n')) !== -1) {
      lines.push(`${new Date(pendingAt).toISOString()} ${trimCarriageReturn(pending.slice(0, index))}`)
      pending = pending.slice(index + 1)
      pendingAt = record.t
    }
  }
  if (pending.length > 0) lines.push(`${new Date(pendingAt).toISOString()} ${trimCarriageReturn(pending)}`)
  return `${lines.join('\n')}\n`
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
 * Write a file atomically (temp sibling + rename).
 * @param {string} path destination.
 * @param {string} content text.
 * @returns {Promise<void>} completion.
 */
async function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, path)
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
 * @param {string} content file content.
 * @returns {number} number of lines (content always ends with a newline).
 */
function countLines(content) {
  let count = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 0x0a) count += 1
  }
  return count
}

/**
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
