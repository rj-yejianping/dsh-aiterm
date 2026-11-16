/**
 * Timestamped output log with monotonic UTF-8 byte offsets (CONTRACTS.md §9).
 *
 * The log is the read side of a session: every decoded chunk the transport
 * yields is appended with a timestamp, and readers address it by byte offset.
 * Offsets are cumulative UTF-8 byte counts and never rewind, so a cursor saved
 * before the retention window was pruned still points at the same logical byte;
 * the caller learns that history is gone from `slice(...).truncated`.
 *
 * Memory is bounded two ways: `maxBytes` drops old chunks (or trims the head of
 * one oversized chunk) on every append, and `maxAgeMs` drops chunks older than
 * the window when `prune()` runs (also automatically for real-time appends that
 * do not supply an explicit timestamp).
 *
 * Nothing here imports `@deepseek-ai/*` or touches the network: it is a plain
 * in-memory structure the registry owns per session.
 */

/** Matches returned by `search()` when the caller does not cap them. */
const DEFAULT_MAX_MATCHES = 100

/** Default memory window: 1 MiB of output, 24 hours. */
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} OutputChunk
 * @property {number} offset absolute byte offset of the first byte in `bytes`.
 * @property {number} at epoch ms when the bytes arrived.
 * @property {Buffer} bytes UTF-8 bytes of the chunk.
 */

/**
 * @typedef {object} OutputWindow
 * @property {number} firstAt timestamp of the oldest retained chunk.
 * @property {number} lastAt timestamp of the newest retained chunk.
 * @property {number} firstOffset absolute offset of the oldest retained byte.
 * @property {number} lastOffset absolute offset one past the newest byte (== totalOffset).
 */

/**
 * @typedef {object} SearchMatch
 * @property {number} at epoch ms of the chunk that produced the matched line.
 * @property {number} offset absolute byte offset of the matched line.
 * @property {string} line the matched line (line terminators removed).
 * @property {string[]} before up to `context` lines before the match.
 * @property {string[]} after up to `context` lines after the match.
 */

/**
 * @typedef {object} SearchResult
 * @property {SearchMatch[]} matches matches in ascending time order.
 * @property {number} scannedBytes bytes examined from the retained window.
 * @property {boolean} truncated whether the scan was cut short (window, maxBytes or maxMatches).
 */

/**
 * A monotonic, timestamped, byte-addressed output log.
 */
export class OutputLog {
  /**
   * @param {{ maxBytes?: number, maxAgeMs?: number }} [options] retention window.
   *   `maxBytes` defaults to 1 MiB and `maxAgeMs` to 24 hours; a non-positive or
   *   non-finite value falls back to that default. Pass `Infinity` explicitly to
   *   disable one dimension.
   */
  constructor(options = {}) {
    const maxBytes = options?.maxBytes
    this.maxBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES
    const maxAgeMs = options?.maxAgeMs
    this.maxAgeMs =
      typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs > 0
        ? Math.floor(maxAgeMs)
        : maxAgeMs === Infinity
          ? Infinity
          : DEFAULT_MAX_AGE_MS
    /** @type {OutputChunk[]} retained chunks, oldest first. */
    this.chunks = []
    /** Absolute offset one past the last appended byte; never decreases. */
    this.nextOffset = 0
    /** Retained UTF-8 byte count (cached so pruning does not re-sum) . */
    this.retainedSize = 0
    this.disposed = false
  }

  /** @returns {number} absolute offset the next delta starts at. */
  get totalOffset() {
    return this.nextOffset
  }

  /** @returns {number} absolute offset of the oldest retained byte. */
  get retainedStart() {
    return this.chunks.length > 0 ? this.chunks[0].offset : this.nextOffset
  }

  /** @returns {number} retained byte count inside the window. */
  get retainedBytes() {
    return this.retainedSize
  }

  /**
   * Timestamp/offset bounds of the retained window. On an empty log the
   * timestamps are 0 and both offsets are `totalOffset`, so callers can always
   * compare `lastOffset` against a cursor without special-casing.
   * @returns {OutputWindow} window bounds.
   */
  get window() {
    if (this.chunks.length === 0) {
      return { firstAt: 0, lastAt: 0, firstOffset: this.nextOffset, lastOffset: this.nextOffset }
    }
    return {
      firstAt: this.chunks[0].at,
      lastAt: this.chunks[this.chunks.length - 1].at,
      firstOffset: this.chunks[0].offset,
      lastOffset: this.nextOffset,
    }
  }

  /**
   * Append one decoded chunk. Never throws: a non-string or empty input, or a
   * disposed log, is ignored.
   * @param {string} text decoded output.
   * @param {number} [at] epoch ms; defaults to now and enables automatic age pruning.
   * @returns {void}
   */
  append(text, at) {
    if (this.disposed) return
    if (typeof text !== 'string' || text.length === 0) return
    let bytes
    try {
      bytes = Buffer.from(text, 'utf8')
    } catch {
      return
    }
    if (bytes.length === 0) return
    const explicitAt = typeof at === 'number' && Number.isFinite(at)
    const timestamp = explicitAt ? Math.floor(at) : Date.now()
    this.chunks.push({ offset: this.nextOffset, at: timestamp, bytes })
    this.nextOffset += bytes.length
    this.retainedSize += bytes.length
    if (this.retainedSize > this.maxBytes) this.pruneBySize()
    // Real-time appends maintain the age window automatically; an explicit
    // timestamp means the caller is replaying history, so only `prune()` ages it.
    if (!explicitAt && this.maxAgeMs !== Infinity) this.pruneByAge(timestamp)
  }

  /**
   * Read text by absolute byte offset.
   *
   * When the requested `from` falls before the retained window the oldest
   * retained bytes are returned with `truncated: true`; when `maxBytes` cuts
   * the tail, `truncated` is true as well and `to` is the cursor for the next
   * read. Cuts are always aligned to UTF-8 code point boundaries, so `text`
   * never contains a replacement character produced by this method.
   * @param {number} [from] absolute byte offset (default 0).
   * @param {number} [maxBytes] maximum bytes to return (default: unbounded).
   * @returns {{ text: string, from: number, to: number, truncated: boolean }} slice.
   */
  slice(from = 0, maxBytes) {
    const total = this.nextOffset
    const retainedStart = this.retainedStart
    let truncated = false
    let start = typeof from === 'number' && Number.isFinite(from) ? Math.floor(from) : 0
    if (start < 0) start = 0
    if (start < retainedStart) {
      start = retainedStart
      truncated = true
    }
    if (start > total) start = total
    let end = total
    if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0) {
      end = Math.min(total, start + Math.floor(maxBytes))
    }
    start = this.byteBoundaryForward(start)
    end = this.byteBoundaryBackward(end, start)
    if (end < start) end = start
    if (end < total) truncated = true
    const text = this.extract(start, end)
    return { text, from: start, to: end, truncated }
  }

  /**
   * First byte offset whose chunk arrived at or after `timestampMs`.
   *
   * A timestamp before the retained window maps to `window.firstOffset`
   * (the oldest byte still readable); a timestamp after the newest chunk maps
   * to `totalOffset`, which makes a "read since time" delta empty.
   * @param {number} timestampMs epoch ms.
   * @returns {number} absolute byte offset.
   */
  offsetAt(timestampMs) {
    const chunks = this.chunks
    if (chunks.length === 0) return this.nextOffset
    if (typeof timestampMs !== 'number' || Number.isNaN(timestampMs)) return this.nextOffset
    if (timestampMs <= chunks[0].at) return chunks[0].offset
    if (timestampMs > chunks[chunks.length - 1].at) return this.nextOffset
    let lo = 0
    let hi = chunks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (chunks[mid].at < timestampMs) lo = mid + 1
      else hi = mid
    }
    return lo < chunks.length ? chunks[lo].offset : this.nextOffset
  }

  /**
   * Timestamp of the chunk containing an absolute byte offset.
   * @param {number} offset absolute byte offset.
   * @returns {number} epoch ms (0 for an empty log).
   */
  timestampAtOffset(offset) {
    const chunks = this.chunks
    if (chunks.length === 0) return 0
    if (offset < chunks[0].offset) return chunks[0].at
    if (offset >= this.nextOffset) return chunks[chunks.length - 1].at
    let lo = 0
    let hi = chunks.length - 1
    let best = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (chunks[mid].offset <= offset) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return chunks[best].at
  }

  /**
   * Search line by line inside the retained window.
   *
   * The scan covers `[max(retainedStart, offsetAt(since)), offsetAt(until + 1))`
   * and is narrowed from the tail when `maxBytes` is smaller than that range
   * (matching the history store's "scan the tail" behaviour). `truncated` is
   * true when older history was already pruned, when the range was narrowed by
   * `maxBytes`, or when more matches exist than `maxMatches`.
   * @param {{ pattern?: RegExp | string, since?: number, until?: number, context?: number, maxMatches?: number, maxBytes?: number }} [query] search options.
   * @returns {SearchResult} matches plus scan bookkeeping.
   */
  search(query = {}) {
    /** @type {SearchResult} */
    const empty = { matches: [], scannedBytes: 0, truncated: false }
    const pattern = toRegExp(query?.pattern)
    if (pattern === null) return empty
    const total = this.nextOffset
    const chunks = this.chunks
    let truncated = false

    let rangeStart = this.retainedStart
    const since = typeof query?.since === 'number' && Number.isFinite(query.since) ? query.since : -Infinity
    if (since > -Infinity) {
      rangeStart = this.offsetAt(since)
      if (chunks.length > 0 && since < chunks[0].at) truncated = true
    }
    let rangeEnd = total
    const until = typeof query?.until === 'number' && Number.isFinite(query.until) ? query.until : Infinity
    if (until < Infinity) rangeEnd = this.offsetAt(Math.floor(until) + 1)
    if (rangeEnd < rangeStart) rangeEnd = rangeStart

    const context =
      typeof query?.context === 'number' && Number.isFinite(query.context)
        ? Math.max(0, Math.min(50, Math.floor(query.context)))
        : 0
    const maxMatches =
      typeof query?.maxMatches === 'number' && Number.isFinite(query.maxMatches) && query.maxMatches > 0
        ? Math.floor(query.maxMatches)
        : DEFAULT_MAX_MATCHES
    const maxBytes =
      typeof query?.maxBytes === 'number' && Number.isFinite(query.maxBytes) && query.maxBytes >= 0
        ? Math.floor(query.maxBytes)
        : Infinity

    let scanStart = rangeStart
    if (rangeEnd - rangeStart > maxBytes) {
      scanStart = rangeEnd - maxBytes
      truncated = true
    }
    scanStart = this.byteBoundaryForward(scanStart)
    if (scanStart > rangeEnd) scanStart = rangeEnd

    const buffer = this.extractBytes(scanStart, rangeEnd)
    const records = splitOutputLines(buffer, scanStart)
    /** @type {Array<{ match: SearchMatch }>} */
    const pendingAfter = []
    /** @type {SearchMatch[]} */
    const matches = []
    let scannedEnd = scanStart
    let stopped = false

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      // Back-fill the "after" context of any earlier match still collecting lines.
      for (const pending of pendingAfter) {
        if (pending.match.after.length < context) pending.match.after.push(record.text)
      }
      // Matches whose context window is complete no longer need new lines.
      for (let i = pendingAfter.length - 1; i >= 0; i -= 1) {
        if (pendingAfter[i].match.after.length >= context) pendingAfter.splice(i, 1)
      }
      scannedEnd = record.offsetEnd
      pattern.lastIndex = 0
      if (!pattern.test(record.text)) continue
      if (matches.length >= maxMatches) {
        truncated = true
        stopped = true
        break
      }
      /** @type {SearchMatch} */
      const match = {
        at: this.timestampAtOffset(record.offset),
        offset: record.offset,
        line: record.text,
        before: [],
        after: [],
      }
      for (let i = Math.max(0, index - context); i < index; i += 1) match.before.push(records[i].text)
      matches.push(match)
      if (context > 0) pendingAfter.push({ match })
    }

    let scannedBytes
    if (stopped) scannedBytes = Math.max(0, scannedEnd - scanStart)
    else scannedBytes = Math.max(0, rangeEnd - scanStart)
    return { matches, scannedBytes, truncated }
  }

  /**
   * Drop chunks outside the `maxAgeMs` / `maxBytes` window. Offsets never
   * rewind: only retained content changes.
   * @param {number} [now] epoch ms used for the age comparison (default: now).
   * @returns {void}
   */
  prune(now = Date.now()) {
    if (this.disposed) return
    if (this.maxAgeMs !== Infinity) this.pruneByAge(typeof now === 'number' && Number.isFinite(now) ? now : Date.now())
    this.pruneBySize()
  }

  /**
   * Forget every retained chunk, keeping the absolute offset so a later
   * `slice()` reports `truncated` instead of silently re-centering.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    this.chunks = []
    this.retainedSize = 0
  }

  /**
   * Drop chunks older than the age window.
   * @param {number} now epoch ms.
   * @returns {void}
   * @private
   */
  pruneByAge(now) {
    if (this.maxAgeMs === Infinity) return
    const cutoff = now - this.maxAgeMs
    let drop = 0
    while (drop < this.chunks.length && this.chunks[drop].at < cutoff) {
      this.retainedSize -= this.chunks[drop].bytes.length
      drop += 1
    }
    if (drop > 0) this.chunks.splice(0, drop)
  }

  /**
   * Drop/trim retained bytes until the byte window holds.
   * @returns {void}
   * @private
   */
  pruneBySize() {
    if (this.maxBytes === Infinity) return
    while (this.retainedSize > this.maxBytes && this.chunks.length > 0) {
      if (this.chunks.length > 1) {
        const removed = this.chunks.shift()
        this.retainedSize -= removed.bytes.length
        continue
      }
      const chunk = this.chunks[0]
      const excess = this.retainedSize - this.maxBytes
      const cut = utf8SafeCutForward(chunk.bytes, excess)
      if (cut <= 0) break
      chunk.bytes = chunk.bytes.subarray(cut)
      chunk.offset += cut
      this.retainedSize -= cut
      if (chunk.bytes.length === 0) {
        this.chunks.shift()
        break
      }
    }
  }

  /**
   * @param {number} position absolute offset.
   * @returns {number | undefined} the byte at that offset, if retained.
   */
  byteAt(position) {
    const chunks = this.chunks
    let lo = 0
    let hi = chunks.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const chunk = chunks[mid]
      const end = chunk.offset + chunk.bytes.length
      if (position < chunk.offset) hi = mid - 1
      else if (position >= end) lo = mid + 1
      else return chunk.bytes[position - chunk.offset]
    }
    return undefined
  }

  /**
   * Move a cut position forward out of the middle of a UTF-8 code point.
   * @param {number} position absolute offset.
   * @returns {number} safe offset.
   */
  byteBoundaryForward(position) {
    if (position >= this.nextOffset) return this.nextOffset
    let cursor = position
    while (cursor < this.nextOffset) {
      const byte = this.byteAt(cursor)
      if (byte === undefined || !isContinuation(byte)) break
      cursor += 1
    }
    return cursor
  }

  /**
   * Move a cut position backward out of the middle of a UTF-8 code point.
   * @param {number} position absolute offset (exclusive end).
   * @param {number} minimum lower bound.
   * @returns {number} safe offset.
   */
  byteBoundaryBackward(position, minimum) {
    if (position >= this.nextOffset) return position
    let cursor = position
    while (cursor > minimum) {
      const byte = this.byteAt(cursor)
      if (byte === undefined || !isContinuation(byte)) break
      cursor -= 1
    }
    return cursor
  }

  /**
   * Extract retained bytes in `[start, end)`.
   * @param {number} start absolute offset.
   * @param {number} end absolute offset (exclusive).
   * @returns {Buffer} bytes (possibly empty).
   */
  extractBytes(start, end) {
    if (end <= start) return Buffer.alloc(0)
    /** @type {Buffer[]} */
    const parts = []
    for (const chunk of this.chunks) {
      const chunkStart = chunk.offset
      const chunkEnd = chunkStart + chunk.bytes.length
      if (chunkEnd <= start) continue
      if (chunkStart >= end) break
      const localStart = Math.max(0, start - chunkStart)
      const localEnd = Math.min(chunk.bytes.length, end - chunkStart)
      if (localEnd > localStart) parts.push(chunk.bytes.subarray(localStart, localEnd))
    }
    if (parts.length === 0) return Buffer.alloc(0)
    if (parts.length === 1) return parts[0]
    return Buffer.concat(parts)
  }

  /**
   * Extract retained bytes in `[start, end)` and decode them as UTF-8.
   * @param {number} start absolute offset.
   * @param {number} end absolute offset (exclusive).
   * @returns {string} decoded text.
   */
  extract(start, end) {
    return this.extractBytes(start, end).toString('utf8')
  }
}

/**
 * @param {number} byte UTF-8 byte.
 * @returns {boolean} whether the byte is a continuation byte.
 */
function isContinuation(byte) {
  return (byte & 0xc0) === 0x80
}

/**
 * Advance a cut position past UTF-8 continuation bytes.
 * @param {Buffer} buffer bytes.
 * @param {number} position candidate cut.
 * @returns {number} safe cut offset within the buffer.
 */
function utf8SafeCutForward(buffer, position) {
  let cursor = Math.max(0, Math.min(buffer.length, position))
  while (cursor < buffer.length && isContinuation(buffer[cursor])) cursor += 1
  return cursor
}

/**
 * Compile a search pattern defensively.
 * @param {RegExp | string | undefined} pattern caller pattern.
 * @returns {RegExp | null} a usable regular expression, or null.
 */
function toRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern
  if (typeof pattern === 'string' && pattern.length > 0) {
    try {
      return new RegExp(pattern)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Split a byte range into lines while keeping byte offsets, tolerating `\n`,
 * `\r\n` and lone `\r` (terminal output uses all three).
 * @param {Buffer} buffer bytes to split.
 * @param {number} baseOffset absolute offset of `buffer[0]`.
 * @returns {Array<{ text: string, offset: number, offsetEnd: number }>} line records.
 */
function splitOutputLines(buffer, baseOffset) {
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = []
  let lineStart = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === 0x0d) {
      ranges.push({ start: lineStart, end: index })
      if (buffer[index + 1] === 0x0a) index += 1
      lineStart = index + 1
    } else if (byte === 0x0a) {
      ranges.push({ start: lineStart, end: index })
      lineStart = index + 1
    }
  }
  if (lineStart < buffer.length) ranges.push({ start: lineStart, end: buffer.length })
  return ranges.map((range) => ({
    text: buffer.subarray(range.start, range.end).toString('utf8'),
    offset: baseOffset + range.start,
    offsetEnd: baseOffset + range.end,
  }))
}
