/**
 * Multi-session SSH/Telnet registry: the single place where terminal input and
 * output cross between the human (browser RPC), the model (tools) and the remote
 * host.
 *
 * Every write goes through {@link SessionRegistry#write}, so the permission
 * rules in `permission.js` cannot be bypassed by either caller. Every output
 * byte is mirrored three ways: into a byte ring (exact replay for a reconnecting
 * xterm), into a headless terminal screen (readable screenshots for the model),
 * and out to SSE subscribers.
 */

import { join } from 'node:path'

import { connect as connectSsh } from './transports/ssh.js'
import { connect as connectTelnet } from './transports/telnet.js'
import { AutoLog } from './autolog.js'
import { exportSessions } from './exporter.js'
import { Screen } from './screen.js'
import { OutputLog } from './outputlog.js'
import { diffScreen } from './screendiff.js'
import { detectPrompt } from './promptdetect.js'
import { ByteRing, auditPreview, boundInteger, coded, toBase64 } from './util.js'
import {
  checkRead,
  checkWrite,
  createPermission,
  derive,
  expireIfIdle,
  noteAiWrite,
  permissionSnapshot,
  releaseLock,
  setAiAccess,
  takeOver,
} from './permission.js'

/** Audit entries retained per session. */
const AUDIT_PER_SESSION = 200
/** Audit entries retained globally (for `audit.list` without a session id). */
const AUDIT_GLOBAL = 500
/** Largest human input accepted in one RPC call. */
const MAX_INPUT_BYTES = 64 * 1024

/** @typedef {import('./permission.js').PermissionState} PermissionState */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} title
 * @property {'ssh' | 'telnet'} transport
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string | undefined} profileId
 * @property {string | null} owner owning DSH (AI) session id; null = legacy/global bucket
 * @property {'connecting' | 'open' | 'closed' | 'failed'} state
 * @property {string | undefined} error
 * @property {number} cols
 * @property {number} rows
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} lastActivityAt
 * @property {number} bytesIn
 * @property {number} bytesOut
 * @property {PermissionState} permission
 * @property {Screen} screen
 * @property {ByteRing} ring
 * @property {OutputLog} output
 * @property {Map<string, number>} cursors per-reader delta byte offsets
 * @property {Map<string, string[]>} screens per-reader last visible screen (for changedOnly)
 * @property {Set<any>} waiters pending waitFor() waiters
 * @property {number} lastOutputAt epoch ms of the last output byte
 * @property {any} connection
 * @property {Promise<void>} readyPromise
 * @property {any} lockTimer
 * @property {Array<Record<string, unknown>>} audit
 * @property {string | undefined} hostKeyFingerprint
 */

/**
 * @typedef {object} RegistryEvent
 * @property {'sessions' | 'state' | 'data' | 'exit' | 'audit'} type
 * @property {string} [sessionId]
 * @property {string} [chunk] base64 output
 * @property {string} [replay] base64 retained output
 * @property {Record<string, unknown>} [session]
 * @property {Array<Record<string, unknown>>} [sessions]
 * @property {Record<string, unknown>} [entry]
 * @property {number | null} [code]
 * @property {string} [reason]
 */

/**
 * Owns every live session.
 */
export class SessionRegistry {
  /**
   * @param {object} options options.
   * @param {ReturnType<import('./config.js').resolveConfig>} options.config resolved plugin config.
   * @param {import('./profiles.js').ProfileStore} options.profiles saved profiles.
   * @param {string} options.dataDir plugin data directory.
   * @param {(level: string, message: string) => void} options.log logger.
   * @param {import('./history-store.js').HistoryStore} [options.historyStore] durable history journal.
   * @param {import('./autolog.js').AutoLog} [options.autolog] automatic per-session log files
   *   (created on demand under `dataDir` when omitted).
   */
  constructor({ config, profiles, dataDir, log, historyStore, autolog }) {
    this.config = config
    this.profiles = profiles
    this.dataDir = dataDir
    this.log = log
    this.historyStore = historyStore
    // Automatic log files are opt-in and off by default; the instance owns the
    // runtime switch and persists it in `<dataDir>/settings.json`.
    this.autolog = autolog ?? new AutoLog({ dataDir: this.dataDir, log: this.log })
    this.autolog
      .init()
      .catch((error) => this.log('debug', `[aiterm] automatic log init failed: ${error instanceof Error ? error.message : String(error)}`))
    try {
      this.promptRegExp = new RegExp(config.promptPattern)
    } catch {
      // A malformed user pattern must not disable the plugin.
      this.promptRegExp = undefined
      this.log('warn', `[aiterm] invalid promptPattern; prompt detection disabled`)
    }
    /** @type {Map<string, SessionRecord>} */
    this.sessions = new Map()
    this.nextId = 1
    /** @type {Set<(event: RegistryEvent) => void>} */
    this.listeners = new Set()
    /** @type {Array<Record<string, unknown>>} */
    this.globalAudit = []
    /**
     * Ownership of sessions that already left the live map (closed/replaced), so
     * durable history and audit lookups can still be attributed to a DSH session.
     * Bounded: ownership of pre-restart sessions is unknown and treated as legacy.
     * @type {Map<string, string | null>}
     */
    this.owners = new Map()
    this.disposed = false
  }

  /**
   * Subscribe to registry events (session list changes, output, state, audit).
   * @param {(event: RegistryEvent) => void} listener subscriber.
   * @returns {() => void} unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Broadcast one event, isolating subscriber failures.
   * @param {RegistryEvent} event event.
   * @returns {void}
   */
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.log('debug', `[aiterm] subscriber failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * @param {unknown} owner owner filter (DSH session id); `null`/absent = legacy bucket.
   * @returns {Array<Record<string, unknown>>} sessions owned by `owner`, newest last.
   */
  list(owner = null) {
    const wanted = normalizeOwner(owner)
    return [...this.sessions.values()]
      .filter((session) => sessionOwner(session) === wanted)
      .map((session) => this.info(session))
  }

  /**
   * Freeze one session for the wire (never includes secrets).
   * @param {SessionRecord} session session.
   * @returns {Record<string, unknown>} wire info.
   */
  info(session) {
    /** @type {Record<string, unknown>} */
    const info = {
      id: session.id,
      title: session.title,
      transport: session.transport,
      host: session.host,
      port: session.port,
      username: session.username,
      profileId: session.profileId,
      state: session.state,
      error: session.error,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastActivityAt: session.lastActivityAt,
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
      hostKeyFingerprint: session.hostKeyFingerprint,
      permission: permissionSnapshot(session.permission),
      generation: session.generation ?? 0,
      disconnectedAt: session.disconnectedAt,
      closeReason: session.closeReason,
      reconnecting: session.reconnecting === true,
    }
    // Tool results must be lossless JSON: omit absent optional fields instead of
    // emitting `undefined`, which no JSON encoder preserves.
    for (const key of ['profileId', 'error', 'hostKeyFingerprint', 'disconnectedAt', 'closeReason']) {
      if (info[key] === undefined) delete info[key]
    }
    return info
  }

  /**
   * Resolve a session by id, enforcing ownership.
   *
   * A session owned by another DSH (AI) session is reported exactly like a
   * missing one, so the error cannot be used to probe for existence.
   * @param {unknown} id session id.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {SessionRecord} the session.
   */
  get(id, owner = null) {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined
    const wanted = normalizeOwner(owner)
    if (session === undefined || sessionOwner(session) !== wanted) {
      throw coded('SESSION_NOT_FOUND', `session ${String(id)} does not exist`, 404)
    }
    return session
  }

  /**
   * Ownership of a session id, including sessions already closed in this process.
   * @param {unknown} id session id.
   * @returns {string | null} owner (null for the legacy bucket or unknown ids).
   */
  ownerOf(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    const live = this.sessions.get(id)
    if (live !== undefined) return sessionOwner(live)
    return this.owners.get(id) ?? null
  }

  /**
   * Keep the remembered-ownership map bounded (session ids are monotonic, so
   * dropping the oldest entries only affects very old closed sessions).
   * @returns {void}
   */
  trimOwners() {
    const limit = 4096
    if (this.owners.size <= limit) return
    for (const key of this.owners.keys()) {
      if (this.owners.size <= limit) break
      this.owners.delete(key)
    }
  }

  /**
   * Broadcast the session list.
   * @returns {void}
   */
  emitSessions() {
    this.emit({ type: 'sessions', sessions: this.list() })
  }

  /**
   * Broadcast one session's state (permission, lock, status).
   * @param {SessionRecord} session session.
   * @returns {void}
   */
  emitState(session) {
    const wire = this.info(session)
    this.emit({ type: 'state', sessionId: session.id, session: wire })
  }

  /**
   * Append an audit record to the session and global rings.
   * @param {SessionRecord} session session.
   * @param {{ source: 'human' | 'ai', action: 'read' | 'write' | 'deny' | 'lock', detail: string, byteLength?: number, code?: string }} record audit data.
   * @returns {void}
   */
  recordAudit(session, record) {
    /** @type {Record<string, unknown>} */
    const entry = {
      at: Date.now(),
      sessionId: session.id,
      title: session.title,
      source: record.source,
      action: record.action,
      detail: auditPreview(record.detail),
      byteLength: record.byteLength ?? 0,
    }
    // Only present when the denial carries a stable code: an undefined property
    // is not lossless JSON.
    if (typeof record.code === 'string' && record.code.length > 0) entry.code = record.code
    session.audit.push(entry)
    if (session.audit.length > AUDIT_PER_SESSION) session.audit.splice(0, session.audit.length - AUDIT_PER_SESSION)
    this.globalAudit.push(entry)
    if (this.globalAudit.length > AUDIT_GLOBAL) this.globalAudit.splice(0, this.globalAudit.length - AUDIT_GLOBAL)
    this.emit({ type: 'audit', sessionId: session.id, entry })
  }

  /**
   * Resolve connection options from either a saved profile or inline fields.
   * @param {Record<string, unknown>} input `sessions.create` params.
   * @param {'human' | 'ai'} actor caller.
   * @returns {Promise<{ transport: 'ssh' | 'telnet', host: string, port: number, username: string, auth: object, title: string, profileId: string | undefined }>} target.
   */
  async resolveTarget(input, actor) {
    const profileId = typeof input.profileId === 'string' && input.profileId.length > 0 ? input.profileId : undefined
    if (profileId !== undefined) return await this.resolveProfileTarget(profileId, input, actor)
    const transport = input.transport === 'telnet' ? 'telnet' : 'ssh'
    const host = typeof input.host === 'string' ? input.host.trim() : ''
    if (host.length === 0 || host.length > 253 || /[\s/\u0000-\u001f]/.test(host)) {
      throw coded('BAD_TARGET', 'a valid host is required', 400)
    }
    const port = boundInteger(input.port, transport === 'ssh' ? 22 : 23, 1, 65_535)
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    if (transport === 'ssh' && username.length === 0) throw coded('BAD_TARGET', 'a username is required for SSH', 400)
    let auth = { type: 'none' }
    if (transport === 'ssh') {
      const authType = input.authType === 'agent' || input.authType === 'privateKey' || input.authType === 'none' ? input.authType : 'password'
      if (authType === 'agent') auth = { type: 'agent' }
      else if (authType === 'privateKey') {
        if (actor === 'ai') throw coded('AI_SECRET_DENIED', 'the AI may not supply a private key; connect with a saved profile instead', 403)
        const privateKey = typeof input.privateKey === 'string' ? input.privateKey : ''
        if (privateKey.length === 0) throw coded('BAD_TARGET', 'a private key is required for this auth type', 400)
        const passphrase =
          typeof input.passphrase === 'string' && input.passphrase.length > 0 && input.passphrase.length <= 1024 ? input.passphrase : undefined
        auth = passphrase === undefined ? { type: 'privateKey', privateKey } : { type: 'privateKey', privateKey, passphrase }
      } else if (authType === 'password') {
        if (actor === 'ai') throw coded('AI_SECRET_DENIED', 'the AI may not receive or supply a password; connect with a saved profile instead', 403)
        const password = typeof input.password === 'string' ? input.password : ''
        if (password.length === 0) throw coded('BAD_TARGET', 'a password is required for this auth type', 400)
        auth = { type: 'password', password }
      }
    }
    const title =
      typeof input.title === 'string' && input.title.trim().length > 0
        ? input.title.trim().slice(0, 120)
        : transport === 'ssh'
          ? `${username}@${host}`
          : `${host}:${port}`
    return { transport, host, port, username, auth, title, profileId: undefined }
  }

  /**
   * Load a saved profile plus its stored secrets without deciding which auth
   * material to use: a connect form may legitimately supply a password for a
   * profile that has none saved, and that typed password must win.
   *
   * @param {string} profileId saved profile id.
   * @returns {Promise<{transport: 'ssh' | 'telnet', host: string, port: number, username: string, name: string, authType: string, secrets: {password?: string, privateKey?: string, passphrase?: string}}>} saved connection defaults.
   */
  async loadProfileTarget(profileId) {
    const profile = await this.profiles.get(profileId)
    if (profile === undefined) throw coded('PROFILE_NOT_FOUND', `profile ${profileId} does not exist`, 404)
    return {
      transport: profile.transport,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      name: profile.name,
      authType: profile.authType,
      secrets: await this.profiles.secretsFor(profileId),
    }
  }

  /**
   * Resolve connection options for a profile-backed connect.
   *
   * Precedence (both for addressing and for credentials): **what the caller
   * explicitly supplied wins, the saved profile fills the gaps.** The connect
   * form is prefilled from the profile, so an untouched field cannot drift;
   * but when the user edits the host/port/username, or types a password the
   * profile has not saved, the old code silently used the profile instead —
   * which surfaced as `this profile has no saved password` for a form the user
   * had just filled in. Secrets typed into the form are never persisted here.
   *
   * @param {string} profileId saved profile id.
   * @param {Record<string, unknown>} input `sessions.create` params.
   * @param {'human' | 'ai'} actor caller.
   * @returns {Promise<{ transport: 'ssh' | 'telnet', host: string, port: number, username: string, auth: object, title: string, profileId: string }>} target.
   */
  async resolveProfileTarget(profileId, input, actor) {
    const saved = await this.loadProfileTarget(profileId)

    const transport = input.transport === 'telnet' || input.transport === 'ssh' ? input.transport : saved.transport
    const rawHost = typeof input.host === 'string' ? input.host.trim() : ''
    const host = rawHost.length > 0 ? rawHost : saved.host
    if (host.length === 0 || host.length > 253 || /[\s/\u0000-\u001f]/.test(host)) {
      throw coded('BAD_TARGET', 'a valid host is required', 400)
    }
    const port = boundInteger(input.port === undefined ? saved.port : input.port, transport === 'ssh' ? 22 : 23, 1, 65_535)
    const rawUsername = typeof input.username === 'string' ? input.username.trim() : ''
    const username = rawUsername.length > 0 ? rawUsername : saved.username
    if (transport === 'ssh' && username.length === 0) throw coded('BAD_TARGET', 'a username is required for SSH', 400)

    // The AI never supplies secrets; it may only use what the profile has saved.
    const inlinePassword = actor === 'ai' || typeof input.password !== 'string' ? '' : input.password
    const inlinePrivateKey = actor === 'ai' || typeof input.privateKey !== 'string' ? '' : input.privateKey
    const inlinePassphrase =
      actor === 'ai' || typeof input.passphrase !== 'string' || input.passphrase.length === 0 || input.passphrase.length > 1024
        ? ''
        : input.passphrase

    /** @type {{type: string, password?: string, privateKey?: string, passphrase?: string}} */
    let auth = { type: 'none' }
    if (transport === 'ssh') {
      const requested = input.authType
      const authType =
        requested === 'agent' || requested === 'privateKey' || requested === 'none' || requested === 'password'
          ? requested
          : saved.authType
      if (authType === 'agent') {
        auth = { type: 'agent' }
      } else if (authType === 'privateKey') {
        const privateKey = inlinePrivateKey.length > 0 ? inlinePrivateKey : saved.secrets.privateKey || ''
        if (privateKey.length === 0) {
          if (actor === 'ai') {
            throw coded('AI_SECRET_DENIED', 'the AI may not supply a private key; connect with a saved profile that has one', 403)
          }
          throw coded(
            'MISSING_SECRET',
            `profile "${saved.name}" has no saved private key — paste one in the form, or save it in the profile`,
            400,
          )
        }
        const passphrase = inlinePassphrase.length > 0 ? inlinePassphrase : saved.secrets.passphrase
        auth = passphrase === undefined || passphrase.length === 0
          ? { type: 'privateKey', privateKey }
          : { type: 'privateKey', privateKey, passphrase }
      } else if (authType === 'password') {
        const password = inlinePassword.length > 0 ? inlinePassword : saved.secrets.password || ''
        if (password.length === 0) {
          if (actor === 'ai') {
            throw coded('AI_SECRET_DENIED', 'the AI may not receive or supply a password; connect with a saved profile that has one', 403)
          }
          throw coded(
            'MISSING_SECRET',
            `profile "${saved.name}" has no saved password — type one in the form, or save the password in the profile`,
            400,
          )
        }
        auth = { type: 'password', password }
      }
    }

    const title =
      typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim().slice(0, 120) : saved.name
    return { transport, host, port, username, auth, title, profileId }
  }

  /**
   * Count sessions that hold a connection or are still connecting, for one owner.
   * Failed and closed sessions kept for display do not count against `maxSessions`.
   * @param {unknown} [owner] owner (DSH session id; `null` = legacy bucket).
   * @returns {number} active sessions for that owner.
   */
  activeCount(owner = null) {
    const wanted = normalizeOwner(owner)
    let count = 0
    for (const session of this.sessions.values()) {
      if (sessionOwner(session) !== wanted) continue
      if (session.state === 'connecting' || session.state === 'open') count += 1
    }
    return count
  }

  /**
   * Drop the oldest failed sessions beyond a small display budget, per owner.
   * @param {number} [keep] failed sessions to retain for display.
   * @param {unknown} [owner] owner (DSH session id; `null` = legacy bucket).
   * @returns {void}
   */
  pruneFailed(keep = 8, owner = null) {
    const wanted = normalizeOwner(owner)
    const failed = [...this.sessions.values()].filter(
      (session) => session.state === 'failed' && sessionOwner(session) === wanted,
    )
    if (failed.length <= keep) return
    for (const session of failed.slice(0, failed.length - keep)) {
      this.finalize(session, { code: null, reason: 'replaced' })
    }
  }

  /**
   * Open a new session. Resolves with wire info; a connection failure resolves
   * with `state: 'failed'` and `error` set rather than throwing, so the panel can
   * show the reason in place.
   * @param {Record<string, unknown>} input creation params.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] owning DSH (AI) session id; absent/null = legacy bucket.
   * @returns {Promise<Record<string, unknown>>} session info.
   */
  async create(input, actor, owner) {
    if (this.disposed) throw coded('DISPOSED', 'the SSH/Telnet plugin is shutting down', 503)
    const sessionOwner = normalizeOwner(owner !== undefined ? owner : input.owner)
    this.pruneFailed(8, sessionOwner)
    if (this.activeCount(sessionOwner) >= this.config.maxSessions) {
      throw coded('TOO_MANY_SESSIONS', `at most ${this.config.maxSessions} sessions may be open`, 409)
    }
    const target = await this.resolveTarget(input, actor)
    const cols = boundInteger(input.cols, 100, 20, 500)
    const rows = boundInteger(input.rows, 30, 5, 300)
    const now = Date.now()
    const id = `st-${this.nextId++}`
    /** @type {SessionRecord} */
    const session = {
      id,
      title: target.title,
      transport: target.transport,
      host: target.host,
      port: target.port,
      username: target.username,
      profileId: target.profileId,
      owner: sessionOwner,
      state: 'connecting',
      error: undefined,
      cols,
      rows,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      bytesIn: 0,
      bytesOut: 0,
      permission: createPermission(this.config),
      screen: new Screen({ cols, rows, scrollback: this.config.scrollback }),
      ring: new ByteRing(this.config.replayBufferBytes),
      output: new OutputLog({
        // In-memory log: enough for delta reads and screen history, but bounded
        // so maxSessions sessions cannot pin the durable per-session cap times N.
        maxBytes: Math.max(this.config.replayBufferBytes, Math.min(this.config.historyMaxBytesPerSession, 1024 * 1024)),
        maxAgeMs: this.config.historyRetentionMs,
      }),
      cursors: new Map(),
      screens: new Map(),
      waiters: new Set(),
      lastOutputAt: now,
      connection: undefined,
      // Reconnect material: the resolved auth for THIS session, held in process
      // memory only. Never serialized, logged, returned or persisted.
      auth: target.auth,
      targetTransport: target.transport,
      generation: 0,
      disconnectedAt: undefined,
      closeReason: undefined,
      reconnecting: false,
      readyPromise: Promise.resolve(),
      lockTimer: undefined,
      audit: [],
      hostKeyFingerprint: undefined,
    }
    this.sessions.set(id, session)
    this.owners.set(id, sessionOwner)
    this.trimOwners()
    this.emitSessions()
    this.recordAudit(session, { source: actor === 'ai' ? 'ai' : 'human', action: 'lock', detail: 'connect' })
    if (this.historyStore !== undefined) {
      // Durable history is best effort: a disk failure must not block connecting.
      this.historyStore
        .openSession({
          id,
          title: session.title,
          transport: session.transport,
          host: session.host,
          port: session.port,
          username: session.username,
          createdAt: now,
        })
        .catch((error) => this.log('warn', `[aiterm] history open failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    // Remember the routing metadata so the first output chunk can write a header
    // block whenever automatic logging is (or later becomes) enabled.
    try {
      this.autolog.open(id, {
        transport: session.transport,
        host: session.host,
        port: session.port,
        username: session.username,
        title: session.title,
        startedAt: now,
      })
    } catch (error) {
      this.log('debug', `[aiterm] autolog open failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    session.readyPromise = this.openConnection(session)
    await session.readyPromise
    return this.info(session)
  }

  /**
   * Open (or re-open) the transport for one session record.
   *
   * Shared by create() and reconnect(): it never mutates the session id or its
   * history, only the connection, the screen and the state.
   * @param {SessionRecord} session session.
   * @returns {Promise<void>} resolves after success or a recorded failure.
   */
  async openConnection(session) {
    const connectFn = session.targetTransport === 'ssh' ? connectSsh : connectTelnet
    const options = {
      host: session.host,
      port: session.port,
      username: session.username,
      auth: session.auth,
      cols: session.cols,
      rows: session.rows,
      term: this.config.terminalType,
      connectTimeoutMs: this.config.connectTimeoutMs,
      readyTimeoutMs: this.config.connectTimeoutMs,
      keepaliveMs: this.config.keepaliveMs,
      hostKeyPolicy: this.config.knownHostsPolicy,
      knownHostsPath: `${this.dataDir}/known_hosts`,
    }
    const run = (async () => {
      try {
        const connection = await connectFn(options, {
          onData: (chunk) => this.handleData(session, chunk),
          onReady: (readyInfo) => {
            session.hostKeyFingerprint = readyInfo?.hostKeyFingerprint
          },
          onClose: (closeInfo) => this.handleClose(session, closeInfo),
          onError: (error) => {
            session.error = error instanceof Error ? error.message : String(error)
          },
        })
        session.connection = connection
        const ready = await connection.ready
        session.hostKeyFingerprint = session.hostKeyFingerprint ?? ready?.hostKeyFingerprint
        if (session.state === 'connecting' || session.state === 'disconnected') {
          session.state = 'open'
          session.generation += 1
          session.reconnecting = false
          session.closeReason = undefined
          session.disconnectedAt = undefined
          session.error = undefined
          session.updatedAt = Date.now()
          this.emitState(session)
          this.emitSessions()
        }
        // A telnet server may print a login banner before it is ready.
        if (typeof ready?.banner === 'string' && ready.banner.length > 0) this.handleData(session, ready.banner)
      } catch (error) {
        if (session.state === 'connecting' || session.state === 'disconnected') {
          session.state = 'failed'
          // A failed attempt must clear the in-flight flag, otherwise the session
          // can never be retried (every retry would read as "already connecting").
          session.reconnecting = false
          session.error = error instanceof Error ? error.message : String(error)
          session.updatedAt = Date.now()
          session.permission.lockOwner = null
          session.permission.lockExpiresAt = null
          derive(session.permission, this.config)
          this.emitState(session)
          this.emitSessions()
          try {
            session.screen.dispose()
          } catch {
            // screen disposal is best effort
          }
        }
      }
    })()
    await run
    if (session.state === 'open') session.reconnecting = false
  }

  /**
   * Feed remote output into the ring, the screen and SSE subscribers.
   * @param {SessionRecord} session session.
   * @param {string} chunk decoded output text.
   * @returns {void}
   */
  handleData(session, chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return
    const bytes = Buffer.from(chunk, 'utf8')
    session.bytesIn += bytes.length
    session.lastActivityAt = Date.now()
    session.lastOutputAt = session.lastActivityAt
    session.updatedAt = session.lastActivityAt
    session.ring.push(bytes)
    try {
      session.output.append(chunk, session.lastActivityAt)
      session.output.prune(session.lastActivityAt)
    } catch (error) {
      this.log('debug', `[aiterm] output log failed on ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (this.historyStore !== undefined) {
      try {
        this.historyStore.appendChunk(session.id, chunk, session.lastActivityAt)
      } catch (error) {
        this.log('debug', `[aiterm] history append failed on ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Automatic log file (opt-in, disabled by default): fire-and-forget, queued
    // and bounded, so a disk problem can never reach the terminal stream.
    try {
      this.autolog.append(session.id, chunk)
    } catch (error) {
      this.log('debug', `[aiterm] autolog append failed on ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      session.screen.write(chunk)
    } catch (error) {
      this.log('debug', `[aiterm] screen write failed on ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Wake anyone waiting on new output (idle timers reset, patterns re-check).
    for (const waiter of [...session.waiters]) {
      try {
        waiter.feed()
      } catch {
        // a broken waiter must not break the stream
      }
    }
    this.emit({ type: 'data', sessionId: session.id, chunk: toBase64(bytes) })
  }

  /**
   * Handle the remote side closing (or a connect attempt dying).
   *
   * A connection that never reached `open` becomes `failed` and stays in the
   * list so the panel can show the reason and offer a retry; a session that had
   * been open is emitted as an `exit` and removed.
   * @param {SessionRecord} session session.
   * @param {{ code?: number | null, signal?: string, reason?: string }} [closeInfo] close details.
   * @returns {void}
   */
  handleClose(session, closeInfo = {}) {
    if (session.state === 'closed' || session.state === 'failed') return
    this.lockTimerClear(session)
    // Whether the peer closed a live session or a connect attempt died, there is
    // no attempt in flight any more.
    session.reconnecting = false
    if (session.state === 'connecting') {
      session.state = 'failed'
      session.error = session.error ?? closeInfo.reason ?? 'connection closed before it was ready'
      session.updatedAt = Date.now()
      session.permission.lockOwner = null
      session.permission.lockExpiresAt = null
      derive(session.permission, this.config)
      this.emitState(session)
      this.emitSessions()
      try {
        session.screen.dispose()
      } catch {
        // screen disposal is best effort
      }
      this.log('warn', `[aiterm] session ${session.id} failed to connect: ${session.error}`)
      return
    }
    // An unexpectedly closed session becomes recoverable instead of vanishing:
    // the same id, history and permission survive, and one reconnect brings it
    // back. Only an explicit close() removes a session.
    // A transport close caused by our own disconnect()/close() must not look like
    // a network drop, otherwise autoReconnect would dial straight back out.
    const unexpected = session.intentionalDisconnect !== true
    this.markDisconnected(session, closeInfo.reason ?? 'connection closed', { unexpected })
  }

  /**
   * Move a session to the recoverable `disconnected` state.
   * @param {SessionRecord} session session.
   * @param {string} reason why it disconnected.
   * @returns {void}
   */
  markDisconnected(session, reason, options = {}) {
    if (session.state === 'closed') return
    this.lockTimerClear(session)
    const now = Date.now()
    session.state = 'disconnected'
    session.reconnecting = false
    session.connection = undefined
    session.closeReason = reason
    session.disconnectedAt = now
    session.updatedAt = now
    session.error = undefined
    session.permission.lockOwner = null
    session.permission.lockExpiresAt = null
    derive(session.permission, this.config)
    for (const waiter of [...session.waiters]) {
      try {
        waiter.close()
      } catch {
        // a broken waiter must not block teardown
      }
    }
    session.waiters.clear()
    session.intentionalDisconnect = false
    this.closeAutoLog(session.id)
    this.emitState(session)
    this.emitSessions()
    this.pruneDetached(sessionOwner(session))
    this.log('info', `[aiterm] session ${session.id} disconnected: ${reason}`)
    // Opt-in auto-reconnect only for UNEXPECTED drops: a user pressing
    // 中断 must not have the plugin dial straight back out.
    if (options.unexpected === true && this.config.autoReconnect === true) {
      this.scheduleAutoReconnect(session)
    }
  }

  /**
   * Retry an unexpectedly dropped session in the background (opt-in).
   *
   * Exponential backoff from `autoReconnectDelayMs` up to 30s, at most
   * `autoReconnectAttempts` times. Any retry that fails reschedules; a
   * successful one clears the timer. A user disconnect or close cancels it.
   * @param {SessionRecord} session session.
   * @returns {void}
   */
  scheduleAutoReconnect(session) {
    if (this.disposed) return
    session.autoReconnectAttempt = (session.autoReconnectAttempt ?? 0) + 1
    const attempt = session.autoReconnectAttempt
    if (attempt > this.config.autoReconnectAttempts) {
      session.autoReconnectAttempt = 0
      this.log('warn', `[aiterm] giving up auto-reconnect for ${session.id} after ${this.config.autoReconnectAttempts} attempts`)
      return
    }
    const delay = Math.min(30_000, this.config.autoReconnectDelayMs * 2 ** (attempt - 1))
    session.autoReconnectTimer = setTimeout(() => {
      session.autoReconnectTimer = undefined
      if (this.disposed || !this.sessions.has(session.id) || session.state !== 'disconnected') return
      // reconnect() sets the in-flight flag itself; pre-setting it would make the
      // call reject with ALREADY_CONNECTING.
      this.reconnect(session.id, {}, 'human', sessionOwner(session))
        .then((info) => {
          if (info.state === 'open') {
            session.autoReconnectAttempt = 0
            this.log('info', `[aiterm] auto-reconnected ${session.id} on attempt ${attempt}`)
          } else {
            session.reconnecting = false
            this.scheduleAutoReconnect(session)
          }
        })
        .catch((error) => {
          session.reconnecting = false
          this.log('warn', `[aiterm] auto-reconnect attempt ${attempt} for ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (session.state === 'disconnected') this.scheduleAutoReconnect(session)
        })
    }, delay)
    if (typeof session.autoReconnectTimer?.unref === 'function') session.autoReconnectTimer.unref()
  }

  /**
   * Cancel a pending auto-reconnect (user disconnect / close).
   * @param {SessionRecord} session session.
   * @returns {void}
   */
  cancelAutoReconnect(session) {
    if (session.autoReconnectTimer !== undefined) {
      clearTimeout(session.autoReconnectTimer)
      session.autoReconnectTimer = undefined
    }
    session.autoReconnectAttempt = 0
  }

  /**
   * Keep the number of retained disconnected sessions bounded, per owner.
   * @param {unknown} [owner] owner (DSH session id; `null` = legacy bucket).
   * @returns {void}
   */
  pruneDetached(owner = null) {
    const wanted = normalizeOwner(owner)
    const limit = this.config.maxDetachedSessions
    const detached = [...this.sessions.values()]
      .filter((session) => session.state === 'disconnected' && sessionOwner(session) === wanted)
      .sort((left, right) => (left.disconnectedAt ?? 0) - (right.disconnectedAt ?? 0))
    if (detached.length <= limit) return
    for (const session of detached.slice(0, detached.length - limit)) {
      this.finalize(session, { reason: 'detached session limit reached' })
    }
  }

  /**
   * Terminate a session: emit `exit`, dispose the screen, drop it from the list.
   * @param {SessionRecord} session session.
   * @param {{ code?: number | null, reason?: string }} [closeInfo] close details.
   * @returns {void}
   */
  finalize(session, closeInfo = {}) {
    if (session.state === 'closed') return
    this.cancelAutoReconnect(session)
    this.lockTimerClear(session)
    session.state = 'closed'
    session.updatedAt = Date.now()
    this.emit({ type: 'exit', sessionId: session.id, code: closeInfo.code ?? null, reason: closeInfo.reason ?? 'connection closed' })
    for (const waiter of [...session.waiters]) {
      try {
        waiter.close()
      } catch {
        // a broken waiter must not block teardown
      }
    }
    session.waiters.clear()
    this.closeAutoLog(session.id)
    if (this.historyStore !== undefined) {
      this.historyStore
        .closeSession(session.id, { closedAt: session.updatedAt })
        .catch((error) => this.log('warn', `[aiterm] history close failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    try {
      session.screen.dispose()
    } catch {
      // screen disposal is best effort
    }
    try {
      session.output.dispose()
    } catch {
      // log disposal is best effort
    }
    this.sessions.delete(session.id)
    this.emitSessions()
    this.log('info', `[aiterm] session ${session.id} closed`)
  }

  /**
   * Clear the AI-lock expiry timer.
   * @param {SessionRecord} session session.
   * @returns {boolean} whether a timer existed.
   */
  lockTimerClear(session) {
    if (session.lockTimer === undefined) return false
    clearTimeout(session.lockTimer)
    session.lockTimer = undefined
    return true
  }

  /**
   * (Re)arm the AI-lock auto-release timer.
   * @param {SessionRecord} session session.
   * @returns {void}
   */
  armLockTimer(session) {
    this.lockTimerClear(session)
    if (session.permission.lockOwner !== 'ai' || session.permission.lockExpiresAt === null) return
    const delay = Math.max(0, session.permission.lockExpiresAt - Date.now())
    session.lockTimer = setTimeout(() => {
      session.lockTimer = undefined
      if (expireIfIdle(session.permission, Date.now(), this.config)) {
        this.emitState(session)
        this.recordAudit(session, { source: 'human', action: 'lock', detail: 'AI lock expired after idle timeout' })
      }
    }, delay)
    if (typeof session.lockTimer?.unref === 'function') session.lockTimer.unref()
  }

  /**
   * Send input to a session, enforcing the permission model for the caller.
   * @param {string} id session id.
   * @param {string} data input text.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Promise<Record<string, unknown>>} `{ permission }` after the write.
   */
  async write(id, data, actor, owner = null) {
    const session = this.get(id, owner)
    const text = typeof data === 'string' ? data : ''
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw coded('INPUT_TOO_LARGE', 'input exceeds 64 KiB', 413)
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkWrite(session.permission, actor, this.config)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: text, code: verdict.code, byteLength: Buffer.byteLength(text) })
      throw coded(verdict.code ?? 'WRITE_DENIED', verdict.message ?? 'write denied', actor === 'ai' ? 403 : 423)
    }
    if (session.state !== 'open' || session.connection === undefined) {
      throw coded('NOT_CONNECTED', `session is ${session.state}; cannot send input`, 409)
    }
    try {
      session.connection.write(text)
    } catch (error) {
      throw coded('WRITE_FAILED', error instanceof Error ? error.message : String(error), 500)
    }
    session.bytesOut += Buffer.byteLength(text, 'utf8')
    session.lastActivityAt = Date.now()
    session.updatedAt = session.lastActivityAt
    if (actor === 'ai') {
      if (noteAiWrite(session.permission, this.config, session.lastActivityAt)) {
        this.emitState(session)
        this.armLockTimer(session)
      }
    }
    this.recordAudit(session, { source: actor, action: 'write', detail: text, byteLength: Buffer.byteLength(text) })
    return { permission: permissionSnapshot(session.permission) }
  }

  /**
   * Parse a cursor (opaque decimal byte offset) into a number.
   * @param {unknown} value cursor from a tool/UI call.
   * @returns {number | undefined} offset when valid.
   */
  static parseCursor(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
    if (typeof value === 'string' && /^\d{1,18}$/.test(value)) return Number(value)
    return undefined
  }

  /**
   * @param {SessionRecord} session session.
   * @returns {boolean} whether the visible screen ends in a shell prompt.
   */
  screenPrompt(session) {
    try {
      const snapshot = session.screen.snapshot()
      const lines = Array.isArray(snapshot.lines) ? snapshot.lines : []
      let lastIndex = -1
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (typeof lines[index] === 'string' && lines[index].trim().length > 0) {
          lastIndex = index
          break
        }
      }
      if (lastIndex === -1) return false
      // A shell prompt is printed without a trailing newline, so the cursor rests
      // on that very row; finished command output leaves the cursor on a later
      // (usually empty) row. Requiring both signals keeps ordinary output such as
      // "see /usr/local/bin$" from being reported as a prompt.
      const cursorY = snapshot.cursor?.y
      if (typeof cursorY === 'number' && cursorY !== lastIndex) return false
      return detectPrompt([lines[lastIndex]], this.promptRegExp)
    } catch {
      return false
    }
  }

  /**
   * @param {string} id session id.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {boolean} whether the visible screen ends in a shell prompt.
   */
  atPrompt(id, owner = null) {
    return this.screenPrompt(this.get(id, owner))
  }

  /**
   * @param {SessionRecord} session session.
   * @param {number} from byte offset.
   * @param {number} [maxBytes] bound.
   * @returns {string} output text from `from` to the end (bounded).
   */
  deltaText(session, from, maxBytes = this.config.aiReadMaxBytes) {
    try {
      return session.output.slice(from, maxBytes).text
    } catch {
      return ''
    }
  }

  /**
   * Incremental read: only output after the reader's cursor.
   * @param {string} id session id.
   * @param {{ actor?: 'human' | 'ai', reader?: string, cursor?: unknown, maxBytes?: unknown, owner?: unknown }} [options] read options.
   * @returns {Record<string, unknown>} `{ text, cursor, newBytes, atPrompt, truncated }`.
   */
  readDelta(id, options = {}) {
    const session = this.get(id, options.owner)
    const actor = options.actor ?? 'ai'
    const reader = typeof options.reader === 'string' && options.reader.length > 0 ? options.reader.slice(0, 32) : actor
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkRead(session.permission, actor)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: 'read:delta', code: verdict.code })
      throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
    }
    const limit = boundInteger(options.maxBytes, this.config.deltaDefaultMaxBytes, 256, this.config.aiReadMaxBytes)
    const window = session.output.window
    const stored = session.cursors.get(reader)
    let from = SessionRegistry.parseCursor(options.cursor) ?? (typeof stored === 'number' ? stored : window.firstOffset)
    if (!Number.isFinite(from)) from = 0
    let truncated = false
    if (session.output.totalOffset === 0) from = 0
    else if (from < window.firstOffset) {
      from = window.firstOffset
      truncated = true
    }
    const slice = session.output.slice(from, limit)
    const next = Number.isFinite(slice.to) ? slice.to : from
    session.cursors.set(reader, next)
    const text = slice.text
    const atPrompt = this.screenPrompt(session)
    this.recordAudit(session, { source: actor, action: 'read', detail: 'read:delta', byteLength: Buffer.byteLength(text, 'utf8') })
    return {
      text,
      cursor: String(next),
      newBytes: Math.max(0, next - from),
      atPrompt,
      truncated: truncated || slice.truncated === true,
      lineCount: text.length === 0 ? 0 : text.split('\n').length,
      session: this.info(session),
    }
  }

  /**
   * Visible-screen read, optionally only the rows that changed since this
   * reader's previous screen read.
   * @param {string} id session id.
   * @param {{ actor?: 'human' | 'ai', reader?: string, changedOnly?: boolean, maxLines?: unknown, owner?: unknown }} [options] read options.
   * @returns {Record<string, unknown>} `{ text, changedLines, unchanged, cursor, atPrompt, lineCount }`.
   */
  readScreen(id, options = {}) {
    const session = this.get(id, options.owner)
    const actor = options.actor ?? 'ai'
    const reader = typeof options.reader === 'string' && options.reader.length > 0 ? options.reader.slice(0, 32) : actor
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkRead(session.permission, actor)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: 'read:screen', code: verdict.code })
      throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
    }
    let lines = []
    try {
      const text = session.screen.text()
      lines = text.length === 0 ? [] : text.split('\n')
    } catch {
      lines = []
    }
    const maxLines = typeof options.maxLines === 'number' ? boundInteger(options.maxLines, 40, 1, 2000) : undefined
    const visible = maxLines !== undefined && lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
    const atPrompt = this.screenPrompt(session)
    const cursor = String(session.output.totalOffset)
    if (options.changedOnly !== true) {
      session.screens.set(reader, visible)
      const text = visible.join('\n')
      this.recordAudit(session, { source: actor, action: 'read', detail: 'read:screen', byteLength: Buffer.byteLength(text, 'utf8') })
      return { text, changedLines: visible.map((_, index) => index + 1), unchanged: false, cursor, atPrompt, lineCount: visible.length, session: this.info(session) }
    }
    const previous = session.screens.get(reader)
    const diff = diffScreen(previous ?? [], visible)
    session.screens.set(reader, visible)
    // Rows that did not exist in the previous snapshot are changes too: a first
    // changedOnly read must not look empty.
    const rows = [...new Set([...diff.changed, ...diff.added])].sort((left, right) => left - right)
    const changedText = rows.map((row) => `L${row + 1}: ${visible[row] ?? ''}`).join('\n')
    this.recordAudit(session, {
      source: actor,
      action: 'read',
      detail: `read:screen(changed=${diff.changed.length})`,
      byteLength: Buffer.byteLength(changedText, 'utf8'),
    })
    return {
      text: changedText,
      changedLines: rows.map((row) => row + 1),
      unchanged: rows.length === 0,
      cursor,
      atPrompt,
      lineCount: visible.length,
      session: this.info(session),
    }
  }

  /**
   * Wait for new output, an idle pause, a pattern or the session ending — so the
   * model does not have to poll the screen.
   * @param {string} id session id.
   * @param {{ until?: 'idle' | 'pattern' | 'exit', pattern?: string, idleMs?: unknown, timeoutMs?: unknown, actor?: 'human' | 'ai', cursor?: unknown, includeOutput?: boolean, owner?: unknown }} [options] wait options.
   * @returns {Promise<Record<string, unknown>>} wait outcome.
   */
  waitFor(id, options = {}) {
    const session = this.get(id, options.owner)
    const actor = options.actor ?? 'ai'
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkRead(session.permission, actor)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: 'wait', code: verdict.code })
      throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
    }
    const until = options.until === 'pattern' || options.until === 'exit' ? options.until : 'idle'
    let pattern
    if (until === 'pattern') {
      if (typeof options.pattern !== 'string' || options.pattern.length === 0) {
        throw coded('BAD_PATTERN', 'a non-empty pattern is required when until is "pattern"', 400)
      }
      try {
        pattern = new RegExp(options.pattern)
      } catch (error) {
        throw coded('BAD_PATTERN', `invalid pattern: ${error instanceof Error ? error.message : String(error)}`, 400)
      }
    }
    const idleMs = boundInteger(options.idleMs, 500, 50, 600_000)
    const timeoutMs = boundInteger(options.timeoutMs, 30_000, 100, 3_600_000)
    const includeOutput = options.includeOutput !== false
    const window = session.output.window
    const stored = session.cursors.get(actor)
    // A wait must also see output that arrived between the caller's send and
    // this call, otherwise "send then wait for its echo" races the stream and
    // times out. Start from the reader's own last-read position; a reader that
    // has never read starts from a bounded lookback instead of the very end.
    const lookbackFloor = Math.max(window.firstOffset, (session.output.totalOffset ?? 0) - this.config.aiReadMaxBytes)
    const startOffset =
      SessionRegistry.parseCursor(options.cursor) ?? (typeof stored === 'number' ? Math.max(stored, window.firstOffset) : lookbackFloor)
    const from = Math.max(startOffset, window.firstOffset)

    return new Promise((resolve) => {
      let settled = false
      /** @type {any} */
      let idleTimer
      const timeoutTimer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
      if (typeof timeoutTimer?.unref === 'function') timeoutTimer.unref()

      /**
       * @param {boolean} matched whether the condition was met.
       * @param {string} reason machine-readable reason.
       * @returns {void}
       */
      const finish = (matched, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        session.waiters.delete(waiter)
        const text = includeOutput ? this.deltaText(session, from) : ''
        // Only a satisfied wait consumes the reader's position. On a timeout the
        // output stays available to a delta read instead of silently vanishing.
        if (matched) session.cursors.set(actor, session.output.totalOffset)
        this.recordAudit(session, {
          source: actor,
          action: 'read',
          detail: `wait:${reason}`,
          byteLength: Buffer.byteLength(text, 'utf8'),
        })
        resolve({
          matched,
          reason,
          text,
          cursor: String(session.output.totalOffset),
          atPrompt: this.screenPrompt(session),
          session: this.info(session),
        })
      }

      /** Reset the idle timer (only for `until: 'idle'`). */
      const armIdle = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => finish(true, 'idle'), idleMs)
        if (typeof idleTimer?.unref === 'function') idleTimer.unref()
      }

      /** @type {any} */
      const waiter = {
        feed: () => {
          if (settled) return
          if (until === 'pattern' && pattern !== undefined) {
            let text = ''
            try {
              text = session.output.slice(from, this.config.aiReadMaxBytes).text
            } catch {
              text = ''
            }
            if (pattern.test(text)) finish(true, 'pattern')
            return
          }
          if (until === 'idle') armIdle()
        },
        close: () => finish(true, 'exit'),
      }
      session.waiters.add(waiter)

      if (until === 'idle') armIdle()
      if (until === 'pattern' && pattern !== undefined) {
        const existing = this.deltaText(session, from)
        if (pattern.test(existing)) finish(true, 'pattern')
      }
      if (until === 'exit' && session.state !== 'open') finish(true, 'exit')
    })
  }

  /**
   * Query output history for one session (live sessions use the memory log,
   * closed sessions are read from the durable journal), or list sessions.
   * @param {{ actor?: 'human' | 'ai', sessionId?: string, owner?: unknown, since?: unknown, until?: unknown, search?: string, context?: unknown, maxMatches?: unknown, maxBytes?: unknown, limit?: unknown }} [query] query.
   * @returns {Promise<Record<string, unknown>>} query result.
   */
  async historyQuery(query = {}) {
    const sessionId = typeof query.sessionId === 'string' && query.sessionId.length > 0 ? query.sessionId : undefined
    const actor = query.actor === 'human' ? 'human' : 'ai'
    const wanted = normalizeOwner(query.owner)
    const since = parseTimestamp(query.since)
    const until = parseTimestamp(query.until)
    const maxBytes = boundInteger(query.maxBytes, this.config.aiReadMaxBytes, 256, 16 * 1024 * 1024)
    const maxMatches = boundInteger(query.maxMatches, 20, 1, 500)
    const limit = boundInteger(query.limit, 20, 1, 200)
    if (sessionId === undefined) {
      return { sessions: await this.historySessions({ limit, since, until, owner: wanted }), truncated: false, scannedBytes: 0 }
    }
    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      // A session owned by another DSH session is indistinguishable from a
      // missing one: history must not leak across AI sessions either.
      if (sessionOwner(session) !== wanted) throw coded('SESSION_NOT_FOUND', `session ${sessionId} does not exist`, 404)
      // Reading history is still reading: the session's AI permission applies.
      const verdict = checkRead(session.permission, actor)
      if (!verdict.allowed) {
        this.recordAudit(session, { source: actor, action: 'deny', detail: 'history', code: verdict.code })
        throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
      }
      const window = session.output.window
      const from = Math.max(since === undefined ? window.firstOffset : session.output.offsetAt(since), window.firstOffset)
      if (typeof query.search === 'string' && query.search.length > 0) {
        let pattern
        try {
          pattern = new RegExp(query.search, 'i')
        } catch {
          pattern = new RegExp(escapeRegExp(query.search), 'i')
        }
        const found = session.output.search({
          pattern,
          since,
          until,
          context: boundInteger(query.context, 0, 0, 5),
          maxMatches,
          maxBytes,
        })
        this.recordAudit(session, { source: actor, action: 'read', detail: `history:search`, byteLength: 0 })
        return { ...found, complete: true }
      }
      const slice = session.output.slice(from, maxBytes)
      const text = slice.text
      return {
        text,
        truncated: slice.truncated === true,
        scannedBytes: Math.max(0, slice.to - slice.from),
        since: since ?? window.firstAt,
        entry: this.catalogEntry(session),
        complete: true,
      }
    }
    // A session that is no longer live: its ownership is only known if this Host
    // process created it; pre-restart journals are treated as the legacy bucket.
    if (this.ownerOf(sessionId) !== wanted) throw coded('SESSION_NOT_FOUND', `session ${sessionId} does not exist`, 404)
    if (this.historyStore === undefined) {
      throw coded('SESSION_NOT_FOUND', `session ${sessionId} is not live and durable history is unavailable`, 404)
    }
    const result = await this.historyStore.query({
      sessionId,
      since,
      until,
      search: typeof query.search === 'string' && query.search.length > 0 ? query.search : undefined,
      context: boundInteger(query.context, 0, 0, 5),
      maxMatches,
      maxBytes,
    })
    if (result.entry === undefined && result.matches.length === 0 && result.scannedBytes === 0) {
      throw coded('SESSION_NOT_FOUND', `no history is stored for session ${sessionId}`, 404)
    }
    return result
  }

  /**
   * @param {{ limit?: unknown, since?: unknown, until?: unknown, owner?: unknown }} [options] list options.
   * @returns {Promise<Array<Record<string, unknown>>>} live sessions first, then past ones.
   */
  async historySessions(options = {}) {
    const limit = boundInteger(options.limit, 20, 1, 200)
    const wanted = normalizeOwner(options.owner)
    const since = parseTimestamp(options.since)
    const until = parseTimestamp(options.until)
    /** @type {Array<Record<string, unknown>>} */
    const live = [...this.sessions.values()]
      .filter((session) => sessionOwner(session) === wanted)
      .map((session) => this.catalogEntry(session))
    let past = []
    if (this.historyStore !== undefined) {
      try {
        past = (await this.historyStore.listSessions({ limit: limit * 2, since, until })).filter(
          (entry) => this.ownerOf(entry.id) === wanted,
        )
      } catch {
        past = []
      }
    }
    const liveIds = new Set(live.map((entry) => entry.id))
    const combined = [...live, ...past.filter((entry) => !liveIds.has(entry.id))]
    return combined.slice(0, limit)
  }

  /**
   * @param {SessionRecord} session session.
   * @returns {Record<string, unknown>} catalog-shaped summary.
   */
  catalogEntry(session) {
    return {
      id: session.id,
      title: session.title,
      transport: session.transport,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: session.createdAt,
      closedAt: session.state === 'closed' ? session.updatedAt : undefined,
      bytes: session.bytesIn,
      lastTs: session.lastOutputAt,
      live: session.state === 'open' || session.state === 'connecting',
    }
  }

  /**
   * Read output for the model, enforcing read permission.
   * @param {string} id session id.
   * @param {{ actor?: 'human' | 'ai', mode?: 'delta' | 'screen' | 'tail' | 'history', bytes?: number, lines?: number, cursor?: unknown, maxBytes?: unknown, maxLines?: unknown, changedOnly?: boolean, reader?: string }} [options] read options.
   * @returns {Record<string, unknown>} `{ text, mode, truncated, session, ... }`.
   */
  read(id, options = {}) {
    const mode = options.mode === 'screen' || options.mode === 'tail' || options.mode === 'history' ? options.mode : 'delta'
    if (mode === 'delta') {
      const result = this.readDelta(id, {
        actor: options.actor,
        reader: options.reader,
        cursor: options.cursor,
        maxBytes: options.maxBytes ?? options.bytes,
        owner: options.owner,
      })
      return { ...result, mode: 'delta' }
    }
    if (mode === 'screen') {
      const result = this.readScreen(id, {
        actor: options.actor,
        reader: options.reader,
        changedOnly: options.changedOnly,
        maxLines: options.maxLines ?? options.lines,
        owner: options.owner,
      })
      return { ...result, mode: 'screen', truncated: result.truncated === true }
    }
    const session = this.get(id, options.owner)
    const actor = options.actor ?? 'ai'
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkRead(session.permission, actor)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: `read:${mode}`, code: verdict.code })
      throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
    }
    const limit = boundInteger(options.maxBytes ?? options.bytes, this.config.aiReadMaxBytes, 256, 16 * 1024 * 1024)
    let text
    let truncated = false
    if (mode === 'tail') {
      const raw = session.ring.toBuffer()
      if (raw.length > limit) {
        text = raw.subarray(raw.length - limit).toString('utf8')
        truncated = true
      } else {
        text = raw.toString('utf8')
      }
    } else {
      text = session.screen.historyText(boundInteger(options.lines, 200, 1, 5000))
    }
    const atPrompt = this.screenPrompt(session)
    this.recordAudit(session, { source: actor, action: 'read', detail: `read:${mode}`, byteLength: Buffer.byteLength(text, 'utf8') })
    return {
      text,
      mode,
      truncated,
      cursor: String(session.output.totalOffset),
      newBytes: Buffer.byteLength(text, 'utf8'),
      atPrompt,
      changedLines: [],
      unchanged: false,
      lineCount: text.length === 0 ? 0 : text.split('\n').length,
      session: this.info(session),
    }
  }

  /**
   * Read the visible screen with cursor info (AI screenshot).
   * @param {string} id session id.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} screenshot payload.
   */
  screenshot(id, actor, owner = null) {
    const session = this.get(id, owner)
    if (expireIfIdle(session.permission, Date.now(), this.config)) this.emitState(session)
    const verdict = checkRead(session.permission, actor)
    if (!verdict.allowed) {
      this.recordAudit(session, { source: actor, action: 'deny', detail: 'screenshot', code: verdict.code })
      throw coded(verdict.code ?? 'READ_DENIED', verdict.message ?? 'read denied', 403)
    }
    const snapshot = session.screen.snapshot()
    this.recordAudit(session, { source: actor, action: 'read', detail: 'screenshot', byteLength: snapshot.lines.join('\n').length })
    return {
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursor: snapshot.cursor,
      alt: snapshot.alt,
      screen: snapshot.lines.join('\n'),
      text: session.screen.text(),
      session: this.info(session),
    }
  }

  /**
   * Resize the remote terminal.
   * @param {string} id session id.
   * @param {number} cols columns.
   * @param {number} rows rows.
   * @param {'human' | 'ai'} [actor] caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {{ ok: true }} acknowledgement.
   */
  resize(id, cols, rows, actor = 'human', owner = null) {
    const session = this.get(id, owner)
    const nextCols = boundInteger(cols, session.cols, 20, 500)
    const nextRows = boundInteger(rows, session.rows, 5, 300)
    if (nextCols === session.cols && nextRows === session.rows) return { ok: true }
    session.cols = nextCols
    session.rows = nextRows
    session.updatedAt = Date.now()
    try {
      session.screen.resize(nextCols, nextRows)
      session.connection?.resize?.(nextCols, nextRows)
    } catch (error) {
      this.log('debug', `[aiterm] resize failed on ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.emitState(session)
    this.recordAudit(session, { source: actor, action: 'lock', detail: `resize ${nextCols}x${nextRows}` })
    return { ok: true }
  }

  /**
   * The human changes the AI's access mode. User-only action.
   * @param {string} id session id.
   * @param {'ro' | 'wo' | 'rw'} aiAccess requested mode.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} `{ permission }`.
   */
  setAiAccess(id, aiAccess, actor, owner = null) {
    if (actor !== 'human') throw coded('HUMAN_ONLY', 'only the human can change AI permission', 403)
    if (aiAccess !== 'ro' && aiAccess !== 'wo' && aiAccess !== 'rw') throw coded('BAD_ACCESS', 'aiAccess must be ro, wo or rw', 400)
    const session = this.get(id, owner)
    if (setAiAccess(session.permission, aiAccess, this.config)) {
      this.emitState(session)
      this.recordAudit(session, { source: 'human', action: 'lock', detail: `AI access set to ${aiAccess}` })
    }
    return { permission: permissionSnapshot(session.permission) }
  }

  /**
   * The human takes over control (AI writes are refused until released).
   * @param {string} id session id.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} `{ permission }`.
   */
  takeOver(id, actor, owner = null) {
    if (actor !== 'human') throw coded('HUMAN_ONLY', 'only the human can take over control', 403)
    const session = this.get(id, owner)
    if (!this.config.humanCanPreempt) throw coded('PREEMPT_DISABLED', 'human takeover is disabled by configuration', 403)
    this.lockTimerClear(session)
    if (takeOver(session.permission, this.config)) {
      this.emitState(session)
      this.recordAudit(session, { source: 'human', action: 'lock', detail: 'human took over control' })
    }
    return { permission: permissionSnapshot(session.permission) }
  }

  /**
   * Release the control token, returning the session to shared use.
   * @param {string} id session id.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} `{ permission }`.
   */
  release(id, actor, owner = null) {
    if (actor !== 'human') throw coded('HUMAN_ONLY', 'only the human can release control', 403)
    const session = this.get(id, owner)
    this.lockTimerClear(session)
    if (releaseLock(session.permission, this.config)) {
      this.emitState(session)
      this.recordAudit(session, { source: 'human', action: 'lock', detail: 'control released' })
    }
    return { permission: permissionSnapshot(session.permission) }
  }

  /**
   * Give up the control token from the AI side.
   *
   * This only ever loosens the AI's own hold: the AI can hand control back to
   * the human, but it can never release a human takeover (that would widen the
   * AI's own authority). Granting control stays a human action.
   * @param {string} id session id.
   * @param {'human' | 'ai'} actor caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} `{ permission, released }`.
   */
  relinquish(id, actor, owner = null) {
    const session = this.get(id, owner)
    if (session.permission.lockOwner !== 'ai') {
      return { permission: permissionSnapshot(session.permission), released: false }
    }
    this.lockTimerClear(session)
    const changed = releaseLock(session.permission, this.config)
    if (changed) {
      this.emitState(session)
      this.recordAudit(session, { source: actor, action: 'lock', detail: 'control released by the AI' })
    }
    return { permission: permissionSnapshot(session.permission), released: changed }
  }

  /**
   * Rename a session (display only).
   * @param {string} id session id.
   * @param {string} title new title.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} session info.
   */
  rename(id, title, owner = null) {
    const session = this.get(id, owner)
    const next = typeof title === 'string' ? title.trim().slice(0, 120) : ''
    if (next.length === 0) throw coded('BAD_TITLE', 'title must not be empty', 400)
    session.title = next
    session.updatedAt = Date.now()
    this.emitState(session)
    this.emitSessions()
    return this.info(session)
  }

  /**
   * @param {string} id session id.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Record<string, unknown>} `{ session, replay }` with base64 retained output.
   */
  replay(id, owner = null) {
    const session = this.get(id, owner)
    return { session: this.info(session), replay: toBase64(session.ring.toBuffer()) }
  }

  /**
   * Disconnect a session but keep it (and its history, title and permission) so
   * it can be reconnected later. This is not close(): the session stays listed.
   * @param {string} id session id.
   * @param {string} [reason] recorded disconnect reason.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Promise<Record<string, unknown>>} session info.
   */
  async disconnect(id, reason = 'user disconnect', actor = 'human', owner = null) {
    const session = this.get(id, owner)
    if (session.state === 'disconnected') return this.info(session)
    if (session.state === 'closed' || session.state === 'failed') {
      throw coded('NOT_OPEN', `session is ${session.state}; nothing to disconnect`, 409)
    }
    this.cancelAutoReconnect(session)
    session.intentionalDisconnect = true
    const connection = session.connection
    session.connection = undefined
    try {
      await connection?.close?.(reason)
    } catch (error) {
      this.log('debug', `[aiterm] disconnect failed on ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.recordAudit(session, { source: actor === 'ai' ? 'ai' : 'human', action: 'lock', detail: `disconnect: ${reason}` })
    this.markDisconnected(session, reason, { unexpected: false })
    return this.info(session)
  }

  /**
   * Reconnect a disconnected session under the SAME id, reusing the stored auth
   * (a saved profile is re-resolved so a rotated password is picked up).
   * @param {string} id session id.
   * @param {{ cols?: unknown, rows?: unknown }} [options] new terminal size.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Promise<Record<string, unknown>>} session info (state open or failed).
   */
  async reconnect(id, options = {}, actor = 'human', owner = null) {
    const session = this.get(id, owner)
    if (session.state === 'open') return this.info(session)
    if (session.state === 'connecting' || session.reconnecting === true) {
      throw coded('ALREADY_CONNECTING', 'this session is already connecting', 409)
    }
    if (session.state === 'closed') throw coded('NOT_RECONNECTABLE', 'session was closed; create a new one', 409)

    // Resolve credentials: a saved profile wins (it may have rotated), otherwise
    // the in-memory auth captured when the session was first created.
    let auth = session.auth
    if (typeof session.profileId === 'string' && session.profileId.length > 0) {
      try {
        const profile = await this.profiles.connectionFor(session.profileId)
        auth = profile.auth
      } catch (error) {
        this.log('warn', `[aiterm] profile ${session.profileId} unavailable for reconnect: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (auth === undefined || auth === null) {
      throw coded(
        'RECONNECT_NO_CREDENTIALS',
        'no credentials are available to reconnect this session; reconnect it from a saved profile',
        409,
      )
    }
    session.auth = auth
    session.cols = boundInteger(options.cols, session.cols, 20, 500)
    session.rows = boundInteger(options.rows, session.rows, 5, 300)

    // The remote side is a brand-new shell: reset the screen (history and the
    // output log are kept, so cursors and history stay valid).
    try {
      session.screen.dispose()
    } catch {
      // disposal is best effort
    }
    session.screen = new Screen({ cols: session.cols, rows: session.rows, scrollback: this.config.scrollback })
    session.screens.clear()
    session.connection = undefined
    session.state = 'connecting'
    session.reconnecting = true
    session.error = undefined
    session.updatedAt = Date.now()
    this.emitState(session)
    this.emitSessions()

    await this.openConnection(session)
    // Tell clients to wipe their terminal: success means a fresh shell, and a
    // failure means the old screen behind the banner is stale either way.
    if (session.state === 'open') {
      this.emit({ type: 'reset', sessionId: session.id, session: this.info(session), reason: 'reconnected' })
    } else {
      this.emit({ type: 'reset', sessionId: session.id, session: this.info(session), reason: 'reconnect failed' })
    }
    this.recordAudit(session, {
      source: actor === 'ai' ? 'ai' : 'human',
      action: 'lock',
      detail: `reconnect: ${session.state}${session.error === undefined ? '' : ` (${session.error})`}`,
    })
    return this.info(session)
  }

  /**
   * Close one session and drop it from the registry.
   *
   * An already-gone id is a no-op (`{ ok: true }`); a live session owned by a
   * different DSH session is reported as `SESSION_NOT_FOUND`, never as "forbidden",
   * so the call cannot probe for existence.
   * @param {string} id session id.
   * @param {string} [reason] close reason for the audit trail.
   * @param {'human' | 'ai'} [actor] caller.
   * @param {unknown} [owner] requester owner (DSH session id; `null` = legacy bucket).
   * @returns {Promise<{ ok: true }>} acknowledgement.
   */
  async close(id, reason = 'closed by user', actor = 'human', owner = null) {
    const session = this.sessions.get(typeof id === 'string' ? id : '')
    if (session === undefined) return { ok: true }
    if (sessionOwner(session) !== normalizeOwner(owner)) {
      throw coded('SESSION_NOT_FOUND', `session ${String(id)} does not exist`, 404)
    }
    session.intentionalDisconnect = true
    this.lockTimerClear(session)
    try {
      await session.connection?.close?.(reason)
    } catch (error) {
      this.log('debug', `[aiterm] close failed on ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.recordAudit(session, { source: actor === 'ai' ? 'ai' : 'human', action: 'lock', detail: `close: ${reason}` })
    this.finalize(session, { reason })
    return { ok: true }
  }

  /**
   * Finish the automatic log file for one session (flush queued chunks).
   *
   * Called when a transport goes away and when a session is finalized. It is a
   * best-effort, fire-and-forget flush: the log file must never delay or fail a
   * close, and a reconnect reuses the same file.
   * @param {string} sessionId session id.
   * @returns {void}
   */
  closeAutoLog(sessionId) {
    try {
      this.autolog.close(sessionId).catch((error) => {
        this.log('debug', `[aiterm] autolog close failed on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      this.log('debug', `[aiterm] autolog close failed on ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Export stored output history as human-readable text log files.
   *
   * Writes into `<dataDir>/exports/` and returns the written paths so the user
   * can pick them up from the Host file panel.
   * @param {{ sessionId?: unknown, all?: unknown, since?: unknown, until?: unknown, owner?: unknown }} [options] selection.
   * @returns {Promise<{ dir: string, files: Array<{ sessionId: string, path: string, bytes: number, lines: number }> }>} export result.
   * @throws {import('./util.js').CodedError} `HISTORY_UNAVAILABLE`, `SESSION_NOT_FOUND` or `BAD_TARGET`.
   */
  async exportHistory(options = {}) {
    if (this.historyStore === undefined) {
      throw coded('HISTORY_UNAVAILABLE', 'durable history is not available; the plugin cannot export logs', 503)
    }
    const opts = options !== null && typeof options === 'object' ? options : {}
    const wanted = normalizeOwner(opts.owner)
    const sessionId = typeof opts.sessionId === 'string' && opts.sessionId.length > 0 ? opts.sessionId : undefined
    // Export must not reveal (or hand out files for) another DSH session's logs.
    if (sessionId !== undefined && this.ownerOf(sessionId) !== wanted) {
      throw coded('SESSION_NOT_FOUND', `session ${sessionId} does not exist`, 404)
    }
    // A filtered view: the exporter only uses fileFor/listSessions/flush.
    const historyStore = {
      fileFor: (id) => this.historyStore.fileFor(id),
      flush: () => this.historyStore.flush(),
      listSessions: async (query) =>
        (await this.historyStore.listSessions(query)).filter((entry) => this.ownerOf(entry.id) === wanted),
    }
    return exportSessions({
      historyStore,
      sessions: this.list(wanted),
      dir: join(this.dataDir, 'exports'),
      sessionId,
      all: opts.all === true,
      since: parseTimestamp(opts.since),
      until: parseTimestamp(opts.until),
    })
  }

  /**
   * Audit entries, newest last.
   * @param {{ sessionId?: string, limit?: number, owner?: unknown }} [options] filter.
   * @returns {Array<Record<string, unknown>>} entries.
   */
  audit(options = {}) {
    const limit = boundInteger(options.limit, 100, 1, AUDIT_GLOBAL)
    const wanted = normalizeOwner(options.owner)
    if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
      const session = this.sessions.get(options.sessionId)
      if (session === undefined) return []
      if (sessionOwner(session) !== wanted) throw coded('SESSION_NOT_FOUND', `session ${options.sessionId} does not exist`, 404)
      return session.audit.slice(-limit)
    }
    return this.globalAudit
      .filter((entry) => this.ownerOf(entry.sessionId) === wanted)
      .slice(-limit)
  }

  /**
   * Close every session and stop timers.
   * @returns {Promise<void>} completion.
   */
  async dispose() {
    this.disposed = true
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(sessions.map((session) => this.close(session.id, 'plugin unloading', 'human', sessionOwner(session))))
    this.sessions.clear()
    this.owners.clear()
    this.listeners.clear()
    if (this.historyStore !== undefined) {
      try {
        await this.historyStore.dispose()
      } catch {
        // shutdown must not throw
      }
    }
    try {
      await this.autolog.dispose()
    } catch {
      // shutdown must not throw
    }
  }
}

/**
 * Normalize an owner argument.
 *
 * The owner is a DSH (AI) session id; anything absent, empty or non-string maps
 * to the legacy `null` bucket, which is what the panel uses when it cannot read
 * the DSH session id.
 * @param {unknown} value raw owner.
 * @returns {string | null} trimmed owner or `null`.
 */
export function normalizeOwner(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  return text.slice(0, 128)
}

/**
 * @param {SessionRecord} session session.
 * @returns {string | null} its normalized owner.
 */
function sessionOwner(session) {
  return normalizeOwner(session.owner)
}

/**
 * Build a view of the registry bound to one owner.
 *
 * Every id-based call goes through {@link SessionRegistry#get} with the owner
 * injected, so a caller cannot reach another DSH session's terminal even by
 * guessing its id. Batch/script runners receive this view and therefore inherit
 * the same isolation. Unknown methods fall through bound to the raw registry
 * (events/subscription are owner-agnostic on purpose).
 * @param {SessionRegistry} registry the real registry.
 * @param {unknown} owner owning DSH (AI) session id; `null` = legacy bucket.
 * @returns {SessionRegistry} owner-scoped facade.
 */
export function ownerScopedRegistry(registry, owner) {
  const wanted = normalizeOwner(owner)
  /** @type {Record<string, Function>} */
  const bound = {
    write: (id, data, actor) => registry.write(id, data, actor, wanted),
    read: (id, options = {}) => registry.read(id, { ...options, owner: wanted }),
    readDelta: (id, options = {}) => registry.readDelta(id, { ...options, owner: wanted }),
    readScreen: (id, options = {}) => registry.readScreen(id, { ...options, owner: wanted }),
    waitFor: (id, options = {}) => registry.waitFor(id, { ...options, owner: wanted }),
    atPrompt: (id) => registry.atPrompt(id, wanted),
    get: (id) => registry.get(id, wanted),
    list: () => registry.list(wanted),
    info: (session) => registry.info(session),
    create: (input, actor) => registry.create(input, actor, wanted),
    resize: (id, cols, rows, actor) => registry.resize(id, cols, rows, actor, wanted),
    screenshot: (id, actor) => registry.screenshot(id, actor, wanted),
    rename: (id, title) => registry.rename(id, title, wanted),
    replay: (id) => registry.replay(id, wanted),
    disconnect: (id, reason, actor) => registry.disconnect(id, reason, actor, wanted),
    reconnect: (id, options, actor) => registry.reconnect(id, options, actor, wanted),
    close: (id, reason, actor) => registry.close(id, reason, actor, wanted),
    setAiAccess: (id, aiAccess, actor) => registry.setAiAccess(id, aiAccess, actor, wanted),
    takeOver: (id, actor) => registry.takeOver(id, actor, wanted),
    release: (id, actor) => registry.release(id, actor, wanted),
    relinquish: (id, actor) => registry.relinquish(id, actor, wanted),
    audit: (options = {}) => registry.audit({ ...options, owner: wanted }),
    historyQuery: (query = {}) => registry.historyQuery({ ...query, owner: wanted }),
    historySessions: (options = {}) => registry.historySessions({ ...options, owner: wanted }),
    exportHistory: (options = {}) => registry.exportHistory({ ...options, owner: wanted }),
    activeCount: () => registry.activeCount(wanted),
    ownerOf: (id) => registry.ownerOf(id),
    subscribe: (listener) => registry.subscribe(listener),
  }
  return /** @type {SessionRegistry} */ (
    new Proxy(bound, {
      /**
       * @param {Record<string, any>} target bound methods.
       * @param {string | symbol} property requested property.
       * @returns {any} bound method or registry value.
       */
      get(target, property) {
        if (property in target) return target[property]
        const value = registry[property]
        return typeof value === 'function' ? value.bind(registry) : value
      },
    })
  )
}

/**
 * Re-derive a permission state (exported for tests and diagnostics).
 * @param {PermissionState} state permission state.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @returns {PermissionState} the same state.
 */
export function rederive(state, config) {
  return derive(state, config)
}

/**
 * Parse a time argument: epoch ms, ISO date-time, or a relative amount such as
 * "10m", "2h", "90s", "1d" (relative to now, going back).
 * @param {unknown} value raw time argument.
 * @returns {number | undefined} epoch milliseconds.
 */
export function parseTimestamp(value) {
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
 * Escape a string for literal use inside a RegExp.
 * @param {string} text literal text.
 * @returns {string} escaped text.
 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
