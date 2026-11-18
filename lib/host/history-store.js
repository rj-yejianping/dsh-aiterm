/**
 * On-disk terminal history (CONTRACTS.md §10).
 *
 * Every call to {@link HistoryStore#openSession} reserves a **new** journal
 * file with an exclusive create (`wx`) instead of appending to a file named
 * after the logical session id:
 *
 *     <dir>/<safe session id>~<random uuid>.ndjson
 *
 * Session ids are stable only inside one registry lifetime (`st-1` starts over
 * after a plugin reload), so a name keyed by the id alone let a new session
 * append its output to an older session's journal. The incarnation suffix is
 * reserved atomically by the filesystem: two overlapping plugin instances, a
 * reloaded instance and a still-pending flusher from the old instance all get
 * different files, and no old journal is ever reopened for append.
 *
 * The journal itself carries its provenance as private NDJSON metadata lines:
 *
 *     {"_aiterm":"journal","version":1,"id":"st-1","owner":"<dsh session id>",...}
 *     {"_aiterm":"close","version":1,"closedAt":...,"aiAccess":"wo",...}
 *
 * Owner and the AI permission at close time therefore survive a restart, a
 * lost/corrupt `index.json`, and a last-writer-wins catalog race between two
 * stores. A journal without a valid header, or a closed journal without valid
 * close permission, is *unattributed* and fails closed for AI reads/exports.
 *
 * `index.json` is kept for one purpose only: describing **legacy** journals
 * written by older versions, which have no provenance. Those files are never
 * rewritten, never deleted by retention, and are never assigned an owner. The
 * human legacy (no-owner) bucket can still read catalogued legacy history;
 * AI reads and any named-owner read fail closed.
 *
 * Appends are buffered in memory and flushed on a timer or when the buffer
 * grows past 64 KiB, so a chatty remote cannot turn terminal output into one
 * filesystem call per packet.
 *
 * The store is a convenience layer, never a dependency: every disk error is
 * logged and swallowed. A full disk or a read-only home directory must not break
 * a live SSH session, and it must not prevent the plugin from loading.
 *
 * `dir` is the history directory itself (normally `<dataDir>/history`); the
 * caller creates it through `init()`.
 */

import { randomUUID } from 'node:crypto'
import { appendFile, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { boundInteger, ensureDir, readJsonIfPresent } from './util.js'

/** Legacy catalog file name inside the history directory (read-only here). */
const INDEX_FILE = 'index.json'
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
/** Journal metadata marker discriminator. */
const META_MARKER = '_aiterm'
/** Journal metadata format version. */
const META_VERSION = 1
/** `open(..., 'wx')` collisions retried before giving up. */
const MAX_RESERVE_ATTEMPTS = 8
/** Largest journal header line accepted. */
const MAX_HEADER_BYTES = 16 * 1024
/** Bytes read from a journal tail when hydrating bookmarkkeeping fields. */
const TAIL_READ_BYTES = 64 * 1024
/** Separate an incarnation suffix from the safe session id. */
const INCARNATION_SEPARATOR = '~'

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
 * Private provenance record for one journal incarnation. The owner, close
 * permission and journal path are deliberately absent from the public
 * `CatalogEntry` shape and from every tool result.
 *
 * @typedef {object} Recording
 * @property {string} id logical session id.
 * @property {string | null} owner owning DSH session id; `null` = ownerless.
 * @property {string} journal absolute journal path.
 * @property {string} title
 * @property {'ssh' | 'telnet'} transport
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {number} createdAt
 * @property {number} [closedAt]
 * @property {'ro' | 'wo' | 'rw'} [aiAccess] AI permission recorded at close.
 * @property {number} [truncatedAt]
 * @property {number} bytes retained output bytes.
 * @property {number} lastTs timestamp of the newest output record.
 * @property {number} fileBytes current journal file size.
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
 * @property {Recording} entry provenance record (same object as in the map).
 * @property {PendingRecord[]} pending buffered records not yet written.
 * @property {number} pendingBytes buffered decoded bytes.
 * @property {ReturnType<typeof setTimeout> | undefined} timer flush timer.
 * @property {Promise<void>} chain per-file write serialization.
 * @property {number} fileBytes current journal size in bytes.
 */

/**
 * Per-session journal store with an incarnation journal, provenance metadata
 * and retention policy.
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
    /**
     * Attributed journals by absolute path. Provenance lives here (hydrated from
     * each journal header), never in the shared index.
     * @type {Map<string, Recording>}
     */
    this.recordings = new Map()
    /** @type {Map<string, Recording[]>} */
    this.byId = new Map()
    /**
     * Legacy catalog entries from `index.json`, keyed by id. These files have no
     * provenance; they are exposed only through the explicit human legacy bucket.
     * @type {Map<string, CatalogEntry>}
     */
    this.legacy = new Map()
    /** @type {Map<string, ActiveSession>} */
    this.active = new Map()
    /**
     * Output that arrived before `openSession()` finished. The registry opens
     * the journal without awaiting it (a disk hiccup must not delay a connect),
     * so the first banner bytes can race ahead of the registration; they are
     * adopted when the session opens instead of being lost. The key includes the
     * owner so a failed open can never hand one owner's bytes to another.
     * @type {Map<string, { records: PendingRecord[], bytes: number }>}
     */
    this.orphans = new Map()
    this.disposed = false
    this.scanned = false
    /** Async close operations that must finish before `dispose()` resolves. */
    this.operations = new Set()
    /** In-flight reservation/open operations, so a fast close can wait for one. */
    this.openOps = new Set()
  }

  /**
   * Create the directory, load legacy metadata and hydrate attributed journals.
   * Idempotent and never throws.
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
      await this.loadLegacyCatalog()
      await this.scan()
      await this.pruneRecordings(Date.now())
    })()
    return this.ready
  }

  /**
   * Register a new session incarnation and start buffering output.
   *
   * The journal is claimed with `open(file, 'wx')` before any byte is written:
   * two stores, two processes or a reloaded plugin racing on the same logical id
   * each get their own file. An existing journal is never reopened or appended.
   * @param {{ id: string, owner?: string | null, title?: string, transport?: 'ssh' | 'telnet', host?: string, port?: number, username?: string, createdAt?: number }} meta session metadata.
   * @returns {Promise<boolean>} whether a journal was reserved.
   */
  async openSession(meta) {
    if (this.disposed) return false
    const run = this.openInternal(meta)
    this.openOps.add(run)
    const forget = () => {
      this.openOps.delete(run)
    }
    run.then(forget, forget)
    return run
  }

  /**
   * @param {{ id: string, owner?: string | null, title?: string, transport?: 'ssh' | 'telnet', host?: string, port?: number, username?: string, createdAt?: number }} meta session metadata.
   * @returns {Promise<boolean>} whether a journal was reserved.
   * @private
   */
  async openInternal(meta) {
    await this.ensureReady()
    if (this.dir.length === 0) return false
    const source = meta !== null && typeof meta === 'object' ? meta : {}
    const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : ''
    if (id.length === 0) {
      this.log('debug', '[aiterm] history: openSession without an id ignored')
      return false
    }
    const owner = normalizeOwnerValue(source.owner)
    const now = Date.now()
    const createdAt =
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt) ? Math.floor(source.createdAt) : now
    const reserved = await this.reserveJournal(id, owner, {
      title: typeof source.title === 'string' && source.title.length > 0 ? source.title.slice(0, 120) : id,
      transport: source.transport === 'telnet' ? 'telnet' : 'ssh',
      host: typeof source.host === 'string' ? source.host.slice(0, 253) : '',
      port: boundInteger(source.port, 22, 1, 65_535),
      username: typeof source.username === 'string' ? source.username.slice(0, 128) : '',
      createdAt,
    })
    if (reserved === undefined) return false

    // Retire a previous incarnation held by this store (same id): flush it to
    // its own file first, then replace the in-memory writer.
    const previous = this.active.get(id)
    if (previous !== undefined) {
      await this.writePending(previous)
      if (previous.timer !== undefined) clearTimeout(previous.timer)
      this.active.delete(id)
    }

    /** @type {ActiveSession} */
    const state = {
      id,
      file: reserved.journal,
      entry: reserved,
      pending: [],
      pendingBytes: 0,
      timer: undefined,
      chain: Promise.resolve(),
      fileBytes: reserved.fileBytes,
    }
    this.active.set(id, state)
    // Adopt output that raced ahead of this open (first banner, fast telnet).
    const orphanKey = orphanKeyFor(id, owner)
    const orphan = this.orphans.get(orphanKey)
    if (orphan !== undefined) {
      this.orphans.delete(orphanKey)
      if (orphan.records.length > 0) {
        state.pending.push(...orphan.records)
        state.pendingBytes += orphan.bytes
        for (const record of orphan.records) {
          if (record.t > state.entry.lastTs) state.entry.lastTs = record.t
        }
        this.scheduleFlush(state, this.flushIntervalMs)
      }
    }
    if (reserved.fileBytes > this.maxBytesPerSession) await this.truncateSession(state)
    return true
  }

  /**
   * Buffer one decoded chunk. Never throws, never touches the filesystem
   * synchronously; a chunk for a session whose open is still in flight is held
   * briefly and adopted by `openSession()`.
   * @param {string} sessionId session id.
   * @param {string} text decoded output.
   * @param {number} [at] epoch ms (default: now).
   * @param {unknown} [owner] owning DSH session id (the registry always passes it).
   * @returns {void}
   */
  appendChunk(sessionId, text, at, owner) {
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
    const id = typeof sessionId === 'string' ? sessionId : ''
    const wanted = normalizeOwnerValue(owner)
    const state = this.active.get(id)
    if (state === undefined || state.entry.owner !== wanted) {
      this.bufferOrphan(id, wanted, record)
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
   * Wait for buffered writes and pending close-metadata appends.
   * @returns {Promise<void>} completion.
   */
  async whenIdle() {
    await this.ensureReady()
    while (this.openOps.size > 0) await Promise.allSettled([...this.openOps])
    await Promise.allSettled([...this.active.values()].map((state) => this.writePending(state)))
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
    await Promise.allSettled([...this.active.values()].map((state) => state.chain))
  }

  /**
   * Flush and mark a session closed. The journal and metadata stay for
   * `listRecordings` / `queryRecording`; only the owning incarnation is touched.
   * @param {string} sessionId session id.
   * @param {{ closedAt?: number, permission?: { aiAccess?: unknown }, owner?: unknown }} [info] close details.
   * @returns {Promise<void>} completion.
   */
  async closeSession(sessionId, info) {
    if (this.disposed) return
    const run = this.closeInternal(sessionId, info)
    this.operations.add(run)
    const forget = () => {
      this.operations.delete(run)
    }
    run.then(forget, forget)
    return run
  }

  /**
   * @param {string} sessionId session id.
   * @param {{ closedAt?: number, permission?: { aiAccess?: unknown }, owner?: unknown }} [info] close details.
   * @returns {Promise<void>} completion.
   * @private
   */
  async closeInternal(sessionId, info) {
    await this.ensureReady()
    // A close may race the fire-and-forget open from `create()` (the registry
    // never blocks a connect on disk). Wait for in-flight reservations so the
    // close metadata is appended to the same incarnation, never lost.
    if (this.openOps.size > 0) await Promise.allSettled([...this.openOps])
    const id = typeof sessionId === 'string' ? sessionId : ''
    const details = info !== null && typeof info === 'object' ? info : {}
    const ownerGiven = details.owner !== undefined
    const wanted = ownerGiven ? normalizeOwnerValue(details.owner) : undefined
    const state = this.active.get(id)
    let recording
    // A late close for an old incarnation must never flush, delete or stamp a
    // newer incarnation that reused the same logical id for another owner.
    if (state !== undefined && (!ownerGiven || state.entry.owner === wanted)) {
      await this.writePending(state)
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      this.active.delete(id)
      recording = state.entry
    } else {
      const list = await this.lookupRecordings(id)
      recording = list
        .filter((entry) => !ownerGiven || entry.owner === wanted)
        .sort(newestFirst)[0]
    }
    this.dropOrphans(id, wanted)
    if (recording === undefined) return
    const closedAt =
      typeof details.closedAt === 'number' && Number.isFinite(details.closedAt) ? Math.floor(details.closedAt) : Date.now()
    const aiAccess = typeof details.permission?.aiAccess === 'string' && isAiAccess(details.permission.aiAccess)
      ? details.permission.aiAccess
      : undefined
    /** @type {Record<string, unknown>} */
    const meta = {
      [META_MARKER]: 'close',
      version: META_VERSION,
      closedAt,
      bytes: Math.max(0, Math.floor(recording.bytes)),
      lastTs: Math.max(0, Math.floor(recording.lastTs)),
    }
    if (aiAccess !== undefined) meta.aiAccess = aiAccess
    const line = `${JSON.stringify(meta)}\n`
    try {
      await appendFile(recording.journal, line, { mode: 0o600 })
      recording.fileBytes += Buffer.byteLength(line, 'utf8')
    } catch (error) {
      this.warn(`cannot append close metadata for ${id}`, error)
    }
    recording.closedAt = closedAt
    if (aiAccess !== undefined) recording.aiAccess = aiAccess
  }

  /**
   * Attributed recordings (new journals with a valid provenance header).
   * The returned objects carry private `owner`, `aiAccess` and `journal`
   * fields: callers must map them to the public catalog shape before exposing
   * them to tools or the browser.
   * @param {{ limit?: number, since?: number, until?: number }} [query] filter.
   * @returns {Promise<Recording[]>} recordings, newest activity first.
   */
  async listRecordings(query = {}) {
    await this.ensureReady()
    const options = query !== null && typeof query === 'object' ? query : {}
    const limit = boundInteger(options.limit, 100, 1, 1000)
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : -Infinity
    const until = typeof options.until === 'number' && Number.isFinite(options.until) ? options.until : Infinity
    const out = [...this.recordings.values()]
      .filter((recording) => activity(recording) >= since && recording.createdAt <= until)
      .sort(newestFirst)
      .slice(0, limit)
    return out.map((recording) => ({ ...recording }))
  }

  /**
   * Legacy catalog entries (ownerless, from the old `index.json`).
   * @param {{ limit?: number, since?: number, until?: number }} [query] filter.
   * @returns {Promise<CatalogEntry[]>} legacy entries, newest activity first.
   */
  async listLegacySessions(query = {}) {
    await this.ensureReady()
    const options = query !== null && typeof query === 'object' ? query : {}
    const limit = boundInteger(options.limit, 100, 1, 1000)
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : -Infinity
    const until = typeof options.until === 'number' && Number.isFinite(options.until) ? options.until : Infinity
    return [...this.legacy.values()]
      .filter((entry) => activity(entry) >= since && entry.createdAt <= until)
      .sort(newestFirst)
      .slice(0, limit)
      .map((entry) => publicEntry(entry))
  }

  /**
   * Resolve one journal for a read by an owner-scoped caller.
   *
   * Attributed journals are matched by the owner recorded in the header; when
   * several incarnations share a logical id, the newest one for that owner is
   * used. Legacy journals are only resolvable by the explicit human legacy
   * (owner `null`) bucket. Orphans are never resolvable.
   * @param {string} sessionId session id.
   * @param {unknown} owner requester owner (`null` = legacy bucket).
   * @param {'human' | 'ai'} actor caller.
   * @returns {Promise<{ kind: 'attributed', recording: Recording } | { kind: 'legacy', entry: CatalogEntry } | undefined>} resolution.
   */
  async resolveForRead(sessionId, owner, actor) {
    await this.ensureReady()
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const wanted = normalizeOwnerValue(owner)
    // An AI caller must never fall into the ownerless bucket, even if a caller
    // forgets to check before reaching the store.
    if (actor === 'ai' && wanted === null) return undefined
    const list = await this.lookupRecordings(sessionId)
    const owned = list.filter((recording) => recording.owner === wanted).sort(newestFirst)
    if (owned.length > 0) return { kind: 'attributed', recording: owned[0] }
    if (actor === 'human' && wanted === null) {
      const entry = this.legacy.get(sessionId)
      if (entry !== undefined) return { kind: 'legacy', entry }
    }
    return undefined
  }

  /**
   * Whether the recorded closed permission lets the AI read this journal.
   * An absent or unknown value fails closed.
   * @param {Recording} recording recording.
   * @returns {boolean} true only for `ro`/`rw`.
   */
  canAiRead(recording) {
    return recording !== null && typeof recording === 'object' && (recording.aiAccess === 'ro' || recording.aiAccess === 'rw')
  }

  /**
   * Synchronous journal lookup for the exporter. The caller has already
   * resolved/listed this id; this method re-checks owner and permission so a
   * facade cannot accidentally fall back to another owner's or a legacy file.
   * @param {string} sessionId session id.
   * @param {{ owner?: unknown, actor?: 'human' | 'ai' }} [options] requester.
   * @returns {string | undefined} absolute journal path.
   */
  journalForSync(sessionId, options = {}) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id.length === 0) return undefined
    const wanted = normalizeOwnerValue(options.owner)
    const actor = options.actor === 'human' ? 'human' : 'ai'
    if (actor === 'ai' && wanted === null) return undefined
    const state = this.active.get(id)
    if (state !== undefined && state.entry.owner === wanted) return state.file
    const owned = (this.byId.get(id) ?? []).filter((recording) => recording.owner === wanted).sort(newestFirst)
    if (owned.length > 0) {
      const recording = owned[0]
      if (actor === 'ai' && (wanted === null || !this.canAiRead(recording))) return undefined
      return recording.journal
    }
    if (actor === 'human' && wanted === null && this.legacy.has(id)) return this.legacyFileFor(id)
    return undefined
  }

  /**
   * Journal path of the active incarnation for an id, if this store owns it.
   * @param {string} sessionId session id.
   * @returns {string | undefined} absolute journal path.
   */
  activeJournal(sessionId) {
    return this.active.get(typeof sessionId === 'string' ? sessionId : '')?.file
  }

  /**
   * Search one attributed journal. Metadata lines carry no `t`/`d` pair and are
   * therefore ignored by the record parser.
   * @param {Recording} recording recording.
   * @param {{ since?: number, until?: number, search?: string, context?: number, maxMatches?: number, maxBytes?: number }} [query] query.
   * @returns {Promise<HistoryQueryResult>} matches and scan bookkeeping.
   */
  async queryRecording(recording, query = {}) {
    await this.ensureReady()
    if (recording === null || typeof recording !== 'object' || typeof recording.journal !== 'string') {
      return { matches: [], scannedBytes: 0, truncated: false }
    }
    return this.searchJournal(recording.journal, publicEntry(recording), query)
  }

  /**
   * Search one catalogued legacy journal (human legacy bucket only).
   * @param {CatalogEntry} entry legacy entry.
   * @param {{ since?: number, until?: number, search?: string, context?: number, maxMatches?: number, maxBytes?: number }} [query] query.
   * @returns {Promise<HistoryQueryResult>} matches and scan bookkeeping.
   */
  async queryLegacy(entry, query = {}) {
    await this.ensureReady()
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') {
      return { matches: [], scannedBytes: 0, truncated: false }
    }
    return this.searchJournal(this.legacyFileFor(entry.id), publicEntry(entry), query)
  }

  /**
   * Owner-scoped read convenience. Callers that need to distinguish
   * "not found" from "permission denied" use {@link resolveForRead} plus
   * {@link canAiRead} (the registry does that); this wrapper fails closed.
   * @param {{ sessionId?: string, owner?: unknown, actor?: 'human' | 'ai', since?: number, until?: number, search?: string, context?: number, maxMatches?: number, maxBytes?: number }} [query] query.
   * @returns {Promise<HistoryQueryResult>} matches and scan bookkeeping.
   */
  async query(query = {}) {
    await this.ensureReady()
    const options = query !== null && typeof query === 'object' ? query : {}
    const actor = options.actor === 'human' ? 'human' : 'ai'
    const wanted = normalizeOwnerValue(options.owner)
    const resolved = await this.resolveForRead(
      typeof options.sessionId === 'string' ? options.sessionId : '',
      wanted,
      actor,
    )
    if (resolved === undefined) return { matches: [], scannedBytes: 0, truncated: false }
    if (resolved.kind === 'attributed') {
      if (actor === 'ai' && (wanted === null || !this.canAiRead(resolved.recording))) {
        return { matches: [], scannedBytes: 0, truncated: false }
      }
      return this.queryRecording(resolved.recording, options)
    }
    if (actor !== 'human' || wanted !== null) return { matches: [], scannedBytes: 0, truncated: false }
    return this.queryLegacy(resolved.entry, options)
  }

  /**
   * Apply retention and the size cap to attributed journals. Legacy files are
   * never deleted or rewritten: they are exactly the data this migration must
   * preserve.
   * @param {number} [now] epoch ms (default: now).
   * @returns {Promise<void>} completion.
   */
  async prune(now) {
    if (this.disposed) return
    await this.ensureReady()
    await this.pruneRecordings(now)
  }

  /**
   * Flush everything, finish pending metadata appends and stop timers.
   * Idempotent; never throws.
   * @returns {Promise<void>} completion.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    // Let an open that started before shutdown finish first: it may still add a
    // writer that must be flushed, and it must never be left unflushed.
    while (this.openOps.size > 0) await Promise.allSettled([...this.openOps])
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
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
  }

  /**
   * Legacy path for one id, used only for catalogued pre-upgrade journals.
   * @param {string} id session id.
   * @returns {string} journal path.
   */
  legacyFileFor(id) {
    return join(this.dir, `${safeSessionFileName(id)}.ndjson`)
  }

  /**
   * Compatibility alias: older callers used `fileFor` for the legacy path.
   * New code must use {@link journalForSync} or {@link activeJournal}.
   * @param {string} id session id.
   * @returns {string} legacy journal path.
   */
  fileFor(id) {
    return this.legacyFileFor(id)
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
   * Read the legacy catalog. Entries are treated as ownerless metadata only:
   * an `owner` field written by some other version is ignored, never trusted.
   * @returns {Promise<void>} completion.
   * @private
   */
  async loadLegacyCatalog() {
    const index = await readJsonIfPresent(join(this.dir, INDEX_FILE))
    const entries = index !== null && typeof index === 'object' && Array.isArray(index.sessions) ? index.sessions : []
    for (const raw of entries) {
      const entry = normalizeEntry(raw)
      if (entry !== undefined) this.legacy.set(entry.id, entry)
    }
  }

  /**
   * Discover attributed journals by reading their first line. The directory is
   * scanned for read/list purposes only; it is never used to decide an append
   * target (that is the exclusive-create reservation in `reserveJournal`).
   * @returns {Promise<void>} completion.
   * @private
   */
  async scan() {
    if (this.dir.length === 0) return
    let names
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn('cannot scan history directory', error)
      this.scanned = true
      return
    }
    this.scanned = true
    for (const name of names) {
      if (!isIncarnationName(name)) continue
      const file = join(this.dir, name)
      try {
        const recording = await this.readRecording(file)
        if (recording !== undefined) this.register(recording)
      } catch (error) {
        this.warn(`cannot hydrate history journal ${name}`, error)
      }
    }
  }

  /**
   * Read one incarnation's header, size and close metadata.
   * @param {string} file absolute path.
   * @returns {Promise<Recording | undefined>} recording or undefined when the
   *   header is missing/malformed (the file is then left untouched and fails
   *   closed for every owner-scoped caller).
   * @private
   */
  async readRecording(file) {
    const headerLine = await readFirstLine(file)
    const meta = parseJournalHeader(headerLine)
    if (meta === undefined) return undefined
    let info
    try {
      info = await stat(file)
    } catch {
      return undefined
    }
    const tail = await readTailLines(file, info.size)
    let closedAt
    let aiAccess
    let closedBytes
    let lastTs = meta.createdAt
    for (const line of tail) {
      const parsed = parseJsonObject(line)
      if (parsed === undefined) continue
      if (parsed[META_MARKER] === 'close') {
        const candidate = finiteInteger(parsed.closedAt, undefined)
        if (candidate !== undefined) closedAt = candidate
        if (typeof parsed.aiAccess === 'string' && isAiAccess(parsed.aiAccess)) aiAccess = parsed.aiAccess
        const bytes = finiteInteger(parsed.bytes, undefined)
        if (bytes !== undefined && bytes >= 0) closedBytes = bytes
        const closedLast = finiteInteger(parsed.lastTs, undefined)
        if (closedLast !== undefined && closedLast > lastTs) lastTs = closedLast
      } else if (typeof parsed.t === 'number' && Number.isFinite(parsed.t) && parsed.t > lastTs) {
        lastTs = Math.floor(parsed.t)
      }
    }
    const headerBytes = Buffer.byteLength(headerLine, 'utf8') + 1
    /** @type {Recording} */
    const recording = {
      ...meta,
      journal: file,
      fileBytes: info.size,
      bytes: closedBytes !== undefined ? closedBytes : Math.max(0, info.size - headerBytes),
      lastTs,
    }
    if (closedAt !== undefined) recording.closedAt = closedAt
    if (aiAccess !== undefined) recording.aiAccess = aiAccess
    return recording
  }

  /**
   * Add/merge one hydrated recording without replacing an active in-memory
   * writer (which owns the freshest buffered state).
   * @param {Recording} recording recording.
   * @returns {void}
   * @private
   */
  register(recording) {
    const existing = this.recordings.get(recording.journal)
    if (existing !== undefined) {
      const active = [...this.active.values()].some((state) => state.entry === existing)
      if (!active) Object.assign(existing, recording)
      return
    }
    this.recordings.set(recording.journal, recording)
    const list = this.byId.get(recording.id)
    if (list === undefined) this.byId.set(recording.id, [recording])
    else list.push(recording)
  }

  /**
   * @param {string} sessionId session id.
   * @returns {Promise<Recording[]>} recordings for the id (rescans once on miss).
   * @private
   */
  async lookupRecordings(sessionId) {
    let list = this.byId.get(sessionId)
    if (list === undefined && this.scanned) {
      await this.scan()
      list = this.byId.get(sessionId)
    }
    return list ?? []
  }

  /**
   * Reserve a brand-new journal incarnation with an exclusive create.
   * @param {string} id session id.
   * @param {string | null} owner owner.
   * @param {{ title: string, transport: 'ssh' | 'telnet', host: string, port: number, username: string, createdAt: number }} meta metadata.
   * @returns {Promise<Recording | undefined>} the reserved recording.
   * @private
   */
  async reserveJournal(id, owner, meta) {
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
      const file = join(this.dir, `${safeSessionFileName(id)}${INCARNATION_SEPARATOR}${randomUUID()}.ndjson`)
      let handle
      try {
        handle = await open(file, 'wx', 0o600)
      } catch (error) {
        if (error?.code === 'EEXIST') continue
        this.warn(`cannot reserve history journal for ${id}`, error)
        return undefined
      }
      try {
        /** @type {Record<string, unknown>} */
        const header = {
          [META_MARKER]: 'journal',
          version: META_VERSION,
          id: id.slice(0, 128),
          owner,
          title: meta.title,
          transport: meta.transport,
          host: meta.host,
          port: meta.port,
          username: meta.username,
          createdAt: meta.createdAt,
        }
        await handle.writeFile(`${JSON.stringify(header)}\n`, 'utf8')
        await handle.sync()
        const info = await handle.stat()
        /** @type {Recording} */
        const recording = {
          id: id.slice(0, 128),
          owner,
          journal: file,
          title: meta.title,
          transport: meta.transport,
          host: meta.host,
          port: meta.port,
          username: meta.username,
          createdAt: meta.createdAt,
          bytes: 0,
          lastTs: meta.createdAt,
          fileBytes: info.size,
        }
        this.register(recording)
        return recording
      } catch (error) {
        this.warn(`cannot initialize history journal for ${id}`, error)
        return undefined
      } finally {
        try {
          await handle.close()
        } catch {
          // the reservation already exists; a close failure is harmless
        }
      }
    }
    this.warn(`cannot reserve a unique history journal for ${id} after ${MAX_RESERVE_ATTEMPTS} attempts`)
    return undefined
  }

  /**
   * Apply retention/cap internally (no `ensureReady`, so `init()` can call it).
   * @param {number} [now] epoch ms.
   * @returns {Promise<void>} completion.
   * @private
   */
  async pruneRecordings(now) {
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const cutoff = at - this.retentionMs
    const activeJournals = new Set([...this.active.values()].map((state) => state.entry.journal))
    const all = [...this.recordings.values()].sort(newestFirst)
    for (const recording of all) {
      if (activeJournals.has(recording.journal)) continue
      if (activity(recording) < cutoff) await this.removeRecording(recording)
    }
    const remaining = [...this.recordings.values()]
      .filter((recording) => !activeJournals.has(recording.journal))
      .sort(newestFirst)
    if (remaining.length > this.maxSessions) {
      for (const recording of remaining.slice(this.maxSessions)) await this.removeRecording(recording)
    }
  }

  /**
   * Delete one attributed journal (retention/cap only; legacy is untouched).
   * @param {Recording} recording recording.
   * @returns {Promise<void>} completion.
   * @private
   */
  async removeRecording(recording) {
    this.recordings.delete(recording.journal)
    const list = this.byId.get(recording.id)
    if (list !== undefined) {
      const next = list.filter((entry) => entry !== recording)
      if (next.length === 0) this.byId.delete(recording.id)
      else this.byId.set(recording.id, next)
    }
    try {
      await rm(recording.journal, { force: true })
    } catch (error) {
      this.warn(`cannot remove history for ${recording.id}`, error)
    }
  }

  /**
   * Run the journal-tail search shared by attributed and legacy reads.
   * @param {string} file journal path.
   * @param {CatalogEntry} entry public entry.
   * @param {{ since?: number, until?: number, search?: string, context?: number, maxMatches?: number, maxBytes?: number }} [query] query.
   * @returns {Promise<HistoryQueryResult>} matches and scan bookkeeping.
   * @private
   */
  async searchJournal(file, entry, query = {}) {
    const options = query !== null && typeof query === 'object' ? query : {}
    /** @type {HistoryQueryResult} */
    const result = { matches: [], scannedBytes: 0, truncated: false }
    if (this.dir.length === 0) return result
    let buffer
    try {
      buffer = await readFile(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot read history ${file}`, error)
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
          break
        }
        /** @type {HistoryMatch} */
        const match = {
          at: timestampAt(boundaries, records[index].offset),
          line: record.text,
          before: [],
          after: [],
        }
        for (let i = Math.max(0, index - context); i < index; i += 1) match.before.push(records[i].text)
        matches.push(match)
        if (context > 0) pendingAfter.push(match)
      }
    }

    result.matches = matches
    return withEntry(result, entry)
  }

  /**
   * Hold output for a session whose `openSession()` has not finished yet.
   * @param {string} id session id.
   * @param {string | null} owner owner.
   * @param {PendingRecord} record decoded record.
   * @returns {void}
   * @private
   */
  bufferOrphan(id, owner, record) {
    if (id.length === 0) return
    const key = orphanKeyFor(id, owner)
    let orphan = this.orphans.get(key)
    if (orphan === undefined) {
      if (this.orphans.size >= MAX_ORPHAN_SESSIONS) {
        const oldest = this.orphans.keys().next()
        if (oldest.done !== true) this.orphans.delete(oldest.value)
      }
      orphan = { records: [], bytes: 0 }
      this.orphans.set(key, orphan)
      this.log('debug', `[aiterm] history: buffering output for not-yet-open session ${id}`)
    }
    if (orphan.bytes + record.size > FLUSH_THRESHOLD_BYTES) return
    orphan.records.push(record)
    orphan.bytes += record.size
  }

  /**
   * Drop every pre-open buffer for an id when the session closes.
   * @param {string} id session id.
   * @returns {void}
   * @private
   */
  dropOrphans(id, owner) {
    if (owner !== undefined) {
      this.orphans.delete(orphanKeyFor(id, owner))
      return
    }
    const suffix = `\u0000${id}`
    for (const key of [...this.orphans.keys()]) {
      if (key.endsWith(suffix)) this.orphans.delete(key)
    }
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
   * Append buffered records to this incarnation's journal, serialized per
   * session. Only the state's own file is ever touched.
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
      if (state.fileBytes > this.maxBytesPerSession) await this.truncateSession(state)
    }
    state.chain = state.chain.then(task, task)
    return state.chain
  }

  /**
   * Rewrite a journal to its tail, always preserving the provenance header.
   * Without the header the data is unusable (fail closed), so a file whose
   * header cannot be found is left alone.
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
    const headerLine = lines.length > 0 && parseJournalHeader(lines[0]) !== undefined ? lines[0] : undefined
    if (headerLine === undefined) {
      this.warn(`refusing to truncate history for ${state.id}: provenance header is missing`)
      return
    }
    /** @type {string[]} */
    const kept = []
    let fileBytes = Buffer.byteLength(headerLine, 'utf8') + 1
    let payloadBytes = 0
    let lastTs = 0
    for (let index = lines.length - 1; index >= 1; index -= 1) {
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
    const body = `${headerLine}\n${kept.length > 0 ? `${kept.join('\n')}\n` : ''}`
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
 * Normalize an owner for comparison in this store.
 * @param {unknown} value raw owner.
 * @returns {string | null} trimmed owner or `null`.
 */
export function normalizeOwnerValue(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  return text.slice(0, 128)
}

/**
 * Stable key for pre-open output, scoped to one owner so a failed open cannot
 * leak bytes into a later incarnation owned by somebody else.
 * @param {string} id session id.
 * @param {string | null} owner owner.
 * @returns {string} key.
 */
function orphanKeyFor(id, owner) {
  return `${owner === null ? '\u0001null' : owner}\u0000${id}`
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
 * Whether a directory entry is a new-format incarnation journal.
 * Legacy files are `<id>.ndjson` (never enumerated as attributed data).
 * @param {string} name file name.
 * @returns {boolean} true for new-format journals.
 */
function isIncarnationName(name) {
  return name.endsWith('.ndjson') && name.includes(INCARNATION_SEPARATOR)
}

/**
 * Read the first line of a file without slurping a large journal.
 * @param {string} file absolute path.
 * @returns {Promise<string>} first line (or the partial file when there is no newline).
 */
async function readFirstLine(file) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0)
    const chunk = buffer.subarray(0, bytesRead)
    const newline = chunk.indexOf(0x0a)
    return chunk.subarray(0, newline === -1 ? chunk.length : newline).toString('utf8')
  } finally {
    try {
      await handle.close()
    } catch {
      // read handle cleanup is best effort
    }
  }
}

/**
 * Read the last lines of a journal for close metadata and newest timestamp.
 * @param {string} file absolute path.
 * @param {number} size file size.
 * @returns {Promise<string[]>} complete tail lines.
 */
async function readTailLines(file, size) {
  if (size <= 0) return []
  const start = Math.max(0, size - TAIL_READ_BYTES)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    // A tail cut starts mid-line; drop that partial first line.
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return text.split('\n').filter((line) => line.trim().length > 0)
  } finally {
    try {
      await handle.close()
    } catch {
      // read handle cleanup is best effort
    }
  }
}

/**
 * Parse a journal header line.
 * @param {string} line first line.
 * @returns {{ id: string, owner: string | null, title: string, transport: 'ssh' | 'telnet', host: string, port: number, username: string, createdAt: number } | undefined} metadata.
 */
function parseJournalHeader(line) {
  const parsed = parseJsonObject(line)
  if (parsed === undefined) return undefined
  if (parsed[META_MARKER] !== 'journal') return undefined
  if (parsed.version !== META_VERSION) return undefined
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) return undefined
  const ownerValid = parsed.owner === null || typeof parsed.owner === 'string'
  if (!ownerValid) return undefined
  let owner = null
  if (typeof parsed.owner === 'string') {
    const text = parsed.owner.trim()
    // An empty owner string in a header is corruption: an ownerless journal
    // must say `null`, so this file is left unattributed and fails closed.
    if (text.length === 0) return undefined
    owner = text.slice(0, 128)
  }
  return {
    id: parsed.id.slice(0, 128),
    owner,
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 120) : parsed.id.slice(0, 128),
    transport: parsed.transport === 'telnet' ? 'telnet' : 'ssh',
    host: typeof parsed.host === 'string' ? parsed.host.slice(0, 253) : '',
    port: boundInteger(parsed.port, 22, 1, 65_535),
    username: typeof parsed.username === 'string' ? parsed.username.slice(0, 128) : '',
    createdAt: finiteInteger(parsed.createdAt, 0),
  }
}

/**
 * @param {unknown} value candidate.
 * @returns {boolean} whether it is a known AI access mode.
 */
function isAiAccess(value) {
  return value === 'ro' || value === 'wo' || value === 'rw'
}

/**
 * Parse a JSON object defensively.
 * @param {string} line input line.
 * @returns {Record<string, unknown> | undefined} parsed object.
 */
function parseJsonObject(line) {
  if (typeof line !== 'string' || line.trim().length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * @param {{ createdAt: number, lastTs?: number }} entry entry.
 * @returns {number} sortable activity timestamp.
 */
function activity(entry) {
  return typeof entry.lastTs === 'number' ? entry.lastTs : entry.createdAt
}

/**
 * @param {{ createdAt: number, lastTs?: number }} left first.
 * @param {{ createdAt: number, lastTs?: number }} right second.
 * @returns {number} comparator, newest first.
 */
function newestFirst(left, right) {
  return activity(right) - activity(left) || right.createdAt - left.createdAt
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
 * `owner`, `aiAccess` and `journal` are private provenance and are deliberately
 * dropped here: no tool result or browser payload may reveal them.
 * @param {CatalogEntry | Recording} entry catalog entry or recording.
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
