/**
 * Optional automatic per-session log files.
 *
 * Off by default. When the user enables it, every output chunk the registry
 * receives is appended to `<dir>/<sessionId>.log` after a small header block;
 * turning it off stops writing immediately. The switch and the directory are
 * persisted in `<dataDir>/settings.json` (0600) so they survive a Host restart,
 * and can be changed at runtime through the `autolog.get` / `autolog.set` RPC
 * methods and the `aiterm_autolog` tool.
 *
 * This module is deliberately paranoid about failure: a full disk, a deleted
 * directory or a path that turns into a directory must never surface in a live
 * terminal session. Writes are queued through one promise chain (no interleaved
 * chunks), the first write error logs a warning once and downgrades the feature
 * to disabled, and no rejection ever escapes `append()`.
 */

import { constants } from 'node:fs'
import { access, appendFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { coded, ensureDir, readJsonIfPresent, writeJsonAtomic } from './util.js'

/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE = 'settings.json'
/** Default output directory name inside the plugin data directory. */
const DEFAULT_DIR_NAME = 'logs'
/** Key under which this feature stores its state in `settings.json`. */
const SETTINGS_KEY = 'autolog'
/** Longest accepted directory path. */
const MAX_DIR_LENGTH = 1024
/** Chunks buffered while `settings.json` is still being read. */
const MAX_PRELOAD_CHUNKS = 512

/**
 * @typedef {object} AutoLogHeader
 * @property {'ssh' | 'telnet'} transport
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} title
 * @property {number} [startedAt] epoch ms.
 */

/**
 * @typedef {object} AutoLogState
 * @property {boolean} enabled
 * @property {string} dir absolute output directory.
 */

/**
 * Per-session append-only log files with a runtime switch.
 */
export class AutoLog {
  /**
   * @param {object} [options] options.
   * @param {string} options.dataDir plugin data directory (holds `settings.json`).
   * @param {string} [options.dir] initial output directory (default `<dataDir>/logs`).
   * @param {string} [options.settingsFile] override the settings file path.
   * @param {(level: string, message: string) => void} [options.log] logger.
   * @param {boolean} [options.enabled] initial switch (settings.json wins).
   */
  constructor(options = {}) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    this.dataDir = typeof opts.dataDir === 'string' ? opts.dataDir : ''
    this.settingsFile =
      typeof opts.settingsFile === 'string' && opts.settingsFile.length > 0
        ? opts.settingsFile
        : this.dataDir.length > 0
          ? join(this.dataDir, SETTINGS_FILE)
          : ''
    this.log = typeof opts.log === 'function' ? opts.log : () => {}
    this.enabled = opts.enabled === true
    this.dir =
      typeof opts.dir === 'string' && opts.dir.length > 0
        ? this.resolveDir(opts.dir)
        : this.dataDir.length > 0
          ? join(this.dataDir, DEFAULT_DIR_NAME)
          : ''
    /** Whether settings.json has been read; until then chunks are buffered. */
    this.loaded = false
    /**
     * True when an enabled switch was persisted by an older version without a
     * human review marker. The runtime stays off until the human confirms; the
     * original file and directory are preserved untouched.
     */
    this.needsReview = false
    /** Whether the persisted value that needs review was enabled. */
    this.legacyEnabled = false
    this.disposed = false
    /** Set after the first write failure so the warning is logged exactly once. */
    this.warned = false
    /** Metadata used to write the header block for each session. */
    this.headers = new Map()
    /** Sessions whose header has already been written to disk. */
    this.headed = new Set()
    /** Serialized write queue: one append at a time, in arrival order. */
    this.chain = Promise.resolve()
    /** @type {Array<{ id: string, text: string }>} */
    this.preload = []
    /** @type {Promise<void> | undefined} */
    this.initPromise = undefined
  }

  /**
   * Resolve a user-supplied directory (absolute, or relative to the data dir).
   * @param {string} value directory.
   * @returns {string} absolute path.
   */
  resolveDir(value) {
    return isAbsolute(value) ? resolve(value) : resolve(this.dataDir, value)
  }

  /**
   * Read persisted settings once, then flush anything buffered before the read.
   * Idempotent and never throws.
   * @returns {Promise<void>} completion.
   */
  async init() {
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = (async () => {
      await this.loadSettings()
      const pending = this.preload
      this.preload = []
      if (this.enabled) {
        for (const item of pending) this.append(item.id, item.text)
      }
    })().catch((error) => {
      this.log('debug', `[aiterm] automatic log settings could not be read: ${errorMessage(error)}`)
    })
    return this.initPromise
  }

  /**
   * @returns {AutoLogState} current switch and directory.
   */
  get() {
    return {
      enabled: this.enabled === true,
      dir: this.dir,
      needsReview: this.needsReview === true,
    }
  }

  /**
   * Change the switch and/or directory, persist it, and return the new state.
   * @param {{ enabled?: boolean, dir?: string }} [options] changes.
   * @returns {Promise<AutoLogState>} new state.
   * @throws {import('./util.js').CodedError} `BAD_TARGET` for an unusable directory.
   */
  async set(options = {}) {
    if (this.disposed) throw coded('DISPOSED', 'the SSH/Telnet plugin is shutting down', 503)
    await this.init()
    const opts = options !== null && typeof options === 'object' ? options : {}
    const nextEnabled = typeof opts.enabled === 'boolean' ? opts.enabled : this.enabled
    const dirProvided = opts.dir !== undefined && opts.dir !== null
    const nextDir = dirProvided ? this.validateDir(opts.dir) : this.dir
    this.dir = nextDir
    if (nextEnabled || dirProvided) {
      try {
        await this.ensureOutputDir()
      } catch (error) {
        // Do not leave the state pointing at a directory we cannot write to.
        throw coded('BAD_TARGET', `automatic log directory is not usable: ${errorMessage(error)}`)
      }
    }
    if (nextEnabled && this.enabled !== true) this.warned = false
    this.enabled = nextEnabled
    // Any explicit human change (including confirming "keep off") reviews the
    // legacy state; only then may the settings file be rewritten.
    this.needsReview = false
    this.legacyEnabled = false
    await this.persist()
    return this.get()
  }

  /**
   * Record a session's metadata so the first append can write a header block.
   * @param {string} sessionId session id.
   * @param {AutoLogHeader} header metadata (never contains credentials).
   * @returns {void}
   */
  open(sessionId, header) {
    const id = safeSessionId(sessionId)
    if (id.length === 0) return
    const source = header !== null && typeof header === 'object' ? header : {}
    /** @type {AutoLogHeader} */
    const meta = {
      transport: source.transport === 'telnet' ? 'telnet' : 'ssh',
      host: typeof source.host === 'string' ? source.host : '',
      port: typeof source.port === 'number' && Number.isFinite(source.port) ? Math.floor(source.port) : 0,
      username: typeof source.username === 'string' ? source.username : '',
      title: typeof source.title === 'string' && source.title.length > 0 ? source.title : id,
      startedAt: typeof source.startedAt === 'number' && Number.isFinite(source.startedAt) ? Math.floor(source.startedAt) : Date.now(),
    }
    this.headers.set(id, meta)
    if (this.loaded && this.enabled && !this.headed.has(id)) this.writeHeader(id)
  }

  /**
   * Queue one output chunk. Never throws, never blocks the caller.
   * @param {string} sessionId session id.
   * @param {string} text decoded output.
   * @returns {void}
   */
  append(sessionId, text) {
    if (this.disposed || typeof text !== 'string' || text.length === 0) return
    const id = safeSessionId(sessionId)
    if (id.length === 0) return
    if (!this.loaded) {
      // The settings read is a disk hop; buffer the first banner instead of
      // dropping it, bounded so a stuck read cannot grow memory.
      if (this.preload.length < MAX_PRELOAD_CHUNKS) this.preload.push({ id, text })
      return
    }
    if (!this.enabled || this.dir.length === 0) return
    if (!this.headed.has(id)) this.writeHeader(id)
    this.enqueue(() => appendFile(this.fileFor(id), text, { mode: 0o600 }))
  }

  /**
   * Await every queued write for one session (or all of them).
   * @param {string} [sessionId] retained for API symmetry; the queue is global.
   * @returns {Promise<void>} completion.
   */
  async close(sessionId) {
    this.headers.delete(safeSessionId(sessionId ?? ''))
    await this.flush()
  }

  /**
   * Await write-queue drain.
   * @returns {Promise<void>} completion.
   */
  async flush() {
    try {
      await this.chain
    } catch {
      // `enqueue` already converts failures into a downgrade; defensive only.
    }
  }

  /**
   * Stop writing (idempotent) after flushing what is already queued.
   * @returns {Promise<void>} completion.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.flush()
    this.headers.clear()
    this.headed.clear()
    this.preload = []
  }

  /**
   * One directory scan of existing log ids. Session-id allocation uses this so
   * a new session cannot append to an old owner's `<id>.log`. A non-ENOENT
   * directory error is propagated: the caller must fail allocation instead of
   * guessing that no old files exist.
   * @returns {Promise<Set<string>>} ids with an existing log file.
   */
  async listLogIds() {
    if (this.dir.length === 0) return new Set()
    let names
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return new Set()
      throw error
    }
    const ids = new Set()
    for (const name of names) {
      if (!name.endsWith('.log')) continue
      ids.add(name.slice(0, -'.log'.length))
    }
    return ids
  }

  /**
   * Whether a log file already exists for an id. Session-id allocation uses
   * this so a reused pre-upgrade id cannot silently append a new owner's output
   * to an old log file.
   * @param {string} sessionId session id.
   * @returns {Promise<boolean>} true when a log file exists.
   */
  async hasLog(sessionId) {
    if (this.dir.length === 0) return false
    try {
      await stat(this.fileFor(sessionId))
      return true
    } catch {
      return false
    }
  }

  /**
   * @param {string} sessionId session id.
   * @returns {string} absolute log file path.
   */
  fileFor(sessionId) {
    return join(this.dir, `${safeSessionId(sessionId)}.log`)
  }

  /**
   * Queue a task, serializing writes and converting any failure into a warning
   * plus a downgrade to disabled. The queue itself always resolves.
   * @param {() => Promise<unknown>} task write work.
   * @returns {void}
   */
  enqueue(task) {
    this.chain = this.chain.then(task).catch((error) => this.fail(error))
  }

  /**
   * Handle one write failure: warn exactly once, stop writing.
   * @param {unknown} error failure.
   * @returns {void}
   */
  fail(error) {
    if (!this.warned) {
      this.warned = true
      this.log('warn', `[aiterm] automatic log write failed; disabling automatic log files: ${errorMessage(error)}`)
    }
    this.enabled = false
  }

  /**
   * Queue the header block for one session (no-op without metadata).
   * @param {string} id safe session id.
   * @returns {void}
   */
  writeHeader(id) {
    this.headed.add(id)
    const header = this.headers.get(id)
    if (header === undefined) return
    const content = headerBlock(id, header)
    this.enqueue(() => appendFile(this.fileFor(id), content, { mode: 0o600 }))
  }

  /**
   * Read persisted settings (best effort) and validate the configured directory.
   * @returns {Promise<void>} completion.
   */
  async loadSettings() {
    this.loaded = true
    if (this.settingsFile.length === 0) return
    const parsed = await readJsonIfPresent(this.settingsFile)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const section = parsed[SETTINGS_KEY]
      if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
        const persistedEnabled = section.enabled === true
        const reviewed = typeof section.reviewedAt === 'number' && Number.isFinite(section.reviewedAt)
        if (typeof section.dir === 'string' && section.dir.length > 0) {
          this.dir = this.resolveDir(section.dir.trim())
        }
        if (persistedEnabled && !reviewed) {
          // An older version (including one the AI could drive) left this
          // enabled. Do not silently keep writing every owner's output, and do
          // not rewrite/disable the persisted setting behind the user's back.
          this.legacyEnabled = true
          this.needsReview = true
          this.enabled = false
          this.log(
            'warn',
            '[aiterm] automatic log files were enabled by an older version; they stay off until the human confirms the setting in the history panel',
          )
        } else {
          this.enabled = persistedEnabled
        }
      }
    }
    if (this.enabled) {
      try {
        await this.ensureOutputDir()
      } catch (error) {
        this.enabled = false
        this.log('warn', `[aiterm] persisted automatic log directory is unusable; disabled: ${errorMessage(error)}`)
      }
    }
  }

  /**
   * Create and check the output directory.
   * @returns {Promise<void>} completion.
   */
  async ensureOutputDir() {
    if (this.dir.length === 0) throw new Error('no output directory configured')
    await ensureDir(this.dir)
    const info = await stat(this.dir)
    if (!info.isDirectory()) throw new Error(`${this.dir} is not a directory`)
    await access(this.dir, constants.W_OK)
  }

  /**
   * Persist `{ enabled, dir }` under settings.json, preserving other keys.
   * @returns {Promise<void>} completion.
   */
  async persist() {
    if (this.settingsFile.length === 0) return
    const parsed = await readJsonIfPresent(this.settingsFile)
    const base = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const next = {
      ...base,
      version: typeof base.version === 'number' && Number.isFinite(base.version) ? base.version : 1,
      [SETTINGS_KEY]: {
        enabled: this.enabled === true,
        dir: this.dir,
        // A human has explicitly reviewed this switch through the panel/tool
        // gate. Older files have no marker and therefore need confirmation.
        reviewedAt: Date.now(),
      },
    }
    await writeJsonAtomic(this.settingsFile, next)
  }

  /**
   * Validate a directory argument.
   * @param {unknown} value candidate directory.
   * @returns {string} absolute path.
   * @throws {import('./util.js').CodedError} `BAD_TARGET` for any illegal value.
   */
  validateDir(value) {
    if (typeof value !== 'string') throw coded('BAD_TARGET', 'dir must be a string')
    const text = value.trim()
    if (text.length === 0) throw coded('BAD_TARGET', 'dir must not be empty')
    if (text.length > MAX_DIR_LENGTH) throw coded('BAD_TARGET', `dir must be at most ${MAX_DIR_LENGTH} characters`)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) throw coded('BAD_TARGET', 'dir must not contain control characters')
    return this.resolveDir(text)
  }
}

/**
 * Format the header block for one session. Only routing metadata is included:
 * no password, key, passphrase or profile secret may ever reach a log file.
 * @param {string} id safe session id.
 * @param {AutoLogHeader} header metadata.
 * @returns {string} header text ending with a newline.
 */
function headerBlock(id, header) {
  const port = Number.isFinite(header.port) && header.port > 0 ? String(header.port) : '?'
  const started = Number.isFinite(header.startedAt) ? new Date(header.startedAt).toISOString() : '-'
  const parts = [
    `# session ${token(id, 64)}`,
    `transport ${token(header.transport, 16)}`,
    `host:port ${token(header.host, 253)}:${port}`,
    `username ${token(header.username, 128)}`,
    `title "${token(header.title, 200)}"`,
    `started ${started}`,
  ]
  return `${parts.join(' ')}\n`
}

/**
 * Strip control characters and quotes so a title cannot forge header lines,
 * then bound the length.
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
 * Reduce a session id to a safe file-name component.
 * @param {unknown} value session id.
 * @returns {string} safe id (never empty for valid input).
 */
function safeSessionId(value) {
  const raw = typeof value === 'string' ? value : ''
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return safe.length === 0 || safe === '.' || safe === '..' ? '' : safe
}

/**
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
