/**
 * Saved SSH/Telnet targets and their secrets.
 *
 * Non-secret metadata lives in `<dataDir>/profiles.json`; passwords, passphrases
 * and private keys never do:
 *
 * - When the Host provides the `credentials` service they are stored through its
 *   **records** API (`modifyRecord`/`readRecord`/`deleteRecord`) under a
 *   `CredentialKey` shaped `<scope>/<id>`: `aiterm/<profile>` for the
 *   password, `-key` / `-pass` suffixes for the private key and its passphrase.
 *   That is the API for "the credential this plugin holds for this id"; it never
 *   reaches the model or the browser.
 * - When it does not, they fall back to `<dataDir>/secrets.json` with mode 0600
 *   and the plugin logs a warning at startup.
 *
 * CRITICAL GRAMMAR: the DSH credentials document validates its sections on load.
 * `refs:` accepts only `CredentialRef` names — `/^[A-Za-z_][A-Za-z0-9_]*$/` — and
 * `records:` accepts only `<scope>/<id>` with each segment matching
 * `/^[a-z][a-z0-9-]*$/`. Writing a `refs` entry with a slash or hyphen makes the
 * whole document unparsable, which stops the credentials plugin (and therefore
 * DSH itself) from starting on the NEXT boot, long after the write looked fine.
 * This module therefore (a) uses the records API exclusively and (b) derives
 * every key through {@link credentialKeyFor}, which can only emit legal segments,
 * and validates it before touching the store.
 */

import { join } from 'node:path'
import { boundInteger, coded, ensureDir, readJsonIfPresent, writeJsonAtomic } from './util.js'

/** Where the metadata file lives inside the plugin data directory. */
const PROFILES_FILE = 'profiles.json'
/** Fallback secret file, used only without the credentials service. */
const SECRETS_FILE = 'secrets.json'
/** Scope segment of every credential key this plugin owns. */
export const CREDENTIAL_SCOPE = 'aiterm'
/** One `<scope>/<id>` segment, per the DSH credentials grammar. */
export const CREDENTIAL_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/
/** Suffix appended to a profile's segment for each secret slot. */
const SLOT_SUFFIX = Object.freeze({ password: '', privateKey: '-key', passphrase: '-pass' })

/**
 * Short, stable, non-cryptographic hash used to keep sanitized ids distinct.
 * @param {string} text raw profile id.
 * @returns {string} four lowercase hex digits.
 */
function shortHash(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4)
}

/**
 * Turn an arbitrary profile id into one legal `<id>` key segment.
 *
 * The mapping is deterministic for a given id. When it had to change the id
 * (uppercase letters, underscores, digits first, punctuation), a short hash of
 * the original is appended so two ids can never collapse onto the same key.
 * @param {string} profileId saved profile id.
 * @returns {string} a segment matching {@link CREDENTIAL_SEGMENT_PATTERN}.
 */
export function credentialSegmentFor(profileId) {
  const raw = typeof profileId === 'string' && profileId.length > 0 ? profileId : 'profile'
  let base = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base.length === 0) base = 'profile'
  if (!/^[a-z]/.test(base)) base = `p-${base}`
  // Hash whenever the mapping was not the identity: case folding, punctuation
  // replacement, a numeric first character, or truncation below. Otherwise two
  // distinct ids could collapse onto one credential key.
  const transformed = base !== raw || base.length > 60
  const suffix = transformed ? `-${shortHash(raw)}` : ''
  const maxBase = 60 - suffix.length
  const head = base.slice(0, maxBase).replace(/-+$/g, '') || 'profile'
  return `${head}${suffix}`
}

/**
 * Build the `CredentialKey` for one secret slot of one profile.
 * @param {string} shortRef `profileId`, `profileId#key` or `profileId#pass`.
 * @returns {string} `<scope>/<id>` key, always inside the DSH grammar.
 */
export function credentialKeyFor(shortRef) {
  const raw = String(shortRef ?? '')
  const match = raw.match(/^(.*)#(key|pass)$/)
  const profileId = match === null ? raw : match[1]
  const slot = match === null ? 'password' : match[2] === 'key' ? 'privateKey' : 'passphrase'
  return `${CREDENTIAL_SCOPE}/${credentialSegmentFor(profileId)}${SLOT_SUFFIX[slot]}`
}

/**
 * Whether a string is a legal DSH `CredentialKey` (`<scope>/<id>`).
 * @param {string} value candidate key.
 * @returns {boolean} true when the document parser would accept it.
 */
export function isCredentialKey(value) {
  if (typeof value !== 'string') return false
  const segments = value.split('/')
  return segments.length === 2 && segments.every((segment) => CREDENTIAL_SEGMENT_PATTERN.test(segment))
}

/**
 * Whether a string is a legal DSH `CredentialRef` (a POSIX identifier). This
 * plugin never writes refs; the check exists so a future edit cannot reintroduce
 * the document-corrupting write that stopped DSH from booting.
 * @param {string} value candidate reference.
 * @returns {boolean} true when the document parser would accept it.
 */
export function isCredentialRef(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/**
 * Secret access over the Host credential store (records), with a file fallback.
 */
export class SecretStore {
  /**
   * @param {object} options options.
   * @param {any} options.getCredentials resolves the Host `credentials` service lazily.
   * @param {string} options.dataDir plugin data directory.
   * @param {(level: string, message: string) => void} options.log logger.
   */
  constructor({ getCredentials, dataDir, log }) {
    this.getCredentials = getCredentials
    this.dataDir = dataDir
    this.log = log
    /** @type {Map<string, string>} */
    this.memory = new Map()
    this.fallbackLoaded = false
    this.warned = false
    this.storeFailed = false
  }

  /** @returns {any} the credentials service, when present. */
  credentials() {
    try {
      return this.getCredentials()
    } catch {
      return undefined
    }
  }

  /** @returns {boolean} whether the Host credential store is in use. */
  get encrypted() {
    return this.credentials() !== undefined
  }

  /**
   * @param {string} ref short reference such as `p-1` or `p-1#key`.
   * @returns {string} the `<scope>/<id>` credential key.
   */
  static keyFor(ref) {
    return credentialKeyFor(ref)
  }

  /**
   * Log (once) that the credential store misbehaved and the file fallback is in
   * use. A storage failure must never block saving a profile.
   * @param {unknown} error failure.
   * @returns {void}
   */
  noteStoreFailure(error) {
    if (this.storeFailed) return
    this.storeFailed = true
    this.log(
      'warn',
      `[aiterm] credential store unavailable (${error instanceof Error ? error.message : String(error)}); profile secrets fall back to a 0600 file`,
    )
  }

  /**
   * Load the fallback secret file once when no credential store exists.
   * @returns {Promise<void>} completion.
   */
  async loadFallback(force = false) {
    if (this.fallbackLoaded) return
    if (this.encrypted && force !== true) return
    this.fallbackLoaded = true
    if (!this.warned) {
      this.warned = true
      this.log(
        'warn',
        '[aiterm] the Host credentials service is unavailable; profile secrets fall back to a 0600 file under the plugin data directory',
      )
    }
    const file = join(this.dataDir, SECRETS_FILE)
    const parsed = await readJsonIfPresent(file)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') this.memory.set(key, value)
      }
    }
  }

  /**
   * Resolve a secret.
   * @param {string} ref short reference such as `p-1` or `p-1#key`.
   * @returns {Promise<string | undefined>} the secret value.
   */
  async get(ref) {
    const key = credentialKeyFor(ref)
    const credentials = this.credentials()
    if (credentials !== undefined && !this.storeFailed && isCredentialKey(key)) {
      try {
        const record = await credentials.readRecord(key)
        if (record !== null && typeof record === 'object' && record.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) {
          return record.key
        }
        // No record: the shared document may have been rewritten from a stale
        // snapshot. Fall through to the local mirror instead of reporting "unset".
        await this.loadFallback(true)
        return this.memory.get(key)
      } catch (error) {
        this.noteStoreFailure(error)
      }
    }
    // Degraded store (writes already failed): the local mirror is authoritative.
    await this.loadFallback(true)
    return this.memory.get(key)
  }

  /**
   * Store a secret.
   * @param {string} ref short reference.
   * @param {string} value secret value (empty deletes).
   * @returns {Promise<void>} completion.
   */
  async set(ref, value) {
    const key = credentialKeyFor(ref)
    // Belt and braces: an illegal key must never reach the durable document.
    if (isCredentialKey(key) === false) {
      throw coded('BAD_CREDENTIAL_KEY', `refusing to store a secret under the illegal credential key ${JSON.stringify(key)}`, 500)
    }
    const credentials = this.credentials()
    if (credentials !== undefined && !this.storeFailed) {
      try {
        if (value.length === 0) {
          await credentials.deleteRecord(key)
          await this.loadFallback(true)
          this.memory.delete(key)
          await this.persistFallback().catch(() => {})
          return
        }
        await credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: value }))
        // Write-through verification: the credential document is shared with other
        // plugins, and a corrupt or stale document can accept a write that a later
        // read no longer sees. Confirm the value, and fall back to the 0600 file
        // when it did not survive — a saved password must never silently vanish.
        const stored = await credentials.readRecord(key)
        const persisted = stored !== null && typeof stored === 'object' && stored.kind === 'api-key' ? stored.key : undefined
        if (persisted === value) {
          // Also mirror into the 0600 file: the shared document can later be
          // rewritten from another writer's stale snapshot, and a saved password
          // must remain recoverable when that happens.
          await this.loadFallback(true)
          this.memory.set(key, value)
          await this.persistFallback().catch(() => {})
          return
        }
        this.noteStoreFailure(new Error('credential store did not retain the value (write-through check failed)'))
        this.log('warn', `[aiterm] credential store lost ${key} after write; keeping a file copy instead`)
      } catch (error) {
        this.noteStoreFailure(error)
      }
    }
    await this.loadFallback()
    if (value.length === 0) this.memory.delete(key)
    else this.memory.set(key, value)
    await this.persistFallback()
  }

  /**
   * Remove a secret.
   * @param {string} ref short reference.
   * @returns {Promise<void>} completion.
   */
  async delete(ref) {
    await this.set(ref, '')
  }

  /**
   * @param {string} ref short reference.
   * @returns {Promise<boolean>} whether a usable secret exists.
   */
  async has(ref) {
    const value = await this.get(ref)
    return typeof value === 'string' && value.length > 0
  }

  /**
   * Whether the credential store is currently degraded (writes fall back to the
   * 0600 file). Surfaces in diagnostics so a broken shared document is visible.
   * @returns {boolean} true when the file fallback is in use.
   */
  get degraded() {
    return this.storeFailed
  }

  /**
   * Persist the fallback map atomically.
   * @returns {Promise<void>} completion.
   */
  async persistFallback() {
    await ensureDir(this.dataDir)
    /** @type {Record<string, string>} */
    const out = {}
    for (const [key, value] of this.memory) out[key] = value
    await writeJsonAtomic(join(this.dataDir, SECRETS_FILE), out)
  }
}


/**
 * Secret access that prefers the Host credential store.
/**
 * @typedef {object} ProfileInfo
 * @property {string} id
 * @property {string} name
 * @property {'ssh' | 'telnet'} transport
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {'password' | 'privateKey' | 'agent' | 'none'} authType
 * @property {boolean} hasPassword
 * @property {boolean} hasPrivateKey
 * @property {boolean} hasPassphrase
 * @property {string} folder grouping label; '' means ungrouped
 * @property {number} order position inside its folder
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @typedef {{ host: string, port: number, username: string, auth: object }} ConnectionTarget */

/**
 * Saved target registry.
 */
export class ProfileStore {
  /**
   * @param {object} options options.
   * @param {string} options.dataDir plugin data directory.
   * @param {SecretStore} options.secrets secret access.
   * @param {(level: string, message: string) => void} options.log logger.
   */
  constructor({ dataDir, secrets, log }) {
    this.file = join(dataDir, PROFILES_FILE)
    this.dataDir = dataDir
    this.secrets = secrets
    this.log = log
    /** @type {ProfileInfo[]} */
    this.profiles = []
    this.loaded = false
    /** @type {Promise<unknown>} */
    this.pending = Promise.resolve()
  }

  /**
   * Read the profile file once.
   * @returns {Promise<void>} completion.
   */
  async load() {
    if (this.loaded) return
    const parsed = await readJsonIfPresent(this.file)
    this.loaded = true
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const list = /** @type {Record<string, unknown>} */ (parsed).profiles
    if (!Array.isArray(list)) return
    /** @type {ProfileInfo[]} */
    const profiles = []
    for (const entry of list) {
      const normalized = normalizeProfile(entry)
      if (normalized === undefined) continue
      profiles.push({
        ...normalized.meta,
        hasPassword: await this.secrets.has(normalized.meta.id),
        hasPrivateKey: await this.secrets.has(`${normalized.meta.id}#key`),
        hasPassphrase: await this.secrets.has(`${normalized.meta.id}#pass`),
      })
    }
    this.profiles = profiles
  }

  /**
   * Persist metadata (secrets are handled separately).
   * @returns {Promise<void>} completion.
   */
  async persist() {
    const plain = this.profiles.map(({ hasPassword, hasPrivateKey, hasPassphrase, ...rest }) => rest)
    await writeJsonAtomic(this.file, { version: 1, profiles: plain })
  }

  /**
   * @returns {Promise<ProfileInfo[]>} saved profiles without secrets.
   */
  async list() {
    await this.load()
    return this.profiles.map((profile) => ({ ...profile }))
  }

  /**
   * Profiles plus a derived folder overview for the management panel.
   * @returns {Promise<{ profiles: ProfileInfo[], folders: Array<{ name: string, count: number }> }>} listing.
   */
  async listWithFolders() {
    const profiles = await this.list()
    /** @type {Map<string, number>} */
    const counts = new Map()
    for (const profile of profiles) {
      const folder = profile.folder ?? ''
      if (folder.length === 0) continue
      counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
    const folders = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { profiles, folders }
  }

  /**
   * Rename a profile's display name. The id never changes: it is part of the
   * credential key, so changing it would orphan the stored password.
   * @param {string} id profile id.
   * @param {unknown} name new display name.
   * @returns {Promise<ProfileInfo>} the updated profile.
   */
  async rename(id, name) {
    await this.load()
    const profile = this.profiles.find((entry) => entry.id === id)
    if (profile === undefined) throw coded('PROFILE_NOT_FOUND', `profile ${id} does not exist`, 404)
    const next = typeof name === 'string' ? normalizeFolder(name) : ''
    if (next.length === 0) throw coded('BAD_NAME', 'a profile name must not be empty', 400)
    profile.name = next.slice(0, 120)
    profile.updatedAt = Date.now()
    await this.persist()
    return { ...profile }
  }

  /**
   * Move a profile into a folder ('' ungroups it).
   * @param {string} id profile id.
   * @param {unknown} folder target folder label.
   * @returns {Promise<ProfileInfo>} the updated profile.
   */
  async setFolder(id, folder) {
    await this.load()
    const profile = this.profiles.find((entry) => entry.id === id)
    if (profile === undefined) throw coded('PROFILE_NOT_FOUND', `profile ${id} does not exist`, 404)
    profile.folder = normalizeFolder(folder)
    profile.updatedAt = Date.now()
    await this.persist()
    return { ...profile }
  }

  /**
   * @param {string} id profile id.
   * @returns {Promise<ProfileInfo | undefined>} one profile.
   */
  async get(id) {
    await this.load()
    const found = this.profiles.find((profile) => profile.id === id)
    return found === undefined ? undefined : { ...found }
  }

  /**
   * Create or update one profile.
   * @param {Record<string, unknown>} input raw profile fields from the UI.
   * @returns {Promise<ProfileInfo>} the saved profile.
   */
  async save(input) {
    await this.load()
    const normalized = normalizeProfile(input)
    if (normalized === undefined) throw coded('BAD_PROFILE', 'invalid profile fields', 400)
    const { meta, password, privateKey, passphrase } = normalized
    const existingIndex = this.profiles.findIndex((profile) => profile.id === meta.id)
    const existing = existingIndex === -1 ? undefined : this.profiles[existingIndex]
    const now = Date.now()
    const createdAt = existingIndex === -1 ? now : existing.createdAt
    // An omitted folder keeps the stored grouping; an explicit '' ungroups.
    /** @type {ProfileInfo} */
    const saved = {
      ...meta,
      folder: typeof input.folder === 'string' ? meta.folder : existing?.folder ?? '',
      order: input.order === undefined ? existing?.order ?? 0 : meta.order,
      createdAt,
      updatedAt: now,
      hasPassword: await this.secrets.has(meta.id),
      hasPrivateKey: await this.secrets.has(`${meta.id}#key`),
      hasPassphrase: await this.secrets.has(`${meta.id}#pass`),
    }
    if (typeof password === 'string') {
      await this.secrets.set(meta.id, password)
      saved.hasPassword = password.length > 0
    }
    if (typeof privateKey === 'string') {
      await this.secrets.set(`${meta.id}#key`, privateKey)
      saved.hasPrivateKey = privateKey.length > 0
    }
    if (typeof passphrase === 'string') {
      await this.secrets.set(`${meta.id}#pass`, passphrase)
      saved.hasPassphrase = passphrase.length > 0
    }
    if (existingIndex === -1) this.profiles.push(saved)
    else this.profiles[existingIndex] = { ...saved, createdAt: this.profiles[existingIndex].createdAt }
    await this.persist()
    return { ...saved }
  }

  /**
   * @param {string} id profile id.
   * @returns {Promise<boolean>} whether a profile was removed.
   */
  async delete(id) {
    await this.load()
    const index = this.profiles.findIndex((profile) => profile.id === id)
    if (index === -1) return false
    this.profiles.splice(index, 1)
    await this.persist()
    await this.secrets.delete(id).catch(() => {})
    await this.secrets.delete(`${id}#key`).catch(() => {})
    await this.secrets.delete(`${id}#pass`).catch(() => {})
    return true
  }

  /**
   * Read one profile's stored secrets without building an auth object.
   *
   * A profile may legitimately have no stored secret (e.g. it was created
   * metadata-only, or the credential store lost it): callers such as
   * `resolveTarget` must be able to fall back to a secret typed into the
   * connect form instead of failing outright.
   *
   * @param {string} id profile id.
   * @returns {Promise<{password?: string, privateKey?: string, passphrase?: string}>} stored secrets.
   */
  async secretsFor(id) {
    const password = await this.secrets.get(id)
    const privateKey = await this.secrets.get(`${id}#key`)
    const passphrase = await this.secrets.get(`${id}#pass`)
    /** @type {{password?: string, privateKey?: string, passphrase?: string}} */
    const out = {}
    if (password !== undefined) out.password = password
    if (privateKey !== undefined) out.privateKey = privateKey
    if (passphrase !== undefined) out.passphrase = passphrase
    return out
  }

  /**
   * Resolve a profile into connection options, including its secrets.
   * @param {string} id profile id.
   * @returns {Promise<ProfileInfo & ConnectionTarget>} profile with auth.
   */
  async connectionFor(id) {
    await this.load()
    const profile = this.profiles.find((entry) => entry.id === id)
    if (profile === undefined) throw coded('PROFILE_NOT_FOUND', `profile ${id} does not exist`, 404)
    const stored = await this.secretsFor(id)
    return {
      ...profile,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      auth: buildAuth(profile.authType, stored.password, stored.privateKey, stored.passphrase),
    }
  }
}

/**
 * Build a transport auth object from a profile's auth type and secrets.
 * @param {ProfileInfo['authType']} authType saved auth type.
 * @param {string | undefined} password stored password.
 * @param {string | undefined} privateKey stored private key.
 * @param {string | undefined} passphrase stored private-key passphrase.
 * @returns {object} transport auth.
 */
export function buildAuth(authType, password, privateKey, passphrase) {
  if (authType === 'password') {
    if (password === undefined) throw coded('MISSING_SECRET', 'this profile has no saved password', 400)
    return { type: 'password', password }
  }
  if (authType === 'privateKey') {
    if (privateKey === undefined) throw coded('MISSING_SECRET', 'this profile has no saved private key', 400)
    return passphrase === undefined
      ? { type: 'privateKey', privateKey }
      : { type: 'privateKey', privateKey, passphrase }
  }
  if (authType === 'agent') return { type: 'agent' }
  return { type: 'none' }
}

/**
 * Normalise a grouping folder label.
 * @param {unknown} value raw label; absent means ungrouped.
 * @returns {string} trimmed label ('' = ungrouped), or '' when unusable.
 */
export function normalizeFolder(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.slice(0, 64)
}

/**
 * Validate and normalise one profile payload.
 * @param {unknown} input raw payload.
 * @returns {{ meta: Omit<ProfileInfo, 'hasPassword' | 'hasPrivateKey' | 'createdAt' | 'updatedAt'>, password?: string, privateKey?: string } | undefined} normalised data.
 */
export function normalizeProfile(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const source = /** @type {Record<string, unknown>} */ (input)
  const transport = source.transport === 'telnet' ? 'telnet' : 'ssh'
  const host = typeof source.host === 'string' ? source.host.trim() : ''
  if (host.length === 0 || host.length > 253 || /[\s/\u0000-\u001f]/.test(host)) return undefined
  const port = source.port === undefined ? (transport === 'telnet' ? 23 : 22) : boundInteger(source.port, transport === 'telnet' ? 23 : 22, 1, 65_535)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const username = typeof source.username === 'string' ? source.username.trim() : ''
  if (username.length > 128 || /[\u0000-\u001f]/.test(username)) return undefined
  if (transport === 'ssh' && username.length === 0) return undefined
  const authType =
    source.authType === 'privateKey' || source.authType === 'agent' || source.authType === 'none'
      ? source.authType
      : 'password'
  const id =
    typeof source.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.id)
      ? source.id
      : `p-${Math.random().toString(36).slice(2, 10)}`
  const name =
    typeof source.name === 'string' && source.name.trim().length > 0
      ? source.name.trim().slice(0, 120)
      : `${username.length > 0 ? `${username}@` : ''}${host}`
  return {
    meta: {
      id,
      name,
      transport,
      host,
      port,
      username,
      authType,
      folder: normalizeFolder(source.folder),
      order: boundInteger(source.order, 0, 0, 1_000_000),
    },
    password: typeof source.password === 'string' && source.password.length <= 4096 ? source.password : undefined,
    privateKey:
      typeof source.privateKey === 'string' && source.privateKey.length > 0 && source.privateKey.length <= 65_536
        ? source.privateKey
        : undefined,
    passphrase:
      typeof source.passphrase === 'string' && source.passphrase.length > 0 && source.passphrase.length <= 1024
        ? source.passphrase
        : undefined,
  }
}
