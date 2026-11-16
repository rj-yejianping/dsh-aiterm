/**
 * Row-level screen diff for the "changedOnly" read mode (CONTRACTS.md §12.2).
 *
 * The registry keeps a headless terminal per session. A reader (usually the
 * model) can ask for only the rows that changed since its last look, which is
 * the difference between a useful delta and a full 30-row screen in the
 * transcript. This module is deliberately tiny and free of terminal knowledge:
 * it compares two snapshots of `lines` and reports 0-based row indexes.
 */

/**
 * @typedef {object} ScreenDiff
 * @property {number[]} changed 0-based indexes of rows present in both snapshots whose text differs.
 * @property {number[]} added 0-based indexes of rows that exist only in the next snapshot (new bottom rows).
 * @property {boolean} unchanged true only when the snapshots are identical in content and length.
 */

/**
 * Compare two screen snapshots.
 *
 * Rows are compared by exact text: both snapshots normally come from the same
 * emulator at the same size, so trailing padding is identical. A screen that
 * shrank is never `unchanged` (a row was removed) even though every remaining
 * row may be identical; callers that see `unchanged: false` with an empty
 * `changed`/`added` list should resend the whole screen.
 * @param {string[]} previousLines previous snapshot rows (top to bottom).
 * @param {string[]} nextLines current snapshot rows (top to bottom).
 * @returns {ScreenDiff} changed/added rows plus the unchanged flag.
 */
export function diffScreen(previousLines, nextLines) {
  const previous = normalizeLines(previousLines)
  const next = normalizeLines(nextLines)
  /** @type {number[]} */
  const changed = []
  /** @type {number[]} */
  const added = []
  const common = Math.min(previous.length, next.length)
  for (let row = 0; row < common; row += 1) {
    if (previous[row] !== next[row]) changed.push(row)
  }
  for (let row = common; row < next.length; row += 1) added.push(row)
  const unchanged = previous.length === next.length && changed.length === 0 && added.length === 0
  return { changed, added, unchanged }
}

/**
 * Coerce a snapshot into a dense string array.
 * @param {unknown} lines candidate rows.
 * @returns {string[]} rows as strings.
 */
function normalizeLines(lines) {
  if (!Array.isArray(lines)) return []
  /** @type {string[]} */
  const out = new Array(lines.length)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    out[index] = typeof line === 'string' ? line : line === undefined || line === null ? '' : String(line)
  }
  return out
}
