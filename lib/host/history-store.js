/**
 * On-disk terminal history (CONTRACTS.md §10).
 *
 * Each session gets one NDJSON journal (`<dir>/<sessionId>.ndjson`, one
 * `{"t":epochMs,"d":"base64"}` record per output chunk) plus one shared
 * `index.json` catalog. Appends are buffered in memory and flushed on a timer
 * or when the buffer grows past 64 KiB, so a chatty remote cannot turn terminal
 * output into one filesystem call per packet.
 *
 * The store is a convenience layer, never a dependency: every disk error is
 * logged and swallowed. A full disk or a read-only home directory must not break
 * a live SSH session, and it must not prevent the plugin from loading.
 *
 * `dir` is the history directory itself (normally `<dataDir>/history`); the
 * caller creates it through `init()`.
 */

import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { boundInteger, ensureDir, readJsonIfPresent, writeJsonAtomic } from './util.js'

/** Catalog file name inside the history directory. */
const INDEX_FILE = 'index.json'
/** Catalog format version written by this store. */
const CATALOG_VERSION = 1
/** Default retention window: 24 hours. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000
/** Default journal cap per session: 8 MiB. */
const DEFAULT_MAX_BYTES_PER_SESSION = 8 * 1024 * 1024
/** Default catalog size. */
const DEFAULT_MAX_SESSIONS = 100
/** Default buffered-append flush interval. */
const DEFAULT_FLUSH_INTERVAL_MS = 250
/** Buffer size that forces an immediate flush. */
const FLUSH_THRESHOLD_BYTES = 64 * 1024
/** Largest `query()` scan unless the caller lowers it. */
const DEFAULT_QUERY_MAX_BYTES = 8 * 1024 * 1024
/** Matches returned by `query()` unless the caller caps them. */
const DEFAULT_MAX_MATCHES = 100
/** Sessions' worth of pre-open output buffered to cover the open/append race. */
const MAX_ORPHAN_SESSIONS = 32

/**
 * @typedef {object} CatalogEntry
 * @property {string} id
 * @property {string} title
 * @property {'ssh' | 'telnet'} transport
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {number} createdAt
 * @property {number} [closedAt]
 * @property {number} [truncatedAt]
 * @property {number} bytes UTF-8 output bytes currently retained on disk.
 * @property {number} lastTs timestamp of the newest output record.
 */

/**
 * @typedef {object} HistoryMatch
 * @property {number} at epoch ms.
 * @property {string} line matched line text.
 * @property {string[]} before context lines before the match.
 * @property {string[]} after context lines after the match.
 */

/**
 * @typedef {object} HistoryQueryResult
 * @property {HistoryMatch[]} matches matches in ascending time order.
 * @property {number} scannedBytes bytes examined from the journal tail.
 * @property {boolean} truncated whether the scan was cut short (tail cap or match cap).
 * @property {CatalogEntry} [entry] catalog entry when the session is known.
 */

/**
 * @typedef {object} PendingRecord
 * @property {number} t epoch ms.
 * @property {string} d base64 payload.
 * @property {number} size decoded byte length.
 */

/**
 * @typedef {object} ActiveSession
 * @property {string} id
 * @property {string} file absolute journal path.
 * @property {CatalogEntry} entry catalog entry (same object as in `catalog`).
 * @property {PendingRecord[]} pending buffered records not yet written.
 * @property {number} pendingBytes buffered decoded bytes.
 * @property {ReturnType<typeof setTimeout> | undefined} timer flush timer.
 * @property {Promise<void>} chain per-file write serialization.
 * @property {number} fileBytes current journal size in bytes.
 */

/**
 * Per-session journal store with a catalog and retention policy.
 */
export class HistoryStore {
  /**
   * @param {object} options options.
   * @param {string} options.dir history directory (normally `<dataDir>/history`).
   * @param {number} [options.retentionMs] retention window (default 24h).
   * @param {number} [options.maxBytesPerSession] journal cap (default 8 MiB).
   * @param {number} [options.maxSessions] catalog cap (default 100).
   * @param {number} [options.flushIntervalMs] buffered flush interval (default 250).
   * @param {(level: string, message: string) => void} [options.log] logger.
   */
  constructor(options) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    this.dir = typeof opts.dir === 'string' ? opts.dir : ''
    this.retentionMs = boundInteger(opts.retentionMs, DEFAULT_RETENTION_MS, 0, 365 * 24 * 60 * 60 * 1000)
    this.maxBytesPerSession = boundInteger(opts.maxBytesPerSession, DEFAULT_MAX_BYTES_PER_SESSION, 256, 512 * 1024 * 1024)
    this.maxSessions = boundInteger(opts.maxSessions, DEFAULT_MAX_SESSIONS, 1, 10_000)
    this.flushIntervalMs = boundInteger(opts.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 10, 60_000)
    this.log = typeof opts.log === 'function' ? opts.log : () => {}
    /** @type {Promise<void> | undefined} */
    this.ready = undefined
    /** @type {Map<string, CatalogEntry>} */
    this.catalog = new Map()
    /** @type {Map<string, ActiveSession>} */
    this.active = new Map()
    /**
     * Output that arrived before `openSession()` finished. The registry opens
     * the journal without awaiting it (a disk hiccup must not delay a connect),
     * so the first banner bytes can race ahead of the registration; they are
     * adopted when the session opens instead of being lost.
     * @type {Map<string, { records: PendingRecord[], bytes: number }>}
     */
    this.orphans = new Map()
    this.disposed = false
    /** Serializes catalog writes so two flushes cannot interleave temp files. */
    this.indexChain = Promise.resolve()
  }

  /**
   * Create the directory, load the catalog and apply retention. Idempotent and
   * never throws.
   * @returns {Promise<void>} completion.
   */
  async init() {
    if (this.ready !== undefined) return this.ready
    this.ready = (async () => {
      if (this.dir.length === 0) {
        this.warn('no history directory configured; history persistence is disabled')
        return
      }
      try {
        await ensureDir(this.dir)
      } catch (error) {
        this.warn('cannot create history directory', error)
      }
      const index = await readJsonIfPresent(join(this.dir, INDEX_FILE))
      const entries = index !== null && typeof index === 'object' && Array.isArray(index.sessions) ? index.sessions : []
      for (const raw of entries) {
        const entry = normalizeEntry(raw)
        if (entry !== undefined) this.catalog.set(entry.id, entry)
      }
      await this.prune(Date.now())
    })()
    return this.ready
  }

  /**
   * Register (or refresh) a session in the catalog and start buffering output.
   * @param {{ id: string, title?: string, transport?: 'ssh' | 'telnet', host?: string, port?: number, username?: string, createdAt?: number }} meta session metadata.
   * @returns {Promise<void>} completion.
   */
  async openSession(meta) {
    if (this.disposed) return
    await this.ensureReady()
    if (this.dir.length === 0) return
    const source = meta !== null && typeof meta === 'object' ? meta : {}
    const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : ''
    if (id.length === 0) {
      this.log('debug', '[aiterm] history: openSession without an id ignored')
      return
    }
    const now = Date.now()
    const previous = this.catalog.get(id)
    const createdAt =
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? Math.floor(source.createdAt)
        : (previous?.createdAt ?? now)
    /** @type {CatalogEntry} */
    const entry = {
      id,
      title:
        typeof source.title === 'string' && source.title.length > 0
          ? source.title.slice(0, 120)
          : (previous?.title ?? id),
      transport: source.transport === 'telnet' ? 'telnet' : 'ssh',
      host: typeof source.host === 'string' ? source.host.slice(0, 253) : (previous?.host ?? ''),
      port: boundInteger(source.port, previous?.port ?? 22, 1, 65_535),
      username: typeof source.username === 'string' ? source.username.slice(0, 128) : (previous?.username ?? ''),
      createdAt,
      bytes: previous?.bytes ?? 0,
      lastTs: previous?.lastTs ?? createdAt,
    }
    this.catalog.set(id, entry)
    this.discardState(id)
    const file = this.fileFor(id)
    let fileBytes = 0
    try {
      const info = await stat(file)
      fileBytes = info.size
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot stat ${file}`, error)
    }
    /** @type {ActiveSession} */
    const state = {
      id,
      file,
      entry,
      pending: [],
      pendingBytes: 0,
      timer: undefined,
      chain: Promise.resolve(),
      fileBytes,
    }
    this.active.set(id, state)
    // Adopt output that raced ahead of this open (first banner, fast telnet).
    const orphan = this.orphans.get(id)
    if (orphan !== undefined) {
      this.orphans.delete(id)
      if (orphan.records.length > 0) {
        state.pending.push(...orphan.records)
        state.pendingBytes += orphan.bytes
        for (const record of orphan.records) {
          if (record.t > state.entry.lastTs) state.entry.lastTs = record.t
        }
        this.scheduleFlush(state, this.flushIntervalMs)
      }
    }
    if (fileBytes > 0 && entry.bytes === 0) entry.bytes = fileBytes
    await this.saveIndex()
    if (fileBytes > this.maxBytesPerSession) await this.truncateSession(state)
  }

  /**
   * Buffer one decoded chunk. Never throws, never touches the filesystem
   * synchronously; a chunk for a session whose open is still in flight is held
   * briefly and adopted by `openSession()`.
   * @param {string} sessionId session id.
   * @param {string} text decoded output.
   * @param {number} [at] epoch ms (default: now).
   * @returns {void}
   */
  appendChunk(sessionId, text, at) {
    if (this.disposed) return
    if (typeof text !== 'string' || text.length === 0) return
    let bytes
    try {
      bytes = Buffer.from(text, 'utf8')
    } catch {
      return
    }
    if (bytes.length === 0) return
    const timestamp = typeof at === 'number' && Number.isFinite(at) ? Math.floor(at) : Date.now()
    /** @type {PendingRecord} */
    const record = { t: timestamp, d: bytes.toString('base64'), size: bytes.length }
    const state = this.active.get(typeof sessionId === 'string' ? sessionId : '')
    if (state === undefined) {
      this.bufferOrphan(typeof sessionId === 'string' ? sessionId : '', record)
      return
    }
    state.pending.push(record)
    state.pendingBytes += bytes.length
    if (timestamp > state.entry.lastTs) state.entry.lastTs = timestamp
    if (state.pendingBytes >= FLUSH_THRESHOLD_BYTES) this.scheduleFlush(state, 0)
    else this.scheduleFlush(state, this.flushIntervalMs)
  }

  /**
   * Flush buffered records for one session (or every session).
   * @param {string} [sessionId] session to flush; omit for all.
   * @returns {Promise<void>} completion (errors are logged, not thrown).
   */
  async flush(sessionId) {
    await this.ensureReady()
    if (typeof sessionId === 'string') {
      const state = this.active.get(sessionId)
      if (state !== undefined) await this.writePending(state)
      return
    }
    await Promise.allSettled([...this.active.values()].map((state) => this.writePending(state)))
  }

  /**
   * Flush and mark a session closed. The journal and catalog entry stay for
   * `listSessions` / `query`.
   * @param {string} sessionId session id.
   * @param {{ closedAt?: number }} [info] close details.
   * @returns {Promise<void>} completion.
   */
  async closeSession(sessionId, info) {
    if (this.disposed) return
    await this.ensureReady()
    const id = typeof sessionId === 'string' ? sessionId : ''
    const state = this.active.get(id)
    if (state !== undefined) {
      await this.writePending(state)
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      this.active.delete(id)
    }
    this.orphans.delete(id)
    const entry = this.catalog.get(id)
    if (entry === undefined) return
    const closedAt = info !== null && typeof info === 'object' && typeof info.closedAt === 'number' && Number.isFinite(info.closedAt)
      ? Math.floor(info.closedAt)
      : Date.now()
    entry.closedAt = closedAt
    await this.saveIndex()
  }

  /**
   * Catalog listing, newest activity first.
   * @param {{ limit?: number, since?: number, until?: number }} [query] filter.
   * @returns {Promise<CatalogEntry[]>} catalog entries (copies).
   */
  async listSessions(query = {}) {
    await this.ensureReady()
    const options = query !== null && typeof query === 'object' ? query : {}
    const limit = boundInteger(options.limit, 100, 1, 1000)
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : -Infinity
    const until = typeof options.until === 'number' && Number.isFinite(options.until) ? options.until : Infinity
    const entries = [...this.catalog.values()].filter((entry) => {
      const last = typeof entry.lastTs === 'number' ? entry.lastTs : entry.createdAt
      return last >= since && entry.createdAt <= until
    })
    entries.sort((left, right) => activity(right) - activity(left))
    return entries.slice(0, limit).map((entry) => publicEntry(entry))
  }

  /**
   * Search one session's journal.
   *
   * At most the last `maxBytes` (default 8 MiB) of the file is scanned; a
   * partial first line produced by that tail cut is discarded. Corrupt or
   * partially written NDJSON lines are skipped rather than failing the query.
   * Without `search`, the most recent `maxMatches` lines are returned.
   * @param {{ sessionId?: string, since?: number, until?: number, search?: string, context?: number, maxMatches?: number, maxBytes?: number }} query query.
   * @returns {Promise<HistoryQueryResult>} matches and scan bookkeeping.
   */
  async query(query = {}) {
    await this.ensureReady()
    const options = query !== null && typeof query === 'object' ? query : {}
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
    /** @type {HistoryQueryResult} */
    const result = { matches: [], scannedBytes: 0, truncated: false }
    if (this.dir.length === 0) return result
    const entry = this.catalog.get(sessionId)
    // A live session may still hold buffered bytes: flush so the query sees them.
    if (this.active.has(sessionId)) await this.flush(sessionId)
    const file = this.fileFor(sessionId)
    let buffer
    try {
      buffer = await readFile(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot read history for ${sessionId}`, error)
      return withEntry(result, entry)
    }

    const maxBytes = boundInteger(options.maxBytes, DEFAULT_QUERY_MAX_BYTES, 256, 256 * 1024 * 1024)
    let scanStart = 0
    if (buffer.length > maxBytes) {
      scanStart = buffer.length - maxBytes
      result.truncated = true
      const newline = buffer.indexOf(0x0a, scanStart)
      scanStart = newline === -1 ? buffer.length : newline + 1
    }
    const scanBuffer = buffer.subarray(scanStart)
    // Bytes examined from disk (the tail cut, when it happened, is reported as truncated).
    result.scannedBytes = scanBuffer.length
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : -Infinity
    const until = typeof options.until === 'number' && Number.isFinite(options.until) ? options.until : Infinity
    const context = boundInteger(options.context, 0, 0, 50)
    const maxMatches = boundInteger(options.maxMatches, DEFAULT_MAX_MATCHES, 1, 5000)
    const search = typeof options.search === 'string' && options.search.length > 0 ? options.search : undefined
    const pattern = search === undefined ? null : compileSearch(search)

    // Parse the journal, keeping only records inside the time range.
    /** @type {Array<{ t: number, buffer: Buffer }>} */
    const chunks = []
    let lineStart = 0
    for (let index = 0; index <= scanBuffer.length; index += 1) {
      if (index !== scanBuffer.length && scanBuffer[index] !== 0x0a) continue
      if (index > lineStart) {
        const line = scanBuffer.subarray(lineStart, index).toString('utf8').trim()
        if (line.length > 0) {
          const parsed = parseRecord(line)
          if (parsed !== undefined && parsed.t >= since && parsed.t <= until) chunks.push(parsed)
        }
      }
      lineStart = index + 1
    }

    if (chunks.length === 0) return withEntry(result, entry)

    /** @type {Array<{ offset: number, t: number }>} */
    const boundaries = []
    let cursor = 0
    for (const chunk of chunks) {
      boundaries.push({ offset: cursor, t: chunk.t })
      cursor += chunk.buffer.length
    }
    const combined = Buffer.concat(chunks.map((chunk) => chunk.buffer))
    const records = splitLines(combined)

    /** @type {HistoryMatch[]} */
    const matches = []
    if (pattern === null) {
      const first = Math.max(0, records.length - maxMatches)
      if (first > 0) result.truncated = true
      for (let index = first; index < records.length; index += 1) {
        matches.push({ at: timestampAt(boundaries, records[index].offset), line: records[index].text, before: [], after: [] })
      }
    } else {
      /** @type {HistoryMatch[]} */
      const pendingAfter = []
      let stopped = false
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        for (const match of pendingAfter) {
          if (match.after.length < context) match.after.push(record.text)
        }
        for (let i = pendingAfter.length - 1; i >= 0; i -= 1) {
          if (pendingAfter[i].after.length >= context) pendingAfter.splice(i, 1)
        }
        pattern.lastIndex = 0
        if (!pattern.test(record.text)) continue
        if (matches.length >= maxMatches) {
          result.truncated = true
          stopped = true
          break
        }
        /** @type {HistoryMatch} */
        const match = {
          at: timestampAt(boundaries, record.offset),
          line: record.text,
          before: [],
          after: [],
        }
        for (let i = Math.max(0, index - context); i < index; i += 1) match.before.push(records[i].text)
        matches.push(match)
        if (context > 0) pendingAfter.push(match)
      }
      if (stopped) {
        // Nothing extra to report beyond the truncation flag already set.
      }
    }

    result.matches = matches
    return withEntry(result, entry)
  }

  /**
   * Apply retention and the catalog size cap, deleting both catalog entries and
   * journal files. Safe to call at any time.
   * @param {number} [now] epoch ms (default: now).
   * @returns {Promise<void>} completion.
   */
  async prune(now) {
    if (this.disposed) return
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const cutoff = at - this.retentionMs
    let changed = false
    for (const [id, entry] of [...this.catalog]) {
      // A live session is not retention-pruned: its writer still owns the file.
      if (this.active.has(id)) continue
      const last = typeof entry.lastTs === 'number' ? entry.lastTs : entry.createdAt
      if (last < cutoff) {
        this.catalog.delete(id)
        this.orphans.delete(id)
        changed = true
        await this.removeFile(id)
      }
    }
    if (this.catalog.size > this.maxSessions) {
      const sorted = [...this.catalog.values()].sort((left, right) => activity(right) - activity(left))
      for (const entry of sorted.slice(this.maxSessions)) {
        this.catalog.delete(entry.id)
        this.discardState(entry.id)
        this.orphans.delete(entry.id)
        changed = true
        await this.removeFile(entry.id)
      }
    }
    if (changed) await this.saveIndex()
  }

  /**
   * Flush everything and stop timers. Idempotent; never throws.
   * @returns {Promise<void>} completion.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const states = [...this.active.values()]
    for (const state of states) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }
    await Promise.allSettled(states.map((state) => this.writePending(state)))
    this.active.clear()
    this.orphans.clear()
    await this.saveIndex()
  }

  /**
   * @param {string} id session id.
   * @returns {string} journal path.
   */
  fileFor(id) {
    return join(this.dir, `${safeSessionFileName(id)}.ndjson`)
  }

  /**
   * Await `init()`, running it on first use.
   * @returns {Promise<void>} completion.
   */
  async ensureReady() {
    if (this.ready === undefined) await this.init()
    else await this.ready
  }

  /**
   * Hold output for a session whose `openSession()` has not finished yet.
   * Bounded by session count and 64 KiB per session, so a session that never
   * opens cannot grow the store.
   * @param {string} id session id.
   * @param {PendingRecord} record decoded record.
   * @returns {void}
   * @private
   */
  bufferOrphan(id, record) {
    if (id.length === 0) return
    let orphan = this.orphans.get(id)
    if (orphan === undefined) {
      if (this.orphans.size >= MAX_ORPHAN_SESSIONS) {
        const oldest = this.orphans.keys().next()
        if (oldest.done !== true) this.orphans.delete(oldest.value)
      }
      orphan = { records: [], bytes: 0 }
      this.orphans.set(id, orphan)
      this.log('debug', `[aiterm] history: buffering output for not-yet-open session ${id}`)
    }
    if (orphan.bytes + record.size > FLUSH_THRESHOLD_BYTES) return
    orphan.records.push(record)
    orphan.bytes += record.size
  }

  /**
   * Arm or re-arm a flush timer for a session.
   * @param {ActiveSession} state session state.
   * @param {number} delay milliseconds.
   * @returns {void}
   * @private
   */
  scheduleFlush(state, delay) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.writePending(state)
    }, Math.max(0, delay))
    if (typeof state.timer?.unref === 'function') state.timer.unref()
  }

  /**
   * Append buffered records to the journal, serialized per session.
   * @param {ActiveSession} state session state.
   * @returns {Promise<void>} completion.
   * @private
   */
  writePending(state) {
    const task = async () => {
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (state.pending.length === 0) return
      const batch = state.pending
      state.pending = []
      state.pendingBytes = 0
      let payload = ''
      let payloadBytes = 0
      for (const record of batch) {
        payload += `${JSON.stringify({ t: record.t, d: record.d })}\n`
        payloadBytes += record.size
      }
      const data = Buffer.from(payload, 'utf8')
      try {
        await appendFile(state.file, data, { mode: 0o600 })
        state.fileBytes += data.length
        state.entry.bytes += payloadBytes
      } catch (error) {
        this.warn(`cannot append history for ${state.id}`, error)
        return
      }
      if (state.fileBytes > this.maxBytesPerSession) {
        await this.truncateSession(state)
        return
      }
      await this.saveIndex()
    }
    state.chain = state.chain.then(task, task)
    return state.chain
  }

  /**
   * Rewrite a journal to its tail, keeping complete records up to the byte cap.
   * @param {ActiveSession} state session state.
   * @returns {Promise<void>} completion.
   * @private
   */
  async truncateSession(state) {
    if (state.fileBytes <= this.maxBytesPerSession) return
    let buffer
    try {
      buffer = await readFile(state.file)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot truncate history for ${state.id}`, error)
      return
    }
    const lines = buffer.toString('utf8').split('\n')
    /** @type {string[]} */
    const kept = []
    let fileBytes = 0
    let payloadBytes = 0
    let lastTs = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line.length === 0) continue
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      // Keep at least one record so a huge single chunk still yields a journal.
      if (kept.length > 0 && fileBytes + lineBytes > this.maxBytesPerSession) break
      const parsed = parseRecord(line)
      if (parsed === undefined) continue
      kept.push(line)
      fileBytes += lineBytes
      payloadBytes += parsed.buffer.length
      if (parsed.t > lastTs) lastTs = parsed.t
    }
    kept.reverse()
    const body = kept.length > 0 ? `${kept.join('\n')}\n` : ''
    const written = Buffer.byteLength(body, 'utf8')
    const temp = `${state.file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, state.file)
    } catch (error) {
      this.warn(`cannot rewrite history for ${state.id}`, error)
      try {
        await rm(temp, { force: true })
      } catch {
        // best effort cleanup
      }
      return
    }
    state.fileBytes = written
    state.entry.bytes = payloadBytes
    state.entry.truncatedAt = Date.now()
    if (lastTs > 0) state.entry.lastTs = lastTs
    await this.saveIndex()
  }

  /**
   * Persist the catalog atomically, serialized behind earlier writes.
   * @returns {Promise<void>} completion (errors are logged, not thrown).
   * @private
   */
  saveIndex() {
    const payload = { version: CATALOG_VERSION, sessions: [...this.catalog.values()].map((entry) => ({ ...entry })) }
    const write = async () => {
      try {
        await writeJsonAtomic(join(this.dir, INDEX_FILE), payload)
      } catch (error) {
        this.warn('cannot write history index', error)
      }
    }
    this.indexChain = this.indexChain.then(write, write)
    return this.indexChain
  }

  /**
   * Delete one session's journal file.
   * @param {string} id session id.
   * @returns {Promise<void>} completion.
   * @private
   */
  async removeFile(id) {
    try {
      await rm(this.fileFor(id), { force: true })
    } catch (error) {
      this.warn(`cannot remove history for ${id}`, error)
    }
  }

  /**
   * Drop buffered state for a session (after close or pruning).
   * @param {string} id session id.
   * @returns {void}
   * @private
   */
  discardState(id) {
    const state = this.active.get(id)
    if (state === undefined) return
    if (state.timer !== undefined) clearTimeout(state.timer)
    this.active.delete(id)
  }

  /**
   * Log a warning without ever throwing.
   * @param {string} message context.
   * @param {unknown} [error] cause.
   * @returns {void}
   * @private
   */
  warn(message, error) {
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    try {
      this.log('warn', `[aiterm] history: ${message}${detail.length > 0 ? `: ${detail}` : ''}`)
    } catch {
      // a broken logger must not break the terminal
    }
  }
}

/**
 * Turn a session id into a safe journal basename (ids come from the registry,
 * but this is the only place a string reaches a filesystem path).
 * @param {string} id session id.
 * @returns {string} safe basename without extension.
 */
function safeSessionFileName(id) {
  const raw = typeof id === 'string' ? id : String(id)
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  if (safe.length === 0 || safe === '.' || safe === '..') return '_session'
  return safe
}

/**
 * @param {CatalogEntry} entry catalog entry.
 * @returns {number} sortable activity timestamp.
 */
function activity(entry) {
  return typeof entry.lastTs === 'number' ? entry.lastTs : entry.createdAt
}

/**
 * @param {unknown} raw catalog value from disk.
 * @returns {CatalogEntry | undefined} normalized entry.
 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id.slice(0, 128) : undefined
  if (id === undefined) return undefined
  const createdAt = finiteInteger(source.createdAt, 0)
  /** @type {CatalogEntry} */
  const entry = {
    id,
    title: typeof source.title === 'string' ? source.title.slice(0, 120) : id,
    transport: source.transport === 'telnet' ? 'telnet' : 'ssh',
    host: typeof source.host === 'string' ? source.host.slice(0, 253) : '',
    port: boundInteger(source.port, 22, 1, 65_535),
    username: typeof source.username === 'string' ? source.username.slice(0, 128) : '',
    createdAt,
    bytes: Math.max(0, finiteInteger(source.bytes, 0)),
    lastTs: finiteInteger(source.lastTs, createdAt),
  }
  const closedAt = finiteInteger(source.closedAt, undefined)
  if (closedAt !== undefined) entry.closedAt = closedAt
  const truncatedAt = finiteInteger(source.truncatedAt, undefined)
  if (truncatedAt !== undefined) entry.truncatedAt = truncatedAt
  return entry
}

/**
 * @param {unknown} value candidate.
 * @param {number | undefined} fallback default.
 * @returns {number | undefined} finite integer or the fallback.
 */
function finiteInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/**
 * Parse one journal record into its timestamp and decoded payload.
 * @param {string} line NDJSON line.
 * @returns {{ t: number, buffer: Buffer } | undefined} record or undefined when corrupt.
 */
function parseRecord(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t) || typeof parsed.d !== 'string') return undefined
  return { t: parsed.t, buffer: Buffer.from(parsed.d, 'base64') }
}

/**
 * Compile a history search expression defensively. An invalid regular
 * expression falls back to a literal substring match instead of failing.
 * @param {string} search caller text or pattern.
 * @returns {RegExp} usable matcher.
 */
function compileSearch(search) {
  try {
    return new RegExp(search)
  } catch {
    return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
}

/**
 * Split decoded output into lines, tolerating `\n`, `\r\n` and lone `\r`.
 * @param {Buffer} buffer bytes.
 * @returns {Array<{ text: string, offset: number }>} line records with byte offsets.
 */
function splitLines(buffer) {
  /** @type {Array<{ text: string, offset: number }>} */
  const records = []
  let lineStart = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === 0x0d) {
      records.push({ text: buffer.subarray(lineStart, index).toString('utf8'), offset: lineStart })
      if (buffer[index + 1] === 0x0a) index += 1
      lineStart = index + 1
    } else if (byte === 0x0a) {
      records.push({ text: buffer.subarray(lineStart, index).toString('utf8'), offset: lineStart })
      lineStart = index + 1
    }
  }
  if (lineStart < buffer.length) records.push({ text: buffer.subarray(lineStart).toString('utf8'), offset: lineStart })
  return records
}

/**
 * Timestamp of the record containing a byte offset.
 * @param {Array<{ offset: number, t: number }>} boundaries chunk start offsets/timestamps.
 * @param {number} offset byte offset.
 * @returns {number} epoch ms.
 */
function timestampAt(boundaries, offset) {
  if (boundaries.length === 0) return 0
  if (offset < boundaries[0].offset) return boundaries[0].t
  let lo = 0
  let hi = boundaries.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (boundaries[mid].offset <= offset) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return boundaries[best].t
}

/**
 * Copy a catalog entry for public consumption.
 *
 * `truncatedAt` is recorded in `index.json` (§10: 记 truncatedAt) but is not
 * part of the `CatalogEntry` contract and the history tool schema rejects
 * undeclared fields (`additionalProperties: false`), so it stays internal.
 * @param {CatalogEntry} entry catalog entry.
 * @returns {CatalogEntry} a plain copy of the documented shape.
 */
function publicEntry(entry) {
  /** @type {CatalogEntry} */
  const copy = {
    id: entry.id,
    title: entry.title,
    transport: entry.transport,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    createdAt: entry.createdAt,
    bytes: entry.bytes,
    lastTs: entry.lastTs,
  }
  if (entry.closedAt !== undefined) copy.closedAt = entry.closedAt
  return copy
}

/**
 * Attach the catalog entry to a query result, omitting the field when unknown
 * (undefined properties are not lossless JSON — CONTRACTS.md §8).
 * @param {HistoryQueryResult} result result.
 * @param {CatalogEntry | undefined} entry catalog entry.
 * @returns {HistoryQueryResult} the same result.
 */
function withEntry(result, entry) {
  if (entry !== undefined) result.entry = publicEntry(entry)
  return result
}
