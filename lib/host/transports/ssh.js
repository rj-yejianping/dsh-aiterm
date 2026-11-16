/**
 * SSH transport adapter (CONTRACTS.md §1).
 *
 * One instance wraps one ssh2 `Client` plus the interactive shell channel that
 * carries the remote pty. `onData` receives UTF-8 text in arrival order;
 * `resize()` forwards a window-change request; `close()` is idempotent and
 * event-silent once it resolves.
 *
 * Host key handling implements `accept-new`, `strict` and `insecure` against a
 * small known_hosts parser (plain, wildcard and OpenSSH hashed host entries).
 * The file is only touched for the two verifying policies: a missing
 * known_hosts file is created with mode 0600 for `accept-new`.
 *
 * Only Node builtins and `ssh2` are imported here.
 */

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import ssh2 from '../../../vendor/ssh2.cjs'

const { Client } = ssh2

/** Default TCP connect timeout. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Default SSH handshake / shell timeout. */
const DEFAULT_READY_TIMEOUT_MS = 20_000
/** Default keepalive interval. */
const DEFAULT_KEEPALIVE_MS = 15_000
/** How long close() waits for the channel/socket to disappear. */
const CLOSE_GRACE_MS = 2_000
/** Default terminal type requested for the pty. */
const DEFAULT_TERM = 'xterm-256color'

/**
 * @typedef {object} SshAuth
 * @property {'password'} type password auth.
 * @property {string} password password value.
 *
 * @typedef {object} SshKeyAuth
 * @property {'privateKey'} type private-key auth.
 * @property {string} privateKey PEM/OpenSSH private key contents.
 * @property {string} [passphrase] passphrase for the key.
 *
 * @typedef {object} SshAgentAuth
 * @property {'agent'} type ssh-agent auth (uses SSH_AUTH_SOCK).
 *
 * @typedef {object} SshNoneAuth
 * @property {'none'} type no authentication.
 */

/**
 * @typedef {object} SshConnectOptions
 * @property {string} host remote host.
 * @property {number} port remote port.
 * @property {string} [username] remote user.
 * @property {SshAuth | SshKeyAuth | SshAgentAuth | SshNoneAuth} [auth] auth method.
 * @property {number} cols pty columns.
 * @property {number} rows pty rows.
 * @property {number} [connectTimeoutMs] TCP connect timeout.
 * @property {number} [readyTimeoutMs] SSH handshake / shell timeout.
 * @property {number} [keepaliveMs] keepalive interval.
 * @property {'accept-new' | 'strict' | 'insecure'} [hostKeyPolicy] host key policy.
 * @property {string} [knownHostsPath] known_hosts file location.
 * @property {string} [term] TERM value for the pty.
 */

/**
 * @typedef {object} TransportHandlers
 * @property {(chunk: string) => void} onData decoded output.
 * @property {(info: { hostKeyFingerprint?: string, banner?: string }) => void} [onReady] connection ready.
 * @property {(info: { code?: number | null, signal?: string, reason?: string }) => void} [onClose] connection closed.
 * @property {(error: Error) => void} [onError] connection-level failure.
 */

/**
 * @typedef {object} TransportConnection
 * @property {'ssh' | 'telnet'} kind transport kind.
 * @property {Promise<{ hostKeyFingerprint?: string, banner?: string }>} ready ready promise.
 * @property {(data: string | Buffer) => void} write send data.
 * @property {(cols: number, rows: number) => void} resize change pty size.
 * @property {(reason?: string) => Promise<void>} close close the transport.
 * @property {'connecting' | 'open' | 'closed'} state transport state.
 */

/**
 * Clamp a dimension to a positive integer.
 *
 * @param {unknown} value candidate value.
 * @param {number} fallback value used when unusable.
 * @param {number} minimum smallest allowed value.
 * @returns {number} normalized dimension.
 */
function dimension(value, fallback, minimum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.floor(number))
}

/**
 * Positive milliseconds option with a default.
 *
 * @param {unknown} value candidate value.
 * @param {number} fallback default.
 * @returns {number} normalized duration.
 */
function duration(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.floor(number)
}

/**
 * Create an Error that keeps the original failure reachable.
 *
 * @param {string} message human readable message.
 * @param {unknown} [cause] original error.
 * @param {string} [code] optional error code.
 * @returns {Error} new error.
 */
function transportError(message, cause, code) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  if (code !== undefined) error.code = code
  return error
}

/**
 * Resolve the default known_hosts path (`<dataDir>/known_hosts`).
 *
 * @returns {string} absolute path.
 */
function defaultKnownHostsPath() {
  return path.join(os.homedir(), '.dsh', 'aiterm', 'known_hosts')
}

/**
 * Extract the key algorithm and base64 blob from a raw SSH host key.
 *
 * @param {Buffer} key raw SSH host key blob.
 * @returns {{ algorithm: string, base64: string }} parsed key.
 */
function parseKeyBlob(key) {
  if (!Buffer.isBuffer(key) || key.length < 8) {
    throw new Error('invalid SSH host key')
  }
  const length = key.readUInt32BE(0)
  if (length <= 0 || length > key.length - 4) {
    throw new Error('invalid SSH host key algorithm')
  }
  const algorithm = key.subarray(4, 4 + length).toString('ascii')
  if (!/^[a-z0-9@.-]+$/i.test(algorithm)) {
    throw new Error('invalid SSH host key algorithm')
  }
  return { algorithm, base64: key.toString('base64') }
}

/**
 * OpenSSH-style SHA256 fingerprint of a raw host key.
 *
 * @param {Buffer} key raw SSH host key blob.
 * @returns {string} `SHA256:<base64>` fingerprint.
 */
function hostKeyFingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/**
 * The hostname token used in known_hosts for a target.
 *
 * @param {string} host remote host.
 * @param {number} port remote port.
 * @returns {string} `host` for port 22, otherwise `[host]:port`.
 */
function knownHostsToken(host, port) {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * Test one known_hosts hostname pattern against a target token.
 *
 * Supports comma-separated lists, `*`/`?` wildcards and OpenSSH `|1|` hashed
 * entries (SHA-1 HMAC with the entry salt). `!` negations are honoured: a
 * matching negation makes the entry not apply.
 *
 * @param {string} field hostname field of a known_hosts line.
 * @param {string} token target hostname token.
 * @returns {boolean} whether the entry applies to the target.
 */
function hostFieldMatches(field, token) {
  if (field.startsWith('|1|')) {
    const parts = field.split('|')
    if (parts.length !== 4) return false
    const salt = Buffer.from(parts[2], 'base64')
    const expected = parts[3]
    if (salt.length === 0 || expected === '') return false
    const hash = createHash('sha1').update(salt).update(token).digest('base64')
    return hash === expected
  }

  let matched = false
  for (const rawPattern of field.split(',')) {
    if (rawPattern === '') continue
    const negated = rawPattern.startsWith('!')
    const pattern = negated ? rawPattern.slice(1) : rawPattern
    if (!pattern) continue
    if (wildcardMatches(pattern, token)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

/**
 * Case-insensitive glob match for known_hosts hostname patterns.
 *
 * @param {string} pattern pattern with `*` / `?`.
 * @param {string} value value to match.
 * @returns {boolean} whether the pattern matches.
 */
function wildcardMatches(pattern, value) {
  if (pattern === value) return true
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern.toLowerCase() === value.toLowerCase()
  }
  let source = '^'
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  source += '$'
  try {
    return new RegExp(source, 'iu').test(value)
  } catch {
    return false
  }
}

/**
 * Find all usable known_hosts entries for a target.
 *
 * @param {string} contents known_hosts file contents.
 * @param {string} token target hostname token.
 * @returns {{ algorithm: string, base64: string }[]} matching key entries.
 */
function findKnownHostEntries(contents, token) {
  /** @type {{ algorithm: string, base64: string }[]} */
  const entries = []
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('@')) continue // @cert-authority / @revoked
    const fields = line.split(/\s+/u)
    if (fields.length < 3) continue
    const [hostField, algorithm, key] = fields
    if (!hostFieldMatches(hostField, token)) continue
    if (!/^[A-Za-z0-9+/=]+$/u.test(key)) continue
    entries.push({ algorithm, base64: key })
  }
  return entries
}

/**
 * Read a known_hosts file, treating a missing file as empty.
 *
 * @param {string} filePath known_hosts path.
 * @returns {Promise<string>} file contents.
 */
async function readKnownHosts(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return ''
    throw transportError(`cannot read known_hosts file ${filePath}`, error)
  }
}

/**
 * Ensure the known_hosts directory and file exist (file mode 0600).
 *
 * @param {string} filePath known_hosts path.
 * @returns {Promise<void>} resolves once the file exists.
 */
async function ensureKnownHostsFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const handle = await fs.open(filePath, 'a', 0o600)
  await handle.close()
  try {
    const stats = await fs.stat(filePath)
    if ((stats.mode & 0o777) !== 0o600) await fs.chmod(filePath, 0o600)
  } catch {
    // Best effort only.
  }
}

/**
 * Append one new host key to known_hosts.
 *
 * @param {string} filePath known_hosts path.
 * @param {string} token target hostname token.
 * @param {{ algorithm: string, base64: string }} entry key entry.
 * @returns {Promise<void>} resolves once written.
 */
async function appendKnownHost(filePath, token, entry) {
  await ensureKnownHostsFile(filePath)
  await fs.appendFile(filePath, `${token} ${entry.algorithm} ${entry.base64}\n`, { mode: 0o600 })
}

/**
 * Build the ssh2 connect configuration for an auth descriptor.
 *
 * @param {SshConnectOptions['auth']} auth auth descriptor.
 * @returns {Record<string, unknown>} ssh2 auth fields.
 */
function authFields(auth) {
  const descriptor = auth ?? { type: 'none' }
  switch (descriptor.type) {
    case 'password': {
      if (typeof descriptor.password !== 'string') {
        throw new Error('SSH password auth requires a string password')
      }
      return { password: descriptor.password }
    }
    case 'privateKey': {
      if (typeof descriptor.privateKey !== 'string' || descriptor.privateKey === '') {
        throw new Error('SSH private-key auth requires privateKey contents')
      }
      /** @type {Record<string, unknown>} */
      const fields = { privateKey: descriptor.privateKey }
      if (typeof descriptor.passphrase === 'string' && descriptor.passphrase !== '') {
        fields.passphrase = descriptor.passphrase
      }
      return fields
    }
    case 'agent': {
      const agent = process.env.SSH_AUTH_SOCK
      if (typeof agent !== 'string' || agent === '') {
        throw new Error('SSH agent auth requested but SSH_AUTH_SOCK is not set')
      }
      return { agent }
    }
    case 'none':
      return {}
    default:
      throw new Error(`unsupported SSH auth type: ${String(/** @type {any} */ (descriptor).type)}`)
  }
}

/**
 * One SSH connection.
 *
 * @implements {TransportConnection}
 */
class SshConnection {
  /** @type {Promise<{ hostKeyFingerprint?: string, banner?: string }>} */
  #readyPromise
  /** @type {'connecting' | 'open' | 'closed'} */
  #state = 'connecting'
  /** @type {SshConnectOptions} */
  #options
  /** @type {TransportHandlers} */
  #handlers
  /** @type {any} */
  #client
  /** @type {net.Socket | undefined} */
  #socket
  /** @type {any} */
  #channel
  /** @type {TextDecoder} */
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  /** @type {boolean} */
  #closed = false
  /** @type {boolean} */
  #silent = false
  /** @type {Promise<void> | undefined} */
  #closePromise
  /** @type {string | undefined} */
  #hostKeyFingerprint
  /** @type {string | undefined} */
  #banner
  /** @type {string | undefined} */
  #verificationReason
  /** @type {{ token: string, entry: { algorithm: string, base64: string } } | undefined} */
  #pendingKnownHost
  /** @type {(value: { hostKeyFingerprint?: string, banner?: string }) => void} */
  #resolveReady
  /** @type {(error: Error) => void} */
  #rejectReady

  /**
   * @param {SshConnectOptions} options normalized options.
   * @param {TransportHandlers} handlers event handlers.
   */
  constructor(options, handlers) {
    this.#options = options
    this.#handlers = handlers
    /** @type {Promise<{ hostKeyFingerprint?: string, banner?: string }>} */
    const ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    // Avoid an unhandled rejection when the caller never observes `ready`
    // (connect() also rejects on failure).
    ready.catch(() => {})
    this.#readyPromise = ready
  }

  /** Transport kind (read-only). */
  get kind() {
    return 'ssh'
  }

  /** Ready promise (read-only). */
  get ready() {
    return this.#readyPromise
  }

  /** Current transport state. */
  get state() {
    return this.#state
  }

  /**
   * Establish TCP, SSH and the interactive shell, then resolve the returned
   * `ready` promise. Rejects (and rejects `ready`) on any failure.
   *
   * @returns {Promise<void>} resolves once the transport is open.
   */
  async open() {
    try {
      await this.#establish()
      this.#state = 'open'
      const info = { hostKeyFingerprint: this.#hostKeyFingerprint, banner: this.#banner }
      this.#emit('onReady', info)
      this.#resolveReady(info)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * Send data to the remote pty.
   *
   * @param {string | Buffer} data payload.
   * @returns {void}
   */
  write(data) {
    if (this.#state !== 'open' || !this.#channel) {
      throw new Error('SSH transport is not open')
    }
    this.#channel.write(data)
  }

  /**
   * Forward a terminal resize as a window-change request.
   *
   * @param {number} cols new columns.
   * @param {number} rows new rows.
   * @returns {void}
   */
  resize(cols, rows) {
    const width = dimension(cols, this.#options.cols, 2)
    const height = dimension(rows, this.#options.rows, 1)
    this.#options.cols = width
    this.#options.rows = height
    if (this.#state !== 'open' || !this.#channel) return
    try {
      // ssh2 order: rows, cols, height, width.
      this.#channel.setWindow(height, width, 0, 0)
    } catch {
      // The channel may have just closed; resize is best effort.
    }
  }

  /**
   * Close the connection. Idempotent; resolves after the channel/socket is
   * gone. No handler is invoked after it resolves.
   *
   * @param {string} [reason] close reason for `onClose`.
   * @returns {Promise<void>} resolves once closed.
   */
  close(reason) {
    if (this.#closePromise) return this.#closePromise
    this.#closePromise = this.#close(reason)
    return this.#closePromise
  }

  /**
   * Implementation of close().
   *
   * @param {string} [reason] close reason.
   * @returns {Promise<void>} resolves once closed.
   */
  async #close(reason) {
    if (this.#closed) {
      this.#silent = true
      return
    }
    this.#closed = true
    this.#state = 'closed'
    this.#silent = true

    const graceful = new Promise((resolve) => {
      const client = this.#client
      if (!client) {
        resolve(undefined)
        return
      }
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      const done = () => {
        if (timer) clearTimeout(timer)
        resolve(undefined)
      }
      try {
        client.once('close', done)
      } catch {
        resolve(undefined)
        return
      }
      timer = setTimeout(done, CLOSE_GRACE_MS)
    })

    try {
      this.#channel?.end()
    } catch {
      // Already gone.
    }
    try {
      this.#client?.end()
    } catch {
      // Already gone.
    }

    await graceful
    try {
      this.#channel?.destroy()
    } catch {
      // Already gone.
    }
    try {
      this.#client?.destroy()
    } catch {
      // Already gone.
    }
    try {
      this.#socket?.destroy()
    } catch {
      // Already gone.
    }
    this.#emitRaw('onClose', { reason: reason ?? 'closed' })
  }

  /**
   * Establish the full connection: TCP, handshake and shell.
   *
   * @returns {Promise<void>} resolves when the shell channel is open.
   */
  async #establish() {
    const options = this.#options
    const policy = options.hostKeyPolicy

    let knownHostsContents = ''
    if (policy !== 'insecure') {
      knownHostsContents = await readKnownHosts(options.knownHostsPath)
    }

    const socket = await this.#connectSocket()
    this.#socket = socket

    const client = new Client()
    this.#client = client

    const auth = authFields(options.auth)
    const token = knownHostsToken(options.host, options.port)

    const connected = new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout | undefined} */
      let handshakeTimer

      const cleanupTimers = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer)
      }

      client.on('banner', (message) => {
        if (typeof message === 'string') this.#banner = message
      })

      client.once('ready', () => {
        cleanupTimers()
        resolve(undefined)
      })

      client.on('error', (error) => {
        if (this.#closed) return
        cleanupTimers()
        reject(this.#describeError(error))
      })

      client.once('close', () => {
        cleanupTimers()
        if (!this.#closed) {
          reject(transportError('SSH connection closed before it was ready', undefined, 'ECONNRESET'))
        }
      })

      handshakeTimer = setTimeout(() => {
        reject(transportError(`SSH handshake timed out after ${options.readyTimeoutMs}ms`, undefined, 'ETIMEDOUT'))
        try {
          client.destroy()
        } catch {
          // Ignore.
        }
      }, options.readyTimeoutMs)


      try {
        client.connect({
          sock: socket,
          host: options.host,
          port: options.port,
          username: options.username,
          readyTimeout: options.readyTimeoutMs,
          keepaliveInterval: options.keepaliveMs,
          keepaliveCountMax: 3,
          hostVerifier: (key) => this.#verifyHostKey(key, token, knownHostsContents),
          ...auth,
        })
      } catch (error) {
        cleanupTimers()
        reject(this.#describeError(error))
      }
    })

    try {
      await connected
    } catch (error) {
      try {
        client.destroy()
      } catch {
        // Ignore.
      }
      throw error
    }

    // accept-new: remember the key that passed verification and persist it
    // before reporting the connection as ready, so callers can rely on it.
    if (this.#pendingKnownHost) {
      const pending = this.#pendingKnownHost
      await appendKnownHost(options.knownHostsPath, pending.token, pending.entry)
      this.#pendingKnownHost = undefined
    }

    const channel = await this.#openShell(client)
    this.#channel = channel

    client.once('close', (hadError) => {
      if (this.#closed) return
      void this.#remoteClosed(hadError)
    })

    client.on('error', (error) => {
      if (this.#closed) return
      this.#emit('onError', this.#describeError(error))
    })
  }

  /**
   * Open a TCP socket with a bounded connect timeout.
   *
   * @returns {Promise<net.Socket>} connected socket.
   */
  async #connectSocket() {
    const options = this.#options
    /** @type {net.Socket} */
    const socket = net.connect({ host: options.host, port: options.port })
    socket.setNoDelay?.(true)
    try {
      await new Promise((resolve, reject) => {
        /** @type {NodeJS.Timeout | undefined} */
        let timer
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          socket.removeListener('connect', onConnect)
          socket.removeListener('error', onError)
        }
        /** @returns {void} */
        const onConnect = () => {
          cleanup()
          resolve(undefined)
        }
        /** @param {Error} error @returns {void} */
        const onError = (error) => {
          cleanup()
          reject(transportError(`SSH TCP connection to ${options.host}:${options.port} failed: ${error.message}`, error))
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
        timer = setTimeout(() => {
          cleanup()
          socket.destroy()
          reject(transportError(
            `SSH TCP connection to ${options.host}:${options.port} timed out after ${options.connectTimeoutMs}ms`,
            undefined,
            'ETIMEDOUT',
          ))
        }, options.connectTimeoutMs)
      })
    } catch (error) {
      socket.destroy()
      throw error
    }
    socket.on('error', () => {
      // ssh2 forwards socket errors through the Client; keep this listener so
      // a socket error after connect is never an unhandled 'error' event.
    })
    return socket
  }

  /**
   * Verify the remote host key according to the configured policy.
   *
   * @param {Buffer} key raw host key blob.
   * @param {string} token known_hosts hostname token.
   * @param {string} knownHostsContents known_hosts contents (verifying policies).
   * @returns {boolean} whether the key is accepted.
   */
  #verifyHostKey(key, token, knownHostsContents) {
    const options = this.#options
    try {
      const parsed = parseKeyBlob(key)
      this.#hostKeyFingerprint = hostKeyFingerprint(key)

      if (options.hostKeyPolicy === 'insecure') return true

      const entries = findKnownHostEntries(knownHostsContents, token)
      const sameType = entries.filter((entry) => entry.algorithm === parsed.algorithm)
      if (sameType.length === 0) {
        if (options.hostKeyPolicy === 'strict') {
          this.#verificationReason = entries.length === 0
            ? `host key for ${token} is not present in ${options.knownHostsPath}`
            : `host key type ${parsed.algorithm} for ${token} is not present in ${options.knownHostsPath}`
          return false
        }
        // accept-new: unknown host (or unknown key type for a known host) is
        // remembered, matching OpenSSH's StrictHostKeyChecking=accept-new.
        this.#pendingKnownHost = { token, entry: parsed }
        return true
      }
      if (sameType.some((entry) => entry.base64 === parsed.base64)) return true
      this.#verificationReason = `host key mismatch for ${token} (possible man-in-the-middle attack)`
      return false
    } catch (error) {
      this.#verificationReason = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /**
   * Open the interactive shell channel with a pty.
   *
   * @param {any} client ssh2 client.
   * @returns {Promise<any>} shell channel.
   */
  async #openShell(client) {
    const options = this.#options
    const channel = await new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout} */
      const timer = setTimeout(() => {
        reject(transportError(`SSH shell request timed out after ${options.readyTimeoutMs}ms`, undefined, 'ETIMEDOUT'))
      }, options.readyTimeoutMs)
      try {
        client.shell({ term: options.term, cols: options.cols, rows: options.rows }, (error, stream) => {
          clearTimeout(timer)
          if (error) reject(transportError(`SSH shell request failed: ${error.message}`, error))
          else resolve(stream)
        })
      } catch (error) {
        clearTimeout(timer)
        reject(this.#describeError(error))
      }
    })

    channel.on('data', (/** @type {Buffer} */ chunk) => {
      if (this.#silent) return
      const text = this.#decoder.decode(chunk, { stream: true })
      if (text !== '') this.#emit('onData', text)
    })
    channel.stderr?.on?.('data', (/** @type {Buffer} */ chunk) => {
      // Merge stderr into the same stream: an interactive pty usually has
      // none, but if the server sends it we must not lose output.
      if (this.#silent) return
      const text = this.#decoder.decode(chunk, { stream: true })
      if (text !== '') this.#emit('onData', text)
    })
    channel.on('close', () => {
      if (this.#closed) return
      void this.#remoteClosed(false)
    })
    channel.on('error', (error) => {
      if (this.#closed) return
      this.#emit('onError', this.#describeError(error))
    })
    return channel
  }

  /**
   * Handle a remote-initiated close.
   *
   * @param {boolean | undefined} hadError whether the client reported an error.
   * @returns {Promise<void>} resolves after cleanup.
   */
  async #remoteClosed(hadError) {
    if (this.#closed) return
    this.#closed = true
    this.#state = 'closed'
    const tail = this.#decoder.decode()
    if (tail !== '' && !this.#silent) this.#emit('onData', tail)
    this.#silent = true
    try {
      this.#client?.end()
    } catch {
      // Ignore.
    }
    try {
      this.#socket?.destroy()
    } catch {
      // Ignore.
    }
    this.#emitRaw('onClose', { reason: hadError ? 'connection error' : 'connection closed' })
  }

  /**
   * Render a connection failure into a stable Error.
   *
   * @param {unknown} error original error.
   * @returns {Error} normalized error.
   */
  #describeError(error) {
    const original = error instanceof Error ? error : new Error(String(error))
    if (this.#verificationReason) {
      return transportError(`SSH host key verification failed: ${this.#verificationReason}`, original)
    }
    const code = /** @type {NodeJS.ErrnoException} */ (original).code
    const message = code ? `SSH connection failed (${code}): ${original.message}` : `SSH connection failed: ${original.message}`
    return transportError(message, original, typeof code === 'string' ? code : undefined)
  }

  /**
   * Emit one handler event, swallowing handler errors so a broken consumer
   * cannot take down the transport.
   *
   * @param {'onData' | 'onReady' | 'onClose' | 'onError'} name handler name.
   * @param {any} payload event payload.
   * @returns {void}
   */
  #emit(name, payload) {
    if (this.#silent && name !== 'onClose' && name !== 'onError') return
    const handler = this.#handlers[name]
    if (typeof handler !== 'function') return
    try {
      handler(payload)
    } catch {
      // Consumer errors must not break the transport.
    }
  }

  /**
   * Emit a close/error event even after `#silent` was set (used by the final
   * close notification).
   *
   * @param {'onClose' | 'onError'} name handler name.
   * @param {any} payload event payload.
   * @returns {void}
   */
  #emitRaw(name, payload) {
    const handler = this.#handlers[name]
    if (typeof handler !== 'function') return
    try {
      handler(payload)
    } catch {
      // Consumer errors must not break the transport.
    }
  }

  /**
   * Fail a connection that never became ready.
   *
   * @param {Error} error failure reason.
   * @returns {void}
   */
  #fail(error) {
    if (this.#closed) return
    this.#closed = true
    this.#state = 'closed'
    try {
      this.#channel?.destroy()
    } catch {
      // Ignore.
    }
    try {
      this.#client?.destroy()
    } catch {
      // Ignore.
    }
    try {
      this.#socket?.destroy()
    } catch {
      // Ignore.
    }
    this.#rejectReady(error)
    this.#emitRaw('onError', error)
    this.#silent = true
    this.#emitRaw('onClose', { reason: error.message })
  }
}

/**
 * Normalize and validate SSH connect options.
 *
 * @param {SshConnectOptions} options raw options.
 * @returns {SshConnectOptions} normalized options.
 */
function normalizeOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('SSH connect options are required')
  if (typeof options.host !== 'string' || options.host.trim() === '') {
    throw new Error('SSH connect requires a host')
  }
  const port = Number(options.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SSH connect requires a valid port')
  }
  if (options.hostKeyPolicy !== undefined
    && options.hostKeyPolicy !== 'accept-new'
    && options.hostKeyPolicy !== 'strict'
    && options.hostKeyPolicy !== 'insecure') {
    throw new Error(`invalid SSH host key policy: ${String(options.hostKeyPolicy)}`)
  }

  return {
    host: options.host.trim(),
    port,
    username: typeof options.username === 'string' && options.username !== ''
      ? options.username
      : os.userInfo().username,
    auth: options.auth ?? { type: 'none' },
    cols: dimension(options.cols, 80, 2),
    rows: dimension(options.rows, 24, 1),
    connectTimeoutMs: duration(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    readyTimeoutMs: duration(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS),
    keepaliveMs: duration(options.keepaliveMs, DEFAULT_KEEPALIVE_MS),
    hostKeyPolicy: options.hostKeyPolicy ?? 'accept-new',
    knownHostsPath: typeof options.knownHostsPath === 'string' && options.knownHostsPath !== ''
      ? options.knownHostsPath
      : defaultKnownHostsPath(),
    term: typeof options.term === 'string' && options.term !== '' ? options.term : DEFAULT_TERM,
  }
}

/**
 * Connect to an SSH server and open an interactive shell.
 *
 * @param {SshConnectOptions} options connection options.
 * @param {TransportHandlers} handlers event handlers.
 * @returns {Promise<TransportConnection>} the opened transport.
 */
export async function connect(options, handlers) {
  const config = normalizeOptions(options)
  const events = handlers ?? {}
  if (typeof events.onData !== 'function') {
    throw new TypeError('SSH connect requires handlers.onData')
  }
  const connection = new SshConnection(config, events)
  await connection.open()
  return connection
}
