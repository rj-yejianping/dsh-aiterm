/**
 * Prompt detection for terminal screens (CONTRACTS.md §12.4).
 *
 * Every read returns `atPrompt`, and `aiterm_wait` can block until the
 * remote shell looks ready for input. Both use the same rule: the last
 * non-empty screen line, with trailing whitespace removed, must end in a shell
 * prompt character. The default pattern is the `promptPattern` config default;
 * users may override it, so the pattern is accepted as either a `RegExp` or a
 * string and compiled defensively (a broken pattern means "not a prompt"
 * rather than an exception inside a read path).
 */

/** Default prompt pattern source, identical to the config default in §12.4. */
export const DEFAULT_PROMPT_PATTERN_SOURCE = '[#$%>❯»]\\s*$'

/** Default prompt pattern (fresh instance; detection never mutates it). */
export const DEFAULT_PROMPT_PATTERN = new RegExp(DEFAULT_PROMPT_PATTERN_SOURCE)

/**
 * Last line that contains something other than whitespace.
 * @param {string[]} lines screen rows, top to bottom.
 * @returns {string} the last non-empty line, or '' when the screen is blank.
 */
export function lastNonEmptyLine(lines) {
  if (!Array.isArray(lines)) return ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (typeof line !== 'string') continue
    if (line.trim().length > 0) return line
  }
  return ''
}

/**
 * Whether the screen currently shows a shell prompt.
 *
 * Trailing whitespace (including `\r`) is stripped before matching so a
 * prompt followed by erased characters still matches; the default pattern
 * anchors on that right edge.
 * @param {string[]} lines screen rows, top to bottom.
 * @param {RegExp | string} [pattern] custom prompt pattern (default: §12.4).
 * @returns {boolean} true when the last non-empty line looks like a prompt.
 */
export function detectPrompt(lines, pattern) {
  const line = lastNonEmptyLine(lines)
  if (line.length === 0) return false
  const compiled = compilePattern(pattern)
  if (compiled === null) return false
  const candidate = line.replace(/\s+$/, '')
  if (candidate.length === 0) return false
  compiled.lastIndex = 0
  return compiled.test(candidate)
}

/**
 * @param {RegExp | string | undefined} pattern configured pattern.
 * @returns {RegExp | null} usable pattern, or null when invalid.
 */
function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern
  if (typeof pattern === 'string' && pattern.length > 0) {
    try {
      return new RegExp(pattern)
    } catch {
      return null
    }
  }
  if (pattern === undefined || pattern === null || pattern === '') return DEFAULT_PROMPT_PATTERN
  return null
}


/** Default prompt pattern (fresh instance; detection never mutates it). */
