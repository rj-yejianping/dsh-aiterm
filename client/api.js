/**
 * Wire client for the SSH / Telnet Host half.
 *
 * Two transports, both defined by CONTRACTS.md §5:
 * - `POST <route>/rpc` with `{ method, params }` answering `{ ok, result }` or
 *   `{ ok: false, error: { code, message } }`.
 * - `GET <route>/events` (global) and `GET <route>/events?sessionId=<id>`
 *   (per session) as Server-Sent Events carrying `data: <json>` frames.
 *
 * Everything here is defensive: malformed payloads are normalized or dropped so
 * a Host mistake can never throw inside the slot body.
 */

/** Route prefix owned by the Host half. */
export const ROUTE = '/aiterm'

/** Failure carrying the Host error code (`HUMAN_WRITE_BLOCKED`, …). */
export class ApiError extends Error {
  /**
   * @param message - Host-provided message.
   * @param code - Host error code, when present.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

// ── per-AI-session ownership ────────────────────────────────────────────────
//
// Every terminal belongs to one DSH (AI) session: two conversations must not
// see each other's SSH/Telnet sessions. The store owns the current owner and
// hands it to this module once, so every session-scoped call carries it
// without threading a parameter through dozens of call sites.
/** @type {() => string | undefined} */
let ownerResolver = () => undefined

/**
 * Install the function that reports the current DSH session id.
 *
 * @param resolve - returns the owner, or undefined when unknown (legacy mode).
 * @returns {void}
 */
export function setOwnerResolver(resolve) {
  ownerResolver = typeof resolve === 'function' ? resolve : () => undefined
}

/** @returns {string | undefined} the current owner, when known. */
export function currentOwner() {
  try {
    const value = ownerResolver()
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a method scopes its data to one AI session.
 *
 * Profiles, saved scripts and the auto-log switch are host-wide settings, and
 * `history.export all` is an explicitly cross-session operation, so those
 * never receive an owner.
 *
 * @param method - RPC method name.
 * @returns true when the owner should be attached.
 */
function ownerScoped(method) {
  return /^(sessions|permission|lock|read|audit)\./.test(method)
    || method === 'history.sessions'
    || method === 'history.query'
    || method === 'batch.run'
}

/**
 * Call one Host RPC method.
 *
 * @param method - method name from CONTRACTS.md §5. * @param params - method parameters.
 * @returns the `result` payload.
 * @throws {ApiError} when the HTTP call or the Host answer fails.
 */
/**
 * Attach the current AI-session owner to a session-scoped call.
 *
 * @param method - RPC method name.
 * @param params - caller parameters (left untouched).
 * @returns the parameters to send.
 */
function withOwner(method, params) {
  const base = params !== null && typeof params === 'object' ? params : {}
  if (!ownerScoped(method)) return base
  const owner = currentOwner()
  if (owner === undefined) return base
  return { ...base, owner }
}

export async function rpc(method, params = {}) {
  let response
  try {
    response = await fetch(ROUTE + '/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: withOwner(method, params) }),
    })
  } catch (error) {
    throw new ApiError(error && error.message ? error.message : 'network error', 'NETWORK_ERROR')
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (body && typeof body === 'object' && body.ok === true) return body.result

  const hostError = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
  const message = hostError && typeof hostError.message === 'string'
    ? hostError.message
    : `HTTP ${response.status} ${response.statusText || ''}`.trim()
  throw new ApiError(message, hostError && typeof hostError.code === 'string' ? hostError.code : undefined)
}

/**
 * Decode a base64 pty chunk into bytes.
 *
 * xterm's UTF-8 decoder consumes bytes, so passing a Uint8Array keeps multibyte
 * characters split across two chunks intact.
 *
 * @param value - base64 string from the Host.
 * @returns the raw bytes (empty when the value is unusable).
 */
export function decodeBase64(value) {
  if (typeof value !== 'string' || value === '') return new Uint8Array(0)
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * Parse one SSE `data:` payload.
 *
 * @param data - raw frame text.
 * @returns the decoded object, or null when the frame is not JSON.
 */
export function parseFrame(data) {
  if (typeof data !== 'string' || data === '') return null
  try {
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asString(value) {
  return typeof value === 'string' && value ? value : undefined
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Normalize a `PermissionState` (§3) with safe derived defaults.
 *
 * @param raw - Host-provided permission object.
 * @returns a complete permission state.
 */
export function normalizePermission(raw) {
  const source = record(raw) || {}
  const aiAccess = source.aiAccess === 'ro' || source.aiAccess === 'wo' || source.aiAccess === 'rw'
    ? source.aiAccess
    : 'rw'
  const lockOwner = source.lockOwner === 'ai' || source.lockOwner === 'human' ? source.lockOwner : null
  const lockExpiresAt = asNumber(source.lockExpiresAt) ?? null
  const humanWriteBlocked = typeof source.humanWriteBlocked === 'boolean'
    ? source.humanWriteBlocked
    : lockOwner === 'ai'
  const aiWriteBlocked = typeof source.aiWriteBlocked === 'boolean'
    ? source.aiWriteBlocked
    : aiAccess === 'ro' || lockOwner === 'human'
  return { aiAccess, lockOwner, lockExpiresAt, humanWriteBlocked, aiWriteBlocked }
}

/**
 * Normalize a Host session record (§3).
 *
 * @param raw - Host-provided session object.
 * @returns a session ready for rendering, or null when it has no id.
 */
export function normalizeSession(raw) {
  const source = record(raw)
  if (!source) return null
  const id = asString(source.id)
  if (!id) return null

  const transport = source.transport === 'telnet' ? 'telnet' : 'ssh'
  const state = source.state === 'connecting' || source.state === 'open' || source.state === 'disconnected'
    || source.state === 'closed' || source.state === 'failed'
    ? source.state
    : 'connecting'

  return {
    id,
    title: asString(source.title) || id,
    transport,
    host: asString(source.host) || '',
    port: asNumber(source.port) ?? (transport === 'telnet' ? 23 : 22),
    username: asString(source.username) || '',
    profileId: asString(source.profileId),
    state,
    error: asString(source.error),
    // v4 session lifecycle (§17): `generation` grows by one on every successful
    // (re)connect; the client uses it to clear the screen when the `reset`
    // frame was missed. `disconnected` sessions stay in the list.
    generation: normalizeGeneration(source.generation),
    disconnectedAt: asNumber(source.disconnectedAt),
    closeReason: asString(source.closeReason),
    reconnecting: source.reconnecting === true,
    cols: asNumber(source.cols) ?? 80,
    rows: asNumber(source.rows) ?? 24,
    createdAt: asNumber(source.createdAt) ?? 0,
    updatedAt: asNumber(source.updatedAt) ?? 0,
    lastActivityAt: asNumber(source.lastActivityAt) ?? 0,
    bytesIn: asNumber(source.bytesIn) ?? 0,
    bytesOut: asNumber(source.bytesOut) ?? 0,
    permission: normalizePermission(source.permission),
  }
}

/**
 * Normalize a session generation counter.
 *
 * @param value - Host-provided generation.
 * @returns a non-negative integer (0 when absent or malformed).
 */
export function normalizeGeneration(value) {
  const number = asNumber(value)
  if (number === undefined || number < 0) return 0
  return Math.trunc(number)
}

/* ------------------------------------------------------------------ *
 * v4 session lifecycle RPC wrappers (CONTRACTS.md §15–§17)
 *
 * `disconnect` keeps the session (and its history/permission/audit) in the
 * list with `state = 'disconnected'`; `reconnect` reuses the same id and, on
 * success, rebuilds the remote screen and bumps `generation`. A failed
 * reconnect resolves with a `failed` session (Host error in `error`) instead of
 * throwing; transport/protocol failures still reject.
 * ------------------------------------------------------------------ */

/**
 * Disconnect a session but keep it for a later reconnect.
 *
 * @param id - session id.
 * @param reason - optional human-readable reason for the audit/history record.
 * @returns `{ session }` with `state = 'disconnected'`.
 */
export function sessionsDisconnect(id, reason) {
  const params = { id: String(id || '') }
  if (typeof reason === 'string' && reason.trim() !== '') params.reason = reason.trim()
  return rpc('sessions.disconnect', params)
}

/**
 * Build the `sessions.reconnect` params from the session id and terminal size.
 *
 * The Host uses `cols`/`rows` to size the fresh pty before it starts the new
 * screen, so the panel sends the *fitted* xterm geometry, not the stale one
 * recorded on the session.
 *
 * @param id - session id.
 * @param size - `{ cols, rows }` from the fitted terminal (optional).
 * @returns `{ id, cols?, rows? }`.
 */
export function buildReconnectPayload(id, size = {}) {
  const params = { id: String(id || '') }
  const source = record(size) || {}
  const cols = asNumber(source.cols)
  const rows = asNumber(source.rows)
  if (cols !== undefined && cols > 0) params.cols = Math.trunc(cols)
  if (rows !== undefined && rows > 0) params.rows = Math.trunc(rows)
  return params
}

/**
 * Reconnect a disconnected session (same id, history preserved).
 *
 * @param id - session id.
 * @param size - `{ cols, rows }` from the fitted terminal.
 * @returns `{ session }` with `state = 'open'` or `'failed'`.
 */
export function sessionsReconnect(id, size) {
  return rpc('sessions.reconnect', buildReconnectPayload(id, size))
}

/**
 * Normalize a `ProfileInfo` (§5).
 *
 * @param raw - Host-provided profile.
 * @returns a profile ready for the picker, or null when it has no id.
 */
export function normalizeProfile(raw) {
  const source = record(raw)
  if (!source) return null
  const id = asString(source.id)
  if (!id) return null
  const transport = source.transport === 'telnet' ? 'telnet' : 'ssh'
  const authType = source.authType === 'password' || source.authType === 'privateKey' || source.authType === 'agent' || source.authType === 'none'
    ? source.authType
    : 'none'
  return {
    id,
    name: asString(source.name) || id,
    transport,
    host: asString(source.host) || '',
    port: asNumber(source.port) ?? (transport === 'telnet' ? 23 : 22),
    username: asString(source.username) || '',
    authType,
    hasPassword: source.hasPassword === true,
    hasPrivateKey: source.hasPrivateKey === true,
    hasPassphrase: source.hasPassphrase === true,
    folder: asString(source.folder) || '',
    order: asNumber(source.order) ?? 0,
    createdAt: asNumber(source.createdAt) ?? 0,
    updatedAt: asNumber(source.updatedAt) ?? 0,
  }
}

/* ------------------------------------------------------------------ *
 * v3 profile management RPC wrappers (CONTRACTS.md §13)
 *
 * All profile writes are human-only Host-side; the UI is the human path.
 * Secrets are write-only: a payload never carries one back and an omitted
 * secret field means "keep the stored value".
 * ------------------------------------------------------------------ */

/** List saved profiles plus the folder overview. @returns `{ profiles, folders }`. */
export function profilesList() {
  return rpc('profiles.list', {})
}

/**
 * Create or update one profile (`id` present = update).
 *
 * @param profile - profile fields; secrets only when the human typed one.
 * @returns `{ profile }`.
 */
export function profilesSave(profile) {
  return rpc('profiles.save', { profile })
}

/**
 * Rename a profile's display name (the id, and therefore the credential key,
 * never changes).
 *
 * @param id - profile id.
 * @param name - new display name.
 * @returns `{ profile }`.
 */
export function profilesRename(id, name) {
  return rpc('profiles.rename', { id: String(id || ''), name: String(name || '') })
}

/**
 * Move a profile into a folder ('' ungroups it).
 *
 * @param id - profile id.
 * @param folder - target folder label.
 * @returns `{ profile }`.
 */
export function profilesSetFolder(id, folder) {
  return rpc('profiles.setFolder', {
    id: String(id || ''),
    folder: typeof folder === 'string' ? folder : '',
  })
}

/**
 * Delete one profile and its three credential slots.
 *
 * @param id - profile id.
 * @returns `{ ok: boolean }`.
 */
export function profilesDelete(id) {
  return rpc('profiles.delete', { id: String(id || '') })
}

/**
 * Normalize the `profiles.list` result.
 *
 * The contract returns `{ profiles, folders: [{ name, count }] }`; an older
 * Host only returns `profiles`, so the folder overview is derived when absent
 * (and merged with the Host overview when present) so the panel is usable
 * against either revision.
 *
 * @param raw - Host-provided result.
 * @returns `{ profiles, folders: [{ name, count }] }`.
 */
export function normalizeProfilesResult(raw) {
  const source = record(raw) || {}
  const profiles = Array.isArray(source.profiles) ? source.profiles.map(normalizeProfile).filter(Boolean) : []
  const counts = new Map()
  for (const profile of profiles) {
    const folder = folderOf(profile)
    if (folder === '') continue
    counts.set(folder, (counts.get(folder) || 0) + 1)
  }
  if (Array.isArray(source.folders)) {
    for (const entry of source.folders) {
      const item = record(entry)
      if (!item) continue
      const name = asString(item.name)
      if (!name) continue
      const count = asNumber(item.count)
      if (!counts.has(name)) counts.set(name, count ?? 0)
    }
  }
  const folders = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return { profiles, folders }
}

/** @param profile - normalized or raw profile. @returns its trimmed folder ('' = ungrouped). */
function folderOf(profile) {
  const value = profile && typeof profile.folder === 'string' ? profile.folder.trim() : ''
  return value
}

/**
 * Group items by folder for the profile and script lists.
 *
 * Folders are sorted by name; the ungrouped bucket always comes last, labelled
 * by the caller. Empty folders given in `extraFolders` are only emitted when
 * `keepEmpty` is true (a folder created client-side has no profiles yet).
 *
 * @param items - items carrying a `folder` field.
 * @param options.extraFolders - additional folder names to offer.
 * @param options.keepEmpty - emit sections for folders without items.
 * @returns `[{ folder, items, count }]`.
 */
export function groupByFolder(items, options = {}) {
  const list = Array.isArray(items) ? items : []
  const extra = Array.isArray(options.extraFolders) ? options.extraFolders : []
  const map = new Map()
  for (const name of extra) {
    if (typeof name === 'string' && name.trim() !== '') map.set(name.trim(), [])
  }
  for (const item of list) {
    const folder = folderOf(item)
    if (!map.has(folder)) map.set(folder, [])
    map.get(folder).push(item)
  }
  const names = [...map.keys()].filter((name) => name !== '')
  names.sort((left, right) => left.localeCompare(right))
  const groups = []
  for (const name of names) {
    const members = map.get(name) || []
    if (members.length === 0 && options.keepEmpty !== true) continue
    groups.push({ folder: name, items: members, count: members.length })
  }
  const ungrouped = map.get('') || []
  if (ungrouped.length > 0) groups.push({ folder: '', items: ungrouped, count: ungrouped.length })
  return groups
}

/**
 * Build a profile-shaped payload for `profiles.save`.
 *
 * Omitted secret fields mean "keep the stored credential", so only non-empty
 * values are attached. `id` is only present when updating, which is what keeps
 * the credential key (and therefore the saved password) reachable.
 *
 * @param fields - form values.
 * @returns the `profile` payload for {@link profilesSave}.
 */
export function buildProfilePayload(fields = {}) {
  const transport = fields.transport === 'telnet' ? 'telnet' : 'ssh'
  const payload = {
    name: typeof fields.name === 'string' ? fields.name.trim() : '',
    transport,
    host: typeof fields.host === 'string' ? fields.host.trim() : '',
    port: asNumber(fields.port) ?? (transport === 'telnet' ? 23 : 22),
    username: typeof fields.username === 'string' ? fields.username.trim() : '',
    authType: transport === 'ssh'
      ? (fields.authType === 'privateKey' || fields.authType === 'agent' || fields.authType === 'none'
        ? fields.authType
        : 'password')
      : 'none',
    folder: folderOf(fields),
  }
  const id = asString(fields.id)
  if (id) payload.id = id
  const order = asNumber(fields.order)
  if (order !== undefined) payload.order = order
  if (typeof fields.password === 'string' && fields.password !== '') payload.password = fields.password
  if (typeof fields.privateKey === 'string' && fields.privateKey.trim() !== '') payload.privateKey = fields.privateKey
  if (typeof fields.passphrase === 'string' && fields.passphrase !== '') payload.passphrase = fields.passphrase
  return payload
}

/**
 * Normalize one audit entry (§4).
 *
 * @param raw - Host-provided audit entry.
 * @returns the entry, or null when unusable.
 */
export function normalizeAuditEntry(raw) {
  const source = record(raw)
  if (!source) return null
  const action = source.action === 'read' || source.action === 'write' || source.action === 'deny' || source.action === 'lock'
    ? source.action
    : 'read'
  return {
    at: asNumber(source.at) ?? Date.now(),
    sessionId: asString(source.sessionId),
    source: source.source === 'ai' ? 'ai' : 'human',
    action,
    detail: asString(source.detail) || '',
    byteLength: asNumber(source.byteLength) ?? 0,
  }
}

/**
 * Format a byte count for the status bar.
 *
 * @param value - byte count.
 * @returns a short human-readable string.
 */
export function formatBytes(value) {
  const bytes = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  if (bytes < 1024) return String(bytes)
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/* ------------------------------------------------------------------ *
 * v2 RPC wrappers (CONTRACTS.md §12.3)
 *
 * Every wrapper only forwards well-formed parameters and returns the raw
 * `result`; callers normalize it with the `normalize*` helpers below so a
 * malformed Host payload can never throw inside a panel.
 * ------------------------------------------------------------------ */

function definedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function definedString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read new output from a session cursor.
 *
 * @param id - session id.
 * @param options.cursor - opaque cursor from a previous read.
 * @param options.maxBytes - bound for this read.
 * @returns `{ text, cursor, newBytes, atPrompt }`.
 */
export function readDelta(id, options = {}) {
  const params = { id }
  const cursor = definedString(options.cursor)
  if (cursor !== undefined) params.cursor = cursor
  const maxBytes = definedNumber(options.maxBytes)
  if (maxBytes !== undefined) params.maxBytes = maxBytes
  return rpc('read.delta', params)
}

/**
 * Read the visible screen text of a session.
 *
 * @param id - session id.
 * @param options.changedOnly - only lines changed since this human reader's last read.
 * @param options.maxLines - keep at most this many lines.
 * @returns `{ text, changedLines, cursor, atPrompt, unchanged }`.
 */
export function readScreen(id, options = {}) {
  const params = { id, changedOnly: options.changedOnly === true }
  const maxLines = definedNumber(options.maxLines)
  if (maxLines !== undefined) params.maxLines = maxLines
  return rpc('read.screen', params)
}

/**
 * List persisted history sessions, newest first.
 *
 * @param options.limit - maximum number of catalog entries.
 * @param options.since - epoch ms lower bound.
 * @param options.until - epoch ms upper bound.
 * @returns `{ sessions: CatalogEntry[] }`.
 */
export function historySessions(options = {}) {
  const params = {}
  const limit = definedNumber(options.limit)
  if (limit !== undefined) params.limit = limit
  const since = definedNumber(options.since)
  if (since !== undefined) params.since = since
  const until = definedNumber(options.until)
  if (until !== undefined) params.until = until
  return rpc('history.sessions', params)
}

/**
 * Search the persisted output of one session.
 *
 * @param params.sessionId - catalog session id.
 * @param params.since - epoch ms lower bound.
 * @param params.until - epoch ms upper bound.
 * @param params.search - regex or plain text.
 * @param params.context - context lines around each match (0-5).
 * @param params.maxMatches - match cap.
 * @param params.maxBytes - scan cap.
 * @returns `{ matches, truncated, scannedBytes, entry? }`.
 */
/**
 * Export session output to files on the Host.
 *
 * @param params - `{ sessionId?, all?, since?, until? }`.
 * @returns `{ dir, files: [{ sessionId, path, bytes, lines }] }`.
 */
export function historyExport(params = {}) {
  return rpc('history.export', params)
}

/**
 * Read the auto-log (write-to-file) switch.
 *
 * @returns `{ enabled, dir }`.
 */
export function autologGet() {
  return rpc('autolog.get', {})
}

/**
 * Flip the auto-log switch (and optionally its directory).
 *
 * @param params - `{ enabled?, dir? }`.
 * @returns `{ enabled, dir }`.
 */
export function autologSet(params = {}) {
  return rpc('autolog.set', params)
}

export function historyQuery(params = {}) {
  const payload = {}
  const sessionId = definedString(params.sessionId)
  if (sessionId !== undefined) payload.sessionId = sessionId
  for (const key of ['since', 'until', 'context', 'maxMatches', 'maxBytes', 'limit']) {
    const value = definedNumber(params[key])
    if (value !== undefined) payload[key] = value
  }
  const search = definedString(params.search)
  if (search !== undefined) payload.search = search
  return rpc('history.query', payload)
}

/** List saved scripts. @returns `{ scripts: ScriptSummary[] }`. */
export function scriptsList() {
  return rpc('scripts.list', {})
}

/**
 * Load one saved script definition, `steps` included (§14.5).
 *
 * The list only carries summaries, so the editor must call this before seeding
 * itself; otherwise "edit then save" would replace the program with an empty
 * one.
 *
 * @param name - script name.
 * @returns `{ script: ScriptDefinition }`; the Host answers 404 `SCRIPT_NOT_FOUND`.
 */
export function scriptsGet(name) {
  return rpc('scripts.get', { name: String(name || '') })
}

/**
 * Create or replace one saved script (human only).
 *
 * @param script - full script definition.
 * @returns `{ script: ScriptSummary }`.
 */
export function scriptsSave(script) {
  return rpc('scripts.save', { script })
}

/**
 * Delete one saved script (human only).
 *
 * @param name - script name.
 * @returns `{ ok: boolean }`.
 */
export function scriptsDelete(name) {
  return rpc('scripts.delete', { name })
}

/**
 * Run one saved script.
 *
 * @param params.name - script name.
 * @param params.params - parameter values.
 * @param params.sessionId - single target session.
 * @param params.targets - fan-out target sessions.
 * @returns `{ result: BatchResult }`.
 */
export function scriptsRun(params = {}) {
  const payload = { name: String(params.name || '') }
  const values = record(params.params)
  if (values) payload.params = values
  const targets = Array.isArray(params.targets) ? params.targets.filter((id) => typeof id === 'string' && id !== '') : []
  if (targets.length > 0) payload.targets = targets
  else {
    const sessionId = definedString(params.sessionId)
    if (sessionId !== undefined) payload.sessionId = sessionId
  }
  return rpc('scripts.run', payload)
}

/**
 * Run an ad-hoc batch of steps.
 *
 * @param params.steps - BatchStep[].
 * @param params.targets - target session ids.
 * @param params.stopOnError - stop each target on the first failed step.
 * @param params.maxTotalMs - overall budget.
 * @param params.parallel - run targets concurrently.
 * @param params.label - audit label.
 * @returns `{ result: BatchResult }`.
 */
export function batchRun(params = {}) {
  const payload = { steps: Array.isArray(params.steps) ? params.steps : [] }
  const targets = Array.isArray(params.targets) ? params.targets.filter((id) => typeof id === 'string' && id !== '') : []
  if (targets.length > 0) payload.targets = targets
  if (typeof params.stopOnError === 'boolean') payload.stopOnError = params.stopOnError
  const maxTotalMs = definedNumber(params.maxTotalMs)
  if (maxTotalMs !== undefined) payload.maxTotalMs = maxTotalMs
  if (typeof params.parallel === 'boolean') payload.parallel = params.parallel
  const label = definedString(params.label)
  if (label !== undefined) payload.label = label
  return rpc('batch.run', payload)
}

/* ------------------------------------------------------------------ *
 * v2 normalizers — malformed payloads become safe defaults, never throws.
 * ------------------------------------------------------------------ */

/**
 * Normalize a `CatalogEntry` (§10) for the history session picker.
 *
 * @param raw - Host-provided catalog entry.
 * @returns the entry, or null when it has no id.
 */
export function normalizeCatalogEntry(raw) {
  const source = record(raw)
  if (!source) return null
  const id = asString(source.id)
  if (!id) return null
  const transport = source.transport === 'telnet' ? 'telnet' : 'ssh'
  return {
    id,
    title: asString(source.title) || id,
    transport,
    host: asString(source.host) || '',
    port: asNumber(source.port) ?? (transport === 'telnet' ? 23 : 22),
    username: asString(source.username) || '',
    createdAt: asNumber(source.createdAt) ?? 0,
    closedAt: asNumber(source.closedAt),
    bytes: asNumber(source.bytes) ?? 0,
    lastTs: asNumber(source.lastTs) ?? 0,
  }
}

/**
 * Normalize one history match row.
 *
 * @param raw - Host-provided match.
 * @returns the match, or null when unusable.
 */
export function normalizeMatch(raw) {
  const source = record(raw)
  if (!source) return null
  const strings = (value) => (Array.isArray(value) ? value.filter((line) => typeof line === 'string') : [])
  return {
    at: asNumber(source.at) ?? 0,
    line: typeof source.line === 'string' ? source.line : '',
    before: strings(source.before),
    after: strings(source.after),
  }
}

/**
 * Normalize a `history.query` result.
 *
 * Two Host shapes exist for the same method (§12.3): a match list (keyword set),
 * or — for a still-live session without a keyword — a raw text slice of the
 * requested time range. Both are captured so the panel can render the second
 * shape instead of pretending there were no results.
 *
 * @param raw - Host-provided result.
 * @returns `{ matches, text, truncated, scannedBytes, entry, sessions }`.
 */
export function normalizeHistoryQuery(raw) {
  const source = record(raw) || {}
  const matches = Array.isArray(source.matches) ? source.matches.map(normalizeMatch).filter(Boolean) : []
  // The panel renders ascending by time; sort defensively in case a Host
  // revision returns them out of order.
  matches.sort((left, right) => left.at - right.at)
  return {
    matches,
    text: typeof source.text === 'string' ? source.text : '',
    truncated: source.truncated === true,
    scannedBytes: asNumber(source.scannedBytes) ?? 0,
    entry: normalizeCatalogEntry(source.entry),
    sessions: Array.isArray(source.sessions) ? source.sessions.map(normalizeCatalogEntry).filter(Boolean) : undefined,
  }
}

/**
 * Normalize a script's parameter record.
 *
 * The contract stores `{ [name]: { default?, description? } }`, but a script
 * authored elsewhere may use plain strings or a name list; both are accepted.
 *
 * @param raw - Host-provided parameter map.
 * @returns `{ [name]: { default, description } }`.
 */
export function normalizeScriptParams(raw) {
  /** @type {Record<string, { default?: string, description?: string }>} */
  const out = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item !== '') out[item] = {}
      else if (item && typeof item === 'object') {
        const name = asString(item.name)
        if (name) {
          out[name] = {}
          if (typeof item.default === 'string') out[name].default = item.default
          if (typeof item.description === 'string') out[name].description = item.description
        }
      }
    }
    return out
  }
  const source = record(raw)
  if (!source) return out
  for (const [name, value] of Object.entries(source)) {
    if (!name) continue
    if (typeof value === 'string') out[name] = { default: value }
    else if (record(value)) {
      const entry = {}
      if (typeof value.default === 'string') entry.default = value.default
      if (typeof value.description === 'string') entry.description = value.description
      out[name] = entry
    } else out[name] = {}
  }
  return out
}

/**
 * Normalize a `ScriptSummary` (§11.3).
 *
 * @param raw - Host-provided summary.
 * @returns the summary, or null when it has no name.
 */
export function normalizeScriptSummary(raw) {
  const source = record(raw)
  if (!source) return null
  const name = asString(source.name)
  if (!name) return null
  const params = normalizeScriptParams(source.params)
  const declaredCount = typeof source.params === 'number' ? asNumber(source.params) : undefined
  const stepCount = asNumber(source.stepCount) ?? (Array.isArray(source.steps) ? source.steps.length : 0)
  return {
    name,
    description: asString(source.description) || '',
    folder: asString(source.folder) || '',
    params,
    paramCount: declaredCount ?? Object.keys(params).length,
    stepCount,
    updatedAt: asNumber(source.updatedAt) ?? 0,
  }
}

/**
 * Normalize a `ScriptDefinition` returned by `scripts.get` (§14.5).
 *
 * Only the editable fields are kept: the definition the editor seeds from is
 * exactly what gets written back, and `updatedAt`/`stepCount` are Host-managed.
 *
 * @param raw - Host-provided definition.
 * @returns `{ name, description, folder, params, steps }`, or null without a name.
 */
export function normalizeScriptDefinition(raw) {
  const source = record(raw)
  if (!source) return null
  const name = asString(source.name)
  if (!name) return null
  return {
    name,
    description: typeof source.description === 'string' ? source.description : '',
    folder: typeof source.folder === 'string' ? source.folder : '',
    params: normalizeScriptParams(source.params),
    steps: Array.isArray(source.steps) ? source.steps : [],
  }
}

/**
 * Normalize one batch run record (§11.2).
 *
 * @param raw - Host-provided run.
 * @returns the run, or null when unusable.
 */
export function normalizeBatchRun(raw) {
  const source = record(raw)
  if (!source) return null
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step) => {
      const entry = record(step) || {}
      return {
        index: asNumber(entry.index) ?? 0,
        depth: Math.max(0, asNumber(entry.depth) ?? 0),
        path: asString(entry.path) || '',
        kind: asString(entry.kind) || '',
        ok: entry.ok === true,
        matched: entry.matched === true,
        text: asString(entry.text),
        cursor: asString(entry.cursor),
        error: asString(entry.error),
      }
    })
    : []
  return {
    sessionId: asString(source.sessionId) || '',
    ok: source.ok === true,
    steps,
    stoppedAt: asNumber(source.stoppedAt),
  }
}

/**
 * Normalize a `BatchResult` (§11.2).
 *
 * @param raw - Host-provided result.
 * @returns a complete batch result.
 */
export function normalizeBatchResult(raw) {
  const source = record(raw) || {}
  const runs = Array.isArray(source.runs) ? source.runs.map(normalizeBatchRun).filter(Boolean) : []
  return {
    ok: source.ok === true,
    timedOut: source.timedOut === true,
    label: asString(source.label),
    runs,
  }
}

/**
 * Normalize one global `batch` SSE progress frame (§12.3, §14.1).
 *
 * v3 frames add the language fields `depth`, `path` and `kind` so the panel can
 * indent nested steps (`path` like `"3.2"`); v2 frames omit them and fall back
 * to the flat step index.
 *
 * @param raw - Host-provided frame.
 * @returns the frame, or null when it is not a batch frame or has no batch id.
 */
export function normalizeBatchFrame(raw) {
  const source = record(raw)
  if (!source || source.type !== 'batch') return null
  const batchId = asString(source.batchId)
  if (!batchId) return null
  return {
    batchId,
    label: asString(source.label),
    state: source.state === 'done' ? 'done' : 'step',
    sessionId: asString(source.sessionId) || '',
    stepIndex: asNumber(source.stepIndex) ?? 0,
    depth: Math.max(0, asNumber(source.depth) ?? 0),
    path: asString(source.path) || '',
    kind: asString(source.kind) || '',
    ok: source.ok === true,
    text: typeof source.text === 'string' ? source.text : undefined,
    error: asString(source.error),
    code: asString(source.code),
  }
}

/**
 * Normalize a `read.screen` result.
 *
 * @param raw - Host-provided result.
 * @returns `{ text, changedLines, cursor, atPrompt, unchanged }`.
 */
export function normalizeScreenResult(raw) {
  const source = record(raw) || {}
  return {
    text: typeof source.text === 'string' ? source.text : '',
    changedLines: Array.isArray(source.changedLines)
      ? source.changedLines.filter((line) => typeof line === 'string')
      : [],
    cursor: asString(source.cursor) || '',
    atPrompt: source.atPrompt === true,
    unchanged: source.unchanged === true,
  }
}

/**
 * Normalize a `read.delta` result.
 *
 * @param raw - Host-provided result.
 * @returns `{ text, cursor, newBytes, atPrompt }`.
 */
export function normalizeDeltaResult(raw) {
  const source = record(raw) || {}
  return {
    text: typeof source.text === 'string' ? source.text : '',
    cursor: asString(source.cursor) || '',
    newBytes: asNumber(source.newBytes) ?? 0,
    atPrompt: source.atPrompt === true,
  }
}

/* ------------------------------------------------------------------ *
 * Time / text / clipboard helpers for the v2 panels.
 * ------------------------------------------------------------------ */

/** Relative duration such as `90s`, `10m`, `2h`, `1d`. */
const RELATIVE_TIME = /^(\d{1,9})\s*(s|m|h|d)$/i

/**
 * Parse a time-range input into epoch milliseconds.
 *
 * Accepts a relative duration (`90s` / `10m` / `2h` / `1d`), an ISO date-time,
 * or a raw epoch (seconds or milliseconds). Empty input means "unbounded".
 *
 * @param input - text from the since/until field.
 * @param now - reference time for relative values.
 * @returns `{ ok: true, at }` (at undefined for empty) or `{ ok: false }`.
 */
export function parseTimeInput(input, now = Date.now()) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return { ok: true, at: undefined }

  const relative = RELATIVE_TIME.exec(raw)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const scale = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    if (!Number.isFinite(amount)) return { ok: false }
    return { ok: true, at: now - amount * scale }
  }

  if (/^\d{10,16}$/.test(raw)) {
    const value = Number(raw)
    if (!Number.isFinite(value)) return { ok: false }
    // A bare 10-digit value is an epoch in seconds; longer values are ms.
    return { ok: true, at: raw.length === 10 ? value * 1000 : value }
  }

  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return { ok: true, at: parsed }
  return { ok: false }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/**
 * Format a match timestamp as `HH:MM:SS.mmm` (local time).
 *
 * @param at - epoch ms.
 * @returns the time-of-day label.
 */
export function formatTimeOfDay(at) {
  const value = typeof at === 'number' && Number.isFinite(at) ? at : 0
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--:--.---'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/**
 * Format a catalog timestamp compactly: `HH:MM:SS` today, `MM-DD HH:MM` before.
 *
 * @param at - epoch ms.
 * @param now - reference time (defaults to now).
 * @returns the stamp label.
 */
export function formatStamp(at, now = Date.now()) {
  const value = typeof at === 'number' && Number.isFinite(at) ? at : 0
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const reference = new Date(now)
  const sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate()
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock.slice(0, 5)}`
}

/** Collapse whitespace so one entry stays on one visual line. @param text - raw text. @returns one line. */
export function oneLine(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/gu, ' ').trim()
}

/**
 * Truncate a string with an ellipsis.
 *
 * @param text - raw text.
 * @param max - maximum characters to keep.
 * @returns the truncated text.
 */
export function truncateText(text, max) {
  const value = stringOf(text)
  const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : 200
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value
}

function stringOf(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

/**
 * Compile the keyword field for highlighting.
 *
 * A valid regular expression is used as-is; an invalid one is escaped and
 * matched literally (the same fallback the Host uses for search).
 *
 * @param search - keyword text.
 * @returns a global, case-insensitive RegExp, or null when empty.
 */
export function highlightPattern(search) {
  const raw = typeof search === 'string' ? search.trim() : ''
  if (raw === '') return null
  try {
    return new RegExp(raw, 'gi')
  } catch {
    try {
      return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    } catch {
      return null
    }
  }
}

/**
 * Turn the keyword field into the `search` value sent to `history.query`.
 *
 * A valid regular expression is forwarded verbatim; an invalid one is escaped
 * so the Host matches it as plain text instead of failing the whole query.
 *
 * @param search - keyword text.
 * @returns the value for the RPC (undefined when empty).
 */
export function hostSearchValue(search) {
  const raw = typeof search === 'string' ? search.trim() : ''
  if (raw === '') return undefined
  try {
    // Validation only: the pattern itself is forwarded unchanged.
    new RegExp(raw) // eslint-disable-line no-new
    return raw
  } catch {
    return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}

/**
 * Split one line into highlighted and plain segments.
 *
 * @param text - line content.
 * @param pattern - result of {@link highlightPattern}.
 * @returns `[{ text, hit }]` covering the whole line.
 */
export function splitHighlight(text, pattern) {
  const line = stringOf(text)
  if (!pattern) return [{ text: line, hit: false }]
  let regex
  try {
    regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  } catch {
    return [{ text: line, hit: false }]
  }
  const parts = []
  let last = 0
  let guard = 0
  let match = null
  while ((match = regex.exec(line)) !== null) {
    guard += 1
    if (guard > 1000) break
    if (match[0] === '') {
      regex.lastIndex += 1
      if (regex.lastIndex > line.length && last >= line.length) break
      continue
    }
    if (match.index > last) parts.push({ text: line.slice(last, match.index), hit: false })
    parts.push({ text: match[0], hit: true })
    last = match.index + match[0].length
  }
  if (last < line.length) parts.push({ text: line.slice(last), hit: false })
  return parts.length > 0 ? parts : [{ text: line, hit: false }]
}

/**
 * Copy text to the clipboard without writing to `document.head`/`body`.
 *
 * Tries the async Clipboard API first. When that is unavailable (or refused),
 * it falls back to a temporary textarea appended to the caller-provided
 * container (which lives inside this plugin's own subtree), selects the text
 * and runs the legacy copy command.
 *
 * @param text - text to copy.
 * @param container - optional element inside the panel subtree for the fallback.
 * @returns whether the copy succeeded.
 */
export async function copyText(text, container) {
  const value = stringOf(text)
  if (value === '') return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }

  if (!container || typeof document === 'undefined' || typeof document.createElement !== 'function') return false
  let area = null
  try {
    area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'absolute'
    area.style.left = '-9999px'
    area.style.top = '0'
    area.style.opacity = '0'
    container.appendChild(area)
    area.focus()
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false
    container.removeChild(area)
    return ok
  } catch {
    try {
      if (area && area.parentNode) area.parentNode.removeChild(area)
    } catch {
      /* ignore */
    }
    return false
  }
}
