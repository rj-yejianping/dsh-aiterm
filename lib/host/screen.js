/**
 * Terminal screen emulator for one remote session.
 *
 * The primary implementation is backed by `@xterm/headless` (a headless
 * xterm.js terminal) plus `@xterm/addon-serialize`, so the ANSI stream from a
 * remote pty is interpreted exactly like the browser's xterm.js would. Both
 * packages are CommonJS and are loaded lazily through `createRequire()` so the
 * host half never has to resolve `@deepseek-ai/*` modules and pays nothing
 * until a screen is created.
 *
 * If those packages cannot be loaded (missing install, broken build), the
 * class silently falls back to a small internal ANSI-aware line buffer so the
 * plugin keeps working. The fallback understands the subset of escape
 * sequences that matters for reading output (SGR colours are stripped, cursor
 * addressing, erasing, scrolling and the alternate screen are honoured).
 *
 * The public API is intentionally synchronous and matches CONTRACTS.md §2:
 * `write()` must be observable by `text()` immediately afterwards, which is
 * why the emulator is driven through xterm's synchronous parse path
 * (`CoreTerminal#writeSync`) when available. The fallback path uses the public
 * asynchronous `write()` only if that internal API disappears.
 */

import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)

/** Default retained scrollback rows. */
const DEFAULT_SCROLLBACK = 4000

/** @type {{ Terminal: any, SerializeAddon: any } | null | undefined} */
let cachedModules

/**
 * Load the CommonJS xterm packages once.
 *
 * @returns {{ Terminal: any, SerializeAddon: any } | null} Constructors, or
 *   `null` when the packages are not usable and the fallback must be used.
 */
function loadXtermModules() {
  if (cachedModules !== undefined) return cachedModules
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const headless = requireFromHere('@xterm/headless')
    const serialize = requireFromHere('@xterm/addon-serialize')
    const Terminal = headless?.Terminal ?? headless?.default?.Terminal
    const SerializeAddon = serialize?.SerializeAddon ?? serialize?.default?.SerializeAddon
    if (typeof Terminal !== 'function' || typeof SerializeAddon !== 'function') {
      cachedModules = null
    } else {
      cachedModules = { Terminal, SerializeAddon }
    }
  } catch {
    cachedModules = null
  }
  return cachedModules
}

/**
 * Normalize a dimension into a positive integer.
 *
 * @param {unknown} value candidate dimension.
 * @param {number} fallback value used when the candidate is not usable.
 * @param {number} minimum smallest allowed value.
 * @returns {number} normalized dimension.
 */
function dimension(value, fallback, minimum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.floor(number))
}

/**
 * Right-trim one screen line (terminals pad with spaces).
 *
 * @param {string} line raw line.
 * @returns {string} line without trailing whitespace.
 */
function trimEnd(line) {
  return line.replace(/[ \t]+$/u, '')
}

/**
 * Trim trailing blank lines from a list of lines.
 *
 * @param {string[]} lines screen lines.
 * @returns {string[]} lines without trailing empty rows.
 */
function trimTrailingBlankLines(lines) {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end -= 1
  return end === lines.length ? lines : lines.slice(0, end)
}

/**
 * One terminal screen.
 *
 * @example
 * const screen = new Screen({ cols: 120, rows: 40 })
 * screen.write('\x1b[32mok\x1b[0m\r\n')
 * screen.text() // "ok"
 */
export class Screen {
  /** @type {any} xterm terminal, or `undefined` in fallback mode. */
  #terminal
  /** @type {any} serialize addon, or `undefined` in fallback mode. */
  #serializer
  /** @type {FallbackScreen | undefined} internal fallback buffer. */
  #fallback
  /** @type {number} requested column count. */
  #cols
  /** @type {number} requested row count. */
  #rows
  /** @type {number} retained scrollback rows. */
  #scrollback
  /** @type {boolean} whether the emulator has been disposed. */
  #disposed = false

  /**
   * @param {object} options screen options.
   * @param {number} options.cols initial column count.
   * @param {number} options.rows initial row count.
   * @param {number} [options.scrollback] retained scrollback rows.
   * @param {boolean} [options.fallback] internal/test hook: force the
   *   internal fallback even when the xterm packages are installed.
   */
  constructor(options = {}) {
    const opts = options || {}
    this.#cols = dimension(opts.cols, 80, 2)
    this.#rows = dimension(opts.rows, 24, 1)
    this.#scrollback = opts.scrollback === undefined
      ? DEFAULT_SCROLLBACK
      : dimension(opts.scrollback, DEFAULT_SCROLLBACK, 0)

    const modules = opts.fallback === true ? null : loadXtermModules()
    if (modules === null) {
      this.#fallback = new FallbackScreen(this.#cols, this.#rows, this.#scrollback)
      return
    }

    this.#terminal = new modules.Terminal({
      cols: this.#cols,
      rows: this.#rows,
      scrollback: this.#scrollback,
      allowProposedApi: true,
      // `writeSync` (used below) warns once through the log service; the
      // warning is noise for a host-side mirror, so keep the service quiet.
      logLevel: 'off',
    })
    this.#serializer = new modules.SerializeAddon()
    this.#terminal.loadAddon(this.#serializer)
  }

  /** Current column count. */
  get cols() {
    if (this.#disposed) return this.#cols
    return this.#terminal ? this.#terminal.cols : this.#cols
  }

  /** Current row count. */
  get rows() {
    if (this.#disposed) return this.#rows
    return this.#terminal ? this.#terminal.rows : this.#rows
  }

  /** Whether this screen has been disposed. */
  get disposed() {
    return this.#disposed
  }

  /** Whether the internal fallback is in use (diagnostics only). */
  get usingFallback() {
    return this.#fallback !== undefined
  }

  /**
   * Feed raw terminal output (ANSI escape sequences allowed).
   *
   * Parsing is synchronous for the xterm-backed implementation, so `text()`
   * and `snapshot()` immediately afterwards are up to date.
   *
   * @param {string} text raw terminal text.
   * @returns {void}
   */
  write(text) {
    if (this.#disposed) return
    if (typeof text !== 'string') text = text == null ? '' : String(text)
    if (text.length === 0) return
    if (this.#fallback) {
      this.#fallback.write(text)
      return
    }
    const core = /** @type {any} */ (this.#terminal)._core
    if (core && typeof core.writeSync === 'function') {
      try {
        core.writeSync(text)
        return
      } catch {
        // Fall through to the public asynchronous API below.
      }
    }
    try {
      // Last-resort path for a future xterm version without writeSync; the
      // public API parses asynchronously, so text() may lag one tick here.
      this.#terminal.write(text)
    } catch {
      // Ignore a disposed terminal.
    }
  }

  /**
   * Resize the emulated grid.
   *
   * @param {number} cols new column count.
   * @param {number} rows new row count.
   * @returns {void}
   */
  resize(cols, rows) {
    if (this.#disposed) return
    const nextCols = dimension(cols, this.#cols, 2)
    const nextRows = dimension(rows, this.#rows, 1)
    this.#cols = nextCols
    this.#rows = nextRows
    if (this.#fallback) {
      this.#fallback.resize(nextCols, nextRows)
      return
    }
    try {
      this.#terminal.resize(nextCols, nextRows)
    } catch {
      // Ignore invalid resize requests from a stale client.
    }
  }

  /**
   * Snapshot of the visible screen.
   *
   * `lines` always has one entry per visible row (trailing whitespace
   * removed), so callers can address rows directly.
   *
   * @returns {{ cols: number, rows: number, cursor: { x: number, y: number }, lines: string[], alt: boolean }} visible screen.
   */
  snapshot() {
    if (this.#disposed) {
      return { cols: this.#cols, rows: this.#rows, cursor: { x: 0, y: 0 }, lines: [], alt: false }
    }
    if (this.#fallback) return this.#fallback.snapshot()

    const buffer = this.#terminal.buffer.active
    const cols = this.#terminal.cols
    const rows = this.#terminal.rows
    const start = this.#viewportStart()
    /** @type {string[]} */
    const lines = []
    for (let index = start; index < start + rows; index += 1) {
      const line = buffer.getLine(index)
      if (line === undefined) break
      lines.push(line.translateToString(true))
    }
    while (lines.length < rows) lines.push('')
    return {
      cols,
      rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      lines,
      alt: buffer.type === 'alternate',
    }
  }

  /**
   * Visible screen text: visible rows, right-trimmed, trailing blank lines
   * removed, joined with `\n`. This is the text the AI read tools return.
   *
   * @returns {string} visible screen text.
   */
  text() {
    if (this.#disposed) return ''
    const lines = this.#linesForText()
    return trimTrailingBlankLines(lines).join('\n')
  }

  /**
   * Scrollback plus visible screen text, oldest line first.
   *
   * @param {number} [maxLines] keep only the newest N lines.
   * @returns {string} retained output text.
   */
  historyText(maxLines) {
    if (this.#disposed) return ''
    const limit = maxLines === undefined || maxLines === null
      ? undefined
      : Math.max(0, Math.floor(Number(maxLines)))
    if (limit === 0) return ''

    if (this.#fallback) return this.#fallback.historyText(limit)

    const buffer = this.#terminal.buffer.active
    const retained = this.#retainedLines()
    /** @type {string[]} */
    const lines = []
    for (let index = 0; index < retained; index += 1) {
      const line = buffer.getLine(index)
      if (line === undefined) break
      lines.push(line.translateToString(true))
    }
    const selected = limit === undefined ? lines : lines.slice(Math.max(0, lines.length - limit))
    return trimTrailingBlankLines(selected).join('\n')
  }

  /**
   * ANSI serialization of the retained buffer, suitable for replaying into a
   * browser xterm.js of the same size.
   *
   * @returns {string} serialized screen (empty when unavailable or disposed).
   */
  serialize() {
    if (this.#disposed || !this.#serializer) return ''
    try {
      return this.#serializer.serialize()
    } catch {
      return ''
    }
  }

  /** Release the emulator. Safe to call more than once. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#fallback) {
      this.#fallback.dispose()
      this.#fallback = undefined
      return
    }
    try {
      this.#terminal.dispose()
    } catch {
      // Already gone.
    }
    this.#terminal = undefined
    this.#serializer = undefined
  }

  /**
   * Viewport start index inside the retained buffer. `baseY` is the scroll
   * offset of the live viewport; when the user has scrolled up we still report
   * the live screen (what a new observer would see).
   *
   * @returns {number} zero-based line index of the first visible row.
   */
  #viewportStart() {
    const buffer = this.#terminal.buffer.active
    const baseY = typeof buffer.baseY === 'number' ? buffer.baseY : 0
    return Math.max(0, Math.min(baseY, buffer.length - this.#terminal.rows))
  }

  /**
   * Number of retained lines up to and including the viewport.
   *
   * @returns {number} retained line count.
   */
  #retainedLines() {
    const buffer = this.#terminal.buffer.active
    return Math.max(0, Math.min(buffer.length, this.#viewportStart() + this.#terminal.rows))
  }

  /**
   * Lines used by `text()`.
   *
   * @returns {string[]} visible lines.
   */
  #linesForText() {
    if (this.#fallback) return this.#fallback.textLines()
    return this.snapshot().lines
  }
}

/**
 * Minimal ANSI-aware screen used when `@xterm/headless` is unavailable.
 *
 * It is deliberately small: a fixed character grid, a bounded scrollback and
 * the escape sequences that matter for turning remote output into readable
 * text. Colour and other SGR attributes are ignored.
 */
class FallbackScreen {
  /** @type {number} */
  #cols
  /** @type {number} */
  #rows
  /** @type {number} */
  #scrollback
  /** @type {string[][]} */
  #grid
  /** @type {string[][] | undefined} */
  #savedGrid
  /** @type {string[]} */
  #history = []
  /** @type {number} */
  #cursorX = 0
  /** @type {number} */
  #cursorY = 0
  /** @type {boolean} */
  #alt = false
  /** @type {'normal' | 'esc' | 'csi' | 'osc' | 'osc-esc'} */
  #parser = 'normal'
  /** @type {string} */
  #buffer = ''

  /**
   * @param {number} cols column count.
   * @param {number} rows row count.
   * @param {number} scrollback retained scrollback rows.
   */
  constructor(cols, rows, scrollback) {
    this.#cols = cols
    this.#rows = rows
    this.#scrollback = scrollback
    this.#grid = this.#blankGrid(cols, rows)
  }

  /**
   * Build an empty grid.
   *
   * @param {number} cols column count.
   * @param {number} rows row count.
   * @returns {string[][]} blank grid.
   */
  #blankGrid(cols, rows) {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '))
  }

  /**
   * Feed raw text into the fallback parser.
   *
   * @param {string} text raw terminal text.
   * @returns {void}
   */
  write(text) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      switch (this.#parser) {
        case 'esc':
          this.#handleEscape(char)
          break
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) {
            this.#handleCsi(this.#buffer, char)
            this.#parser = 'normal'
            this.#buffer = ''
          } else if (code >= 0x20 && code <= 0x3f) {
            this.#buffer += char
          } else {
            this.#parser = 'normal'
            this.#buffer = ''
          }
          break
        case 'osc':
          if (code === 0x07) {
            this.#parser = 'normal'
          } else if (code === 0x1b) {
            this.#parser = 'osc-esc'
          }
          break
        case 'osc-esc':
          this.#parser = char === '\\' ? 'normal' : 'osc'
          break
        default:
          this.#handleChar(char, code)
          break
      }
    }
  }

  /**
   * Handle one byte outside an escape sequence.
   *
   * @param {string} char character.
   * @param {number} code character code.
   * @returns {void}
   */
  #handleChar(char, code) {
    if (code === 0x1b) {
      this.#parser = 'esc'
      return
    }
    if (code === 0x0d) {
      this.#cursorX = 0
      return
    }
    if (code === 0x0a) {
      this.#lineFeed()
      return
    }
    if (code === 0x08) {
      this.#cursorX = Math.max(0, this.#cursorX - 1)
      return
    }
    if (code === 0x09) {
      const next = Math.min(this.#cols - 1, (Math.floor(this.#cursorX / 8) + 1) * 8)
      this.#cursorX = next
      return
    }
    if (code < 0x20 || code === 0x7f) return
    this.#put(char, code)
  }

  /**
   * Handle the character after ESC.
   *
   * @param {string} char character following ESC.
   * @returns {void}
   */
  #handleEscape(char) {
    if (char === '[') {
      this.#parser = 'csi'
      this.#buffer = ''
      return
    }
    if (char === ']') {
      this.#parser = 'osc'
      return
    }
    this.#parser = 'normal'
    if (char === 'c') {
      this.#grid = this.#blankGrid(this.#cols, this.#rows)
      this.#cursorX = 0
      this.#cursorY = 0
      this.#alt = false
      this.#savedGrid = undefined
    } else if (char === 'M') {
      this.#scrollUp(1)
    } else if (char === 'D') {
      this.#lineFeed()
    } else if (char === 'E') {
      this.#cursorX = 0
      this.#lineFeed()
    }
  }

  /**
   * Execute a CSI sequence.
   *
   * @param {string} params parameter bytes (possibly starting with `?`).
   * @param {string} final final byte.
   * @returns {void}
   */
  #handleCsi(params, final) {
    const privateMode = params.startsWith('?')
    const body = privateMode ? params.slice(1) : params
    const numbers = body
      .split(';')
      .map((part) => (part === '' ? Number.NaN : Number.parseInt(part, 10)))
    /** @param {number} index @returns {number} parameter or default. */
    const arg = (index, fallback) => {
      const value = numbers[index]
      return Number.isFinite(value) && value > 0 ? value : fallback
    }

    if (privateMode) {
      const enabled = final === 'h'
      if (final === 'h' || final === 'l') {
        for (const value of numbers) {
          if (value === 1049 || value === 1047 || value === 47) this.#setAlt(enabled)
        }
      }
      return
    }

    const row = this.#cursorY
    const col = this.#cursorX
    switch (final) {
      case 'A':
        this.#cursorY = Math.max(0, row - arg(0, 1))
        break
      case 'B':
        this.#cursorY = Math.min(this.#rows - 1, row + arg(0, 1))
        break
      case 'C':
        this.#cursorX = Math.min(this.#cols - 1, col + arg(0, 1))
        break
      case 'D':
        this.#cursorX = Math.max(0, col - arg(0, 1))
        break
      case 'E':
        this.#cursorX = 0
        this.#cursorY = Math.min(this.#rows - 1, row + arg(0, 1))
        break
      case 'F':
        this.#cursorX = 0
        this.#cursorY = Math.max(0, row - arg(0, 1))
        break
      case 'G':
        this.#cursorX = Math.min(this.#cols - 1, arg(0, 1) - 1)
        break
      case 'H':
      case 'f':
        this.#cursorY = Math.min(this.#rows - 1, arg(0, 1) - 1)
        this.#cursorX = Math.min(this.#cols - 1, arg(1, 1) - 1)
        break
      case 'd':
        this.#cursorY = Math.min(this.#rows - 1, arg(0, 1) - 1)
        break
      case 'J':
        this.#eraseDisplay(numbers[0] ?? 0)
        break
      case 'K':
        this.#eraseLine(numbers[0] ?? 0)
        break
      case 'S':
        this.#scrollUp(arg(0, 1))
        break
      case 'T':
        this.#scrollDown(arg(0, 1))
        break
      case 'L':
        this.#insertLines(arg(0, 1))
        break
      case 'M':
        this.#deleteLines(arg(0, 1))
        break
      case 'P':
        this.#deleteChars(arg(0, 1))
        break
      case 'X':
        this.#eraseChars(arg(0, 1))
        break
      default:
        break
    }
  }

  /**
   * Write one printable character at the cursor and advance it.
   *
   * @param {string} char character.
   * @param {number} code code point.
   * @returns {void}
   */
  #put(char, code) {
    if (this.#cursorX >= this.#cols) {
      this.#cursorX = 0
      this.#lineFeed()
    }
    const width = code > 0x2e7f && code < 0xa000 ? 2 : 1
    this.#grid[this.#cursorY][this.#cursorX] = char
    if (width === 2 && this.#cursorX + 1 < this.#cols) {
      this.#grid[this.#cursorY][this.#cursorX + 1] = ''
    }
    this.#cursorX += width
  }

  /** Move to the next line, scrolling when already on the last row. */
  #lineFeed() {
    if (this.#cursorY >= this.#rows - 1) {
      const top = this.#grid.shift()
      if (top) {
        const text = trimEnd(top.join(''))
        this.#history.push(text)
        if (this.#history.length > this.#scrollback) this.#history.shift()
      }
      this.#grid.push(Array.from({ length: this.#cols }, () => ' '))
      this.#cursorY = this.#rows - 1
    } else {
      this.#cursorY += 1
    }
  }

  /**
   * Scroll the grid up, pushing rows into scrollback.
   *
   * @param {number} count row count.
   * @returns {void}
   */
  #scrollUp(count) {
    for (let index = 0; index < count; index += 1) {
      const top = this.#grid.shift()
      if (top) {
        this.#history.push(trimEnd(top.join('')))
        if (this.#history.length > this.#scrollback) this.#history.shift()
      }
      this.#grid.push(Array.from({ length: this.#cols }, () => ' '))
    }
  }

  /**
   * Scroll the grid down.
   *
   * @param {number} count row count.
   * @returns {void}
   */
  #scrollDown(count) {
    for (let index = 0; index < count; index += 1) {
      this.#grid.pop()
      this.#grid.unshift(Array.from({ length: this.#cols }, () => ' '))
    }
  }

  /**
   * Insert blank lines at the cursor row.
   *
   * @param {number} count row count.
   * @returns {void}
   */
  #insertLines(count) {
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#cursorY, 0, Array.from({ length: this.#cols }, () => ' '))
      this.#grid.pop()
    }
  }

  /**
   * Delete lines at the cursor row.
   *
   * @param {number} count row count.
   * @returns {void}
   */
  #deleteLines(count) {
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#cursorY, 1)
      this.#grid.push(Array.from({ length: this.#cols }, () => ' '))
    }
  }

  /**
   * Delete characters on the cursor row.
   *
   * @param {number} count character count.
   * @returns {void}
   */
  #deleteChars(count) {
    const row = this.#grid[this.#cursorY]
    row.splice(this.#cursorX, count)
    while (row.length < this.#cols) row.push(' ')
  }

  /**
   * Erase characters on the cursor row.
   *
   * @param {number} count character count.
   * @returns {void}
   */
  #eraseChars(count) {
    const row = this.#grid[this.#cursorY]
    for (let index = 0; index < count && this.#cursorX + index < this.#cols; index += 1) {
      row[this.#cursorX + index] = ' '
    }
  }

  /**
   * Erase part of the display.
   *
   * @param {number} mode 0, 1 or 2.
   * @returns {void}
   */
  #eraseDisplay(mode) {
    if (mode === 2) {
      this.#grid = this.#blankGrid(this.#cols, this.#rows)
      return
    }
    if (mode === 1) {
      for (let row = 0; row < this.#cursorY; row += 1) {
        this.#grid[row] = Array.from({ length: this.#cols }, () => ' ')
      }
      this.#eraseLine(1)
      return
    }
    this.#eraseLine(0)
    for (let row = this.#cursorY + 1; row < this.#rows; row += 1) {
      this.#grid[row] = Array.from({ length: this.#cols }, () => ' ')
    }
  }

  /**
   * Erase part of the current line.
   *
   * @param {number} mode 0, 1 or 2.
   * @returns {void}
   */
  #eraseLine(mode) {
    const row = this.#grid[this.#cursorY]
    if (mode === 2) {
      for (let index = 0; index < this.#cols; index += 1) row[index] = ' '
      return
    }
    if (mode === 1) {
      for (let index = 0; index <= this.#cursorX && index < this.#cols; index += 1) row[index] = ' '
      return
    }
    for (let index = this.#cursorX; index < this.#cols; index += 1) row[index] = ' '
  }

  /**
   * Enter or leave the alternate screen.
   *
   * @param {boolean} enabled whether the alternate screen becomes active.
   * @returns {void}
   */
  #setAlt(enabled) {
    if (enabled === this.#alt) return
    if (enabled) {
      this.#savedGrid = this.#grid
      this.#savedCursor = { x: this.#cursorX, y: this.#cursorY }
      this.#grid = this.#blankGrid(this.#cols, this.#rows)
      this.#cursorX = 0
      this.#cursorY = 0
      this.#alt = true
    } else if (this.#savedGrid) {
      this.#grid = this.#savedGrid
      this.#cursorX = this.#savedCursor?.x ?? 0
      this.#cursorY = Math.min(this.#rows - 1, this.#savedCursor?.y ?? 0)
      this.#savedGrid = undefined
      this.#savedCursor = undefined
      this.#alt = false
    }
  }

  /** @type {{x: number, y: number} | undefined} saved cursor for alt screen. */
  #savedCursor

  /**
   * Resize the fallback grid.
   *
   * @param {number} cols new column count.
   * @param {number} rows new row count.
   * @returns {void}
   */
  resize(cols, rows) {
    const next = this.#blankGrid(cols, rows)
    for (let row = 0; row < Math.min(rows, this.#rows); row += 1) {
      for (let col = 0; col < Math.min(cols, this.#cols); col += 1) {
        next[row][col] = this.#grid[row]?.[col] ?? ' '
      }
    }
    this.#cols = cols
    this.#rows = rows
    this.#grid = next
    this.#cursorX = Math.min(this.#cursorX, cols - 1)
    this.#cursorY = Math.min(this.#cursorY, rows - 1)
  }

  /**
   * Visible screen snapshot.
   *
   * @returns {{ cols: number, rows: number, cursor: { x: number, y: number }, lines: string[], alt: boolean }} visible screen.
   */
  snapshot() {
    const lines = this.textLines()
    return {
      cols: this.#cols,
      rows: this.#rows,
      cursor: { x: this.#cursorX, y: this.#cursorY },
      lines,
      alt: this.#alt,
    }
  }

  /**
   * Visible lines, right-trimmed.
   *
   * @returns {string[]} visible lines.
   */
  textLines() {
    return this.#grid.map((row) => trimEnd(row.join('')))
  }

  /**
   * Scrollback plus visible lines.
   *
   * @param {number | undefined} maxLines newest-line limit.
   * @returns {string} retained text.
   */
  historyText(maxLines) {
    const all = this.#history.concat(this.textLines())
    const selected = maxLines === undefined ? all : all.slice(Math.max(0, all.length - maxLines))
    return trimTrailingBlankLines(selected).join('\n')
  }

  /** Release retained state. */
  dispose() {
    this.#grid = []
    this.#savedGrid = undefined
    this.#history = []
  }
}

/**
 * Type-only re-export guard: keeps the class JSDoc accurate for tooling.
 *
 * @typedef {object} ScreenOptions
 * @property {number} cols initial column count.
 * @property {number} rows initial row count.
 * @property {number} [scrollback] retained scrollback rows.
 */
