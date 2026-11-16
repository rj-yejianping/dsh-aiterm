/**
 * Local display order for saved scripts.
 *
 * The Host has no `order` field on a script (`lib/host/scripts.js`): the list is
 * just the set of files. Reordering is therefore a purely client-side
 * convenience — the user's ▲ / ▼ choice is remembered per folder in
 * `localStorage` under this plugin's key, and the script list (and the quick
 * script bar) sorts by it. Nothing is sent to the Host and no step is rewritten.
 *
 * A name that is not in the stored order (a newly saved script, or a script the
 * user has never moved) keeps its natural position after the ordered names, so
 * the module degrades to "no preference" instead of hiding entries.
 */

const STORAGE_KEY = 'dsh.aiterm.scriptOrder'

/**
 * Read the stored order map.
 *
 * @returns {Record<string, string[]>} folder → ordered script names.
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
 * Persist the order map (best effort: storage may be unavailable).
 *
 * @param map - folder → ordered script names.
 * @returns {void}
 */
function writeMap(map) {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable: the order simply does not persist */
  }
}

/**
 * Ordered names of one folder, filtered to the names that still exist.
 *
 * @param folder - folder name ('' = ungrouped).
 * @param names - names currently present in that folder.
 * @returns the same names, stored order first, unknown names appended in input order.
 */
export function sortScriptNames(folder, names) {
  const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name !== '') : []
  const map = readMap()
  const stored = Array.isArray(map[folder]) ? map[folder].filter((name) => list.includes(name)) : []
  const rest = list.filter((name) => !stored.includes(name))
  return stored.concat(rest)
}

/**
 * Move one script up or down inside its folder and persist the choice.
 *
 * @param folder - folder name ('' = ungrouped).
 * @param names - names currently present in that folder.
 * @param name - script to move.
 * @param delta - -1 for up, +1 for down.
 * @returns `{ names, moved }` — the new order (whether or not it changed).
 */
export function moveScript(folder, names, name, delta) {
  const current = sortScriptNames(folder, names)
  const index = current.indexOf(name)
  if (index < 0) return { names: current, moved: false }
  const target = index + (delta < 0 ? -1 : 1)
  if (target < 0 || target >= current.length) return { names: current, moved: false }
  const next = current.slice()
  next[index] = current[target]
  next[target] = current[index]
  const map = readMap()
  map[folder] = next
  writeMap(map)
  return { names: next, moved: true }
}

/**
 * Forget one script in a folder (after delete / rename / copy).
 *
 * @param folder - folder name ('' = ungrouped).
 * @param name - script name.
 * @returns {void}
 */
export function forgetScript(folder, name) {
  const map = readMap()
  const stored = Array.isArray(map[folder]) ? map[folder] : []
  if (!stored.includes(name)) return
  map[folder] = stored.filter((entry) => entry !== name)
  writeMap(map)
}

/**
 * Read the stored order for one folder (mainly for diagnostics / tests).
 *
 * @param folder - folder name ('' = ungrouped).
 * @returns the stored names (empty when nothing was moved).
 */
export function storedOrder(folder) {
  const map = readMap()
  return Array.isArray(map[folder]) ? map[folder].slice() : []
}

/**
 * Move the stored order from one folder key to another (folder rename).
 *
 * @param from - old folder name.
 * @param to - new folder name.
 * @returns {void}
 */
export function renameFolderOrder(from, to) {
  const map = readMap()
  if (!Array.isArray(map[from])) return
  map[to] = map[from]
  delete map[from]
  writeMap(map)
}

/**
 * Drop the stored order of a folder (folder delete; its scripts become ungrouped).
 *
 * @param folder - folder name.
 * @returns {void}
 */
export function forgetFolder(folder) {
  const map = readMap()
  if (!Object.prototype.hasOwnProperty.call(map, folder)) return
  delete map[folder]
  writeMap(map)
}
