/**
 * Dialect bookkeeping for saved scripts.
 *
 * The two authoring formats are separate on purpose (逐行命令 vs 高级脚本): a
 * script keeps the dialect it was created with, and the panel never converts
 * between them. The Host stores only `steps`, so the chosen dialect is kept in
 * `localStorage` under this plugin's key and defaults to 逐行命令 — a program
 * that is expressible as commands reads as commands.
 */

const STORAGE_KEY = 'dsh.aiterm.scriptDialect'

/**
 * Read the dialect map.
 *
 * @returns {Record<string, 'macro' | 'json'>} name → dialect.
 */
function readMap() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param name - script name.
 * @returns {'macro' | 'json'} the recorded dialect (defaults to macro).
 */
export function dialectOf(name) {
  const map = readMap()
  return map[name] === 'json' ? 'json' : 'macro'
}

/**
 * Record the dialect a script was saved with.
 *
 * @param name - script name.
 * @param dialect - 'macro' or 'json'.
 * @returns {void}
 */
export function rememberDialect(name, dialect) {
  if (typeof name !== 'string' || name === '') return
  try {
    if (!globalThis.localStorage) return
    const map = readMap()
    map[name] = dialect === 'json' ? 'json' : 'macro'
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable: the list falls back to the default dialect */
  }
}
