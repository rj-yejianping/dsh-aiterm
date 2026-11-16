/**
 * Telnet transport adapter (CONTRACTS.md §1).
 *
 * A raw `node:net` socket with a proper Telnet IAC state machine:
 *
 * - `IAC IAC` is un-escaped to a literal 0xFF byte.
 * - `WILL` / `WONT` / `DO` / `DONT` negotiations are answered without loops.
 * - `TERMINAL-TYPE` (24) `SEND` is answered with `IS <term>`.
 * - `NAWS` (31) is negotiated and re-sent on every `resize()`.
 * - `ECHO` (1) and `SUPPRESS-GO-AHEAD` (3) are acknowledged.
 * - every negotiation byte is stripped before `onData` sees the data.
 *
 * Output is decoded with a streaming UTF-8 decoder, so multi-byte characters
 * split across TCP packets are not corrupted. Only `node:net` is imported.
 */

import net from 'node:net'

/** Interpret As Command. */
const IAC = 255
/** Subnegotiation end. */
const SE = 240
/** Subnegotiation begin. */
const SB = 250
/** Will perform option. */
const WILL = 251
/** Won't perform option. */
const WONT = 252
/** Request the peer perform option. */
const DO = 253
/** Request the peer stop performing option. */
const DONT = 254

/** ECHO option. */
const OPT_ECHO = 1
/** SUPPRESS-GO-AHEAD option. */
const OPT_SGA = 3
/** TERMINAL-TYPE option. */
const OPT_TTYPE = 24
/** NAWS (negotiate about window size) option. */
const OPT_NAWS = 31

/** TERMINAL-TYPE SEND subnegotiation verb. */
const TTYPE_SEND = 1
/** TERMINAL-TYPE IS subnegotiation verb. */
const TTYPE_IS = 0

/** Default TCP connect timeout. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Default keepalive interval. */
const DEFAULT_KEEPALIVE_MS = 15_000
/** How long close() waits for the socket to disappear. */
const CLOSE_GRACE_MS = 2_000
/** Default terminal type reported through TERMINAL-TYPE. */
const DEFAULT_TERM = 'xterm-256color'

/**
 * @typedef {object} TelnetConnectOptions
 * @property {string} host remote host.
 * @property {number} port remote port.
 * @property {string} [username] ignored (accepted for interface compatibility).
 * @property {number} cols initial columns.
 * @property {number} rows initial rows.
 * @property {number} [connectTimeoutMs] TCP connect timeout.
 * @property {number} [keepaliveMs] TCP keepalive interval.
 * @property {string} [term] terminal type reported through TERMINAL-TYPE.
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
 * @property {(cols: number, rows: number) => void} resize change window size.
 * @property {(reason?: string) => Promise<void>} close close the transport.
 * @property {'connecting' | 'open' | 'closed'} state transport state.
 */

/**
 * Normalize a dimension into a positive integer.
 *
 * @param {unknown} value candidate value.
 * @param {number} fallback default.
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
 * Clamp a value into the 16-bit range used by NAWS.
 *
 * @param {number} value value to clamp.
 * @returns {number} clamped value.
 */
function uint16(value) {
  return Math.max(0, Math.min(0xffff, Math.floor(value)))
}

/**
 * Resolve the terminal type reported through TERMINAL-TYPE.
 *
 * @param {TelnetConnectOptions} options connect options.
 * @returns {string} terminal type.
 */
function terminalType(options) {
  return options.term ?? DEFAULT_TERM
}

/**
 * One telnet connection.
 *
 * @implements {TransportConnection}
 */
class TelnetConnection {
  /** @type {Promise<{ hostKeyFingerprint?: string, banner?: string }>} */
  #readyPromise
  /** @type {'connecting' | 'open' | 'closed'} */
  #state = 'connecting'
  /** @type {TelnetConnectOptions} */
  #options
  /** @type {TransportHandlers} */
  #handlers
  /** @type {net.Socket | undefined} */
  #socket
  /** @type {TextDecoder} */
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  /** @type {boolean} */
  #closed = false
  /** @type {boolean} */
  #silent = false
  /** @type {Promise<void> | undefined} */
  #closePromise
  /** @type {'data' | 'iac' | 'option' | 'sb' | 'sb-iac'} */
  #parserState = 'data'
  /** @type {number} */
  #pendingVerb = 0
  /** @type {number | null} */
  #subOption = null
  /** @type {number[]} */
  #subBytes = []
  /** @type {Set<number>} options we answered WILL for. */
  #weWill = new Set()
  /** @type {Set<number>} options we answered DO for. */
  #weDo = new Set()
  /** @type {boolean} whether the peer agreed to NAWS. */
  #nawsAgreed = false
  /** @type {(value: { hostKeyFingerprint?: string, banner?: string }) => void} */
  #resolveReady
  /** @type {(error: Error) => void} */
  #rejectReady

  /**
   * @param {TelnetConnectOptions} options normalized options.
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
    ready.catch(() => {})
    this.#readyPromise = ready
  }

  /** Transport kind (read-only). */
  get kind() {
    return 'telnet'
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
   * Open the TCP connection and start negotiation.
   *
   * @returns {Promise<void>} resolves once the socket is connected.
   */
  async open() {
    try {
      const socket = await this.#connectSocket()
      this.#socket = socket
      socket.on('data', (/** @type {Buffer} */ chunk) => this.#receive(chunk))
      socket.on('error', (error) => {
        if (this.#closed) return
        this.#emit('onError', error)
      })
      socket.on('close', (hadError) => {
        if (this.#closed) return
        this.#remoteClosed(hadError)
      })
      socket.setKeepAlive(true, this.#options.keepaliveMs)
      this.#sendInitialNegotiation()
      this.#state = 'open'
      const info = {}
      this.#emit('onReady', info)
      this.#resolveReady(info)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * Send data to the remote host.
   *
   * @param {string | Buffer} data payload.
   * @returns {void}
   */
  write(data) {
    if (this.#state !== 'open' || !this.#socket) {
      throw new Error('telnet transport is not open')
    }
    this.#socket.write(data)
  }

  /**
   * Report a new window size through NAWS.
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
    if (this.#state !== 'open' || !this.#socket) return
    if (!this.#nawsAgreed) return
    this.#sendNaws()
  }

  /**
   * Close the connection. Idempotent; resolves after the socket is gone.
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

    const socket = this.#socket
    if (socket && !socket.destroyed) {
      await new Promise((resolve) => {
        /** @type {NodeJS.Timeout | undefined} */
        let timer
        const done = () => {
          if (timer) clearTimeout(timer)
          resolve(undefined)
        }
        socket.once('close', done)
        timer = setTimeout(done, CLOSE_GRACE_MS)
        try {
          socket.end()
        } catch {
          done()
        }
      })
    }
    try {
      socket?.destroy()
    } catch {
      // Already gone.
    }
    this.#emitRaw('onClose', { reason: reason ?? 'closed' })
  }

  /**
   * Open the TCP socket with a bounded connect timeout.
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
          socket.setTimeout(0)
          resolve(undefined)
        }
        /** @param {Error} error @returns {void} */
        const onError = (error) => {
          cleanup()
          reject(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
        timer = setTimeout(() => {
          // The connect phase must be bounded even when the kernel keeps the
          // SYN pending and no socket event ever fires.
          cleanup()
          socket.destroy()
          const error = new Error(
            `telnet connection to ${options.host}:${options.port} timed out after ${options.connectTimeoutMs}ms`,
          )
          error.code = 'ETIMEDOUT'
          reject(error)
        }, options.connectTimeoutMs)
      })
    } catch (error) {
      socket.destroy()
      throw error
    }
    return socket
  }

  /**
   * Send the client's initial option negotiation.
   *
   * @returns {void}
   */
  #sendInitialNegotiation() {
    // We are willing to send the terminal type, suppress go-ahead and our
    // window size; we ask the server to suppress go-ahead as well.
    this.#weWill.add(OPT_TTYPE)
    this.#weWill.add(OPT_SGA)
    this.#weWill.add(OPT_NAWS)
    this.#send(IAC, WILL, OPT_TTYPE)
    this.#send(IAC, WILL, OPT_SGA)
    this.#send(IAC, WILL, OPT_NAWS)
    this.#weDo.add(OPT_SGA)
    this.#send(IAC, DO, OPT_SGA)
  }

  /**
   * Write raw negotiation bytes.
   *
   * @param {...number} bytes bytes to send.
   * @returns {void}
   */
  #send(...bytes) {
    const socket = this.#socket
    if (!socket || socket.destroyed) return
    try {
      socket.write(Buffer.from(bytes))
    } catch {
      // The socket closed between the state check and the write.
    }
  }

  /**
   * Send a subnegotiation frame.
   *
   * @param {number} option option code.
   * @param {number[] | Buffer} payload payload bytes.
   * @returns {void}
   */
  #sendSubnegotiation(option, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const frame = Buffer.concat([Buffer.from([IAC, SB, option]), body, Buffer.from([IAC, SE])])
    const socket = this.#socket
    if (!socket || socket.destroyed) return
    try {
      socket.write(frame)
    } catch {
      // The socket closed between the state check and the write.
    }
  }

  /**
   * Report the current window size through NAWS.
   *
   * @returns {void}
   */
  #sendNaws() {
    const cols = uint16(this.#options.cols)
    const rows = uint16(this.#options.rows)
    this.#sendSubnegotiation(OPT_NAWS, [
      (cols >> 8) & 0xff,
      cols & 0xff,
      (rows >> 8) & 0xff,
      rows & 0xff,
    ])
  }

  /**
   * Feed one TCP chunk through the telnet parser.
   *
   * @param {Buffer} chunk received bytes.
   * @returns {void}
   */
  #receive(chunk) {
    if (this.#closed) return
    /** @type {number[]} */
    const dataBytes = []

    for (const byte of chunk) {
      switch (this.#parserState) {
        case 'iac':
          if (byte === IAC) {
            dataBytes.push(IAC)
            this.#parserState = 'data'
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.#pendingVerb = byte
            this.#parserState = 'option'
          } else if (byte === SB) {
            this.#subOption = null
            this.#subBytes = []
            this.#parserState = 'sb'
          } else {
            // Two-byte command (NOP, GA, AYT, ...) — nothing to answer.
            this.#parserState = 'data'
          }
          break
        case 'option': {
          const verb = this.#pendingVerb
          this.#parserState = 'data'
          this.#handleNegotiation(verb, byte)
          break
        }
        case 'sb':
          if (byte === IAC) {
            this.#parserState = 'sb-iac'
          } else if (this.#subOption === null) {
            this.#subOption = byte
          } else {
            this.#subBytes.push(byte)
          }
          break
        case 'sb-iac':
          if (byte === SE) {
            const option = this.#subOption
            const payload = this.#subBytes
            this.#subOption = null
            this.#subBytes = []
            this.#parserState = 'data'
            if (option !== null) this.#handleSubnegotiation(option, payload)
          } else if (byte === IAC) {
            this.#subBytes.push(IAC)
            this.#parserState = 'sb'
          } else {
            this.#parserState = 'sb'
          }
          break
        default:
          if (byte === IAC) {
            this.#parserState = 'iac'
          } else {
            dataBytes.push(byte)
          }
          break
      }
    }

    if (dataBytes.length === 0) return
    const text = this.#decoder.decode(Buffer.from(dataBytes), { stream: true })
    if (text !== '') this.#emit('onData', text)
  }

  /**
   * Answer one WILL/WONT/DO/DONT negotiation.
   *
   * @param {number} verb negotiation verb.
   * @param {number} option option code.
   * @returns {void}
   */
  #handleNegotiation(verb, option) {
    switch (verb) {
      case DO: {
        if (option === OPT_TTYPE || option === OPT_SGA || option === OPT_NAWS) {
          if (!this.#weWill.has(option)) {
            this.#weWill.add(option)
            this.#send(IAC, WILL, option)
          }
          if (option === OPT_NAWS && !this.#nawsAgreed) {
            this.#nawsAgreed = true
            this.#sendNaws()
          }
        } else if (this.#weWill.has(option)) {
          this.#weWill.delete(option)
          this.#send(IAC, WONT, option)
        } else {
          this.#send(IAC, WONT, option)
        }
        return
      }
      case DONT: {
        if (this.#weWill.has(option)) {
          this.#weWill.delete(option)
          if (option === OPT_NAWS) this.#nawsAgreed = false
          this.#send(IAC, WONT, option)
        }
        return
      }
      case WILL: {
        if (option === OPT_ECHO || option === OPT_SGA) {
          if (!this.#weDo.has(option)) {
            this.#weDo.add(option)
            this.#send(IAC, DO, option)
          }
        } else if (this.#weDo.has(option)) {
          this.#weDo.delete(option)
          this.#send(IAC, DONT, option)
        } else {
          this.#send(IAC, DONT, option)
        }
        return
      }
      case WONT: {
        if (this.#weDo.has(option)) {
          this.#weDo.delete(option)
          this.#send(IAC, DONT, option)
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Answer a subnegotiation frame.
   *
   * @param {number} option option code.
   * @param {number[]} payload subnegotiation payload.
   * @returns {void}
   */
  #handleSubnegotiation(option, payload) {
    if (option === OPT_TTYPE && payload[0] === TTYPE_SEND) {
      const type = Buffer.from(terminalType(this.#options), 'utf8')
      this.#sendSubnegotiation(OPT_TTYPE, [TTYPE_IS, ...type])
    }
  }

  /**
   * Handle a remote-initiated close.
   *
   * @param {boolean} hadError whether the socket reported an error.
   * @returns {void}
   */
  #remoteClosed(hadError) {
    if (this.#closed) return
    this.#closed = true
    this.#state = 'closed'
    const tail = this.#decoder.decode()
    if (tail !== '' && !this.#silent) this.#emit('onData', tail)
    this.#silent = true
    try {
      this.#socket?.destroy()
    } catch {
      // Ignore.
    }
    this.#emitRaw('onClose', { reason: hadError ? 'connection error' : 'connection closed' })
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
      this.#socket?.destroy()
    } catch {
      // Ignore.
    }
    this.#rejectReady(error)
    this.#emitRaw('onError', error)
    this.#silent = true
    this.#emitRaw('onClose', { reason: error.message })
  }

  /**
   * Emit one handler event, swallowing handler errors.
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
   * Emit an event even after `#silent` was set.
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
}

/**
 * Normalize and validate telnet connect options.
 *
 * @param {TelnetConnectOptions} options raw options.
 * @returns {TelnetConnectOptions} normalized options.
 */
function normalizeOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('telnet connect options are required')
  if (typeof options.host !== 'string' || options.host.trim() === '') {
    throw new Error('telnet connect requires a host')
  }
  const port = Number(options.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('telnet connect requires a valid port')
  }
  return {
    host: options.host.trim(),
    port,
    username: typeof options.username === 'string' ? options.username : undefined,
    cols: dimension(options.cols, 80, 2),
    rows: dimension(options.rows, 24, 1),
    connectTimeoutMs: duration(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    keepaliveMs: duration(options.keepaliveMs, DEFAULT_KEEPALIVE_MS),
    term: typeof options.term === 'string' && options.term !== '' ? options.term : DEFAULT_TERM,
  }
}

/**
 * Connect to a telnet server.
 *
 * @param {TelnetConnectOptions} options connection options.
 * @param {TransportHandlers} handlers event handlers.
 * @returns {Promise<TransportConnection>} the opened transport.
 */
export async function connect(options, handlers) {
  const config = normalizeOptions(options)
  const events = handlers ?? {}
  if (typeof events.onData !== 'function') {
    throw new TypeError('telnet connect requires handlers.onData')
  }
  const connection = new TelnetConnection(config, events)
  await connection.open()
  return connection
}
