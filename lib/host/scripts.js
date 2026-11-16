/**
 * Saved scripts (CONTRACTS.md §11.3 + §14).
 *
 * A script is *pure data*: a named, parameterized step program stored as one
 * JSON file per script under `<dataDir>/scripts/<name>.json`. Nothing is
 * evaluated or executed from the file, and definitions carrying credential-like
 * fields are refused so a script can never become a secret store:
 *
 * - `save()` normalizes with {@link normalizeScript}, which validates `steps`
 *   with {@link normalizeScriptProgram} (rich v3 steps included), normalizes
 *   `folder`, rejects secret fields and persists atomically.
 * - `render()` substitutes `{{param}}` placeholders (through
 *   `renderScriptProgram` → `renderTemplates`) in
 *   `send`/`log`/`set.value`/condition strings,
 *   applying declared defaults; a missing parameter without a default is a
 *   `MISSING_PARAM` error. Flat step programs keep the exact §11.1 shape, so the
 *   flat batch runner keeps working; rich programs are rendered through the
 *   whole tree for previews.
 * - `list()` tolerates garbage on disk (logs a warning, skips the file) so one
 *   hand-edited script cannot break the script panel.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_SCRIPT_VARIABLES, normalizeScriptProgram, renderScriptProgram } from './script-lang.js'
import { coded, ensureDir, writeJsonAtomic } from './util.js'

/** Accepted script and parameter name shape. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** Longest accepted description. */
const MAX_DESCRIPTION = 200
/** Longest accepted folder name. */
const MAX_FOLDER = 64
/** Longest accepted parameter description. */
const MAX_PARAM_DESCRIPTION = 200
/** Largest accepted parameter default value (bytes). */
const MAX_PARAM_DEFAULT_BYTES = 4096
/** Field names that would turn a script into a secret store. */
const SECRET_KEYS = new Set(['password', 'privatekey', 'passphrase'])
/** Guard against pathological nesting in untrusted JSON. */
const MAX_DEPTH = 32
/** File suffix for one stored script. */
const FILE_SUFFIX = '.json'
/** Control characters a folder name must not contain. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * @typedef {object} ScriptParamSpec
 * @property {string} [default] value used when the caller omits the parameter.
 * @property {string} [description] human readable help.
 */

/**
 * @typedef {object} ScriptDefinition
 * @property {string} name
 * @property {string} description
 * @property {string} folder grouping name; `''` means ungrouped.
 * @property {Record<string, ScriptParamSpec>} params
 * @property {import('./script-lang.js').ScriptStep[]} steps
 * @property {number} updatedAt epoch ms.
 */

/**
 * @typedef {object} ScriptSummary
 * @property {string} name
 * @property {string} description
 * @property {string} folder grouping name; `''` means ungrouped.
 * @property {Record<string, ScriptParamSpec>} params
 * @property {number} stepCount
 * @property {number} updatedAt
 */

/**
 * Validate and normalize a script definition.
 *
 * Errors use `BAD_SCRIPT` for shape/secret problems; a malformed `steps` list
 * keeps the `BAD_STEPS` code from {@link normalizeScriptProgram} so callers can
 * tell the two apart.
 * @param {unknown} input candidate definition.
 * @returns {Omit<ScriptDefinition, 'updatedAt'>} normalized definition.
 * @throws {import('./util.js').CodedError} `BAD_SCRIPT` / `BAD_STEPS`.
 */
export function normalizeScript(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw coded('BAD_SCRIPT', 'a script must be a JSON object')
  }
  // Scan the raw input first: normalization would silently drop a stray
  // `password` field, which is exactly the case this guard exists for.
  assertNoSecrets(input, 'script', 0)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!NAME_PATTERN.test(name)) {
    throw coded('BAD_SCRIPT', `script name must match ${NAME_PATTERN.source}`)
  }
  let description = ''
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') throw coded('BAD_SCRIPT', 'script description must be a string')
    description = input.description.trim()
    if (description.length > MAX_DESCRIPTION) {
      throw coded('BAD_SCRIPT', `script description must be at most ${MAX_DESCRIPTION} characters`)
    }
  }
  const folder = normalizeFolder(input.folder)
  const params = normalizeParams(input.params)
  if (input.steps === undefined || input.steps === null) throw coded('BAD_SCRIPT', 'script steps are required')
  const steps = normalizeScriptProgram(input.steps)
  return { name, description, folder, params, steps }
}

/**
 * Normalize a script folder name (§13/§14): trimmed, at most 64 characters, no
 * control characters, `''` for "ungrouped".
 * @param {unknown} raw candidate folder.
 * @returns {string} normalized folder.
 */
function normalizeFolder(raw) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw coded('BAD_SCRIPT', 'script folder must be a string')
  const folder = raw.trim()
  if (folder.length > MAX_FOLDER) {
    throw coded('BAD_SCRIPT', `script folder must be at most ${MAX_FOLDER} characters`)
  }
  if (CONTROL_CHARS.test(folder)) throw coded('BAD_SCRIPT', 'script folder must not contain control characters')
  return folder
}


/**
 * Normalize the declared parameters of a script.
 * @param {unknown} raw candidate params object.
 * @returns {Record<string, ScriptParamSpec>} normalized params.
 */
function normalizeParams(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw coded('BAD_SCRIPT', 'script params must be an object')
  /** @type {Record<string, ScriptParamSpec>} */
  const params = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!NAME_PATTERN.test(key)) {
      throw coded('BAD_SCRIPT', `parameter name "${key}" must match ${NAME_PATTERN.source}`)
    }
    if (value === undefined || value === null) {
      params[key] = {}
      continue
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw coded('BAD_SCRIPT', `parameter "${key}" must be an object with optional default/description`)
    }
    /** @type {ScriptParamSpec} */
    const spec = {}
    if (value.default !== undefined) {
      if (typeof value.default !== 'string') {
        throw coded('BAD_SCRIPT', `parameter "${key}".default must be a string`)
      }
      if (Buffer.byteLength(value.default, 'utf8') > MAX_PARAM_DEFAULT_BYTES) {
        throw coded('BAD_SCRIPT', `parameter "${key}".default exceeds ${MAX_PARAM_DEFAULT_BYTES} bytes`)
      }
      spec.default = value.default
    }
    if (value.description !== undefined) {
      if (typeof value.description !== 'string') {
        throw coded('BAD_SCRIPT', `parameter "${key}".description must be a string`)
      }
      const description = value.description.trim()
      if (description.length > MAX_PARAM_DESCRIPTION) {
        throw coded('BAD_SCRIPT', `parameter "${key}".description must be at most ${MAX_PARAM_DESCRIPTION} characters`)
      }
      spec.description = description
    }
    params[key] = spec
  }
  if (Object.keys(params).length > MAX_SCRIPT_VARIABLES) {
    throw coded('BAD_SCRIPT', `at most ${MAX_SCRIPT_VARIABLES} script parameters are allowed`)
  }
  return params
}

/**
 * Reject any password/privateKey/passphrase field anywhere in a definition.
 * @param {unknown} value candidate subtree.
 * @param {string} path JSON path for the error message.
 * @param {number} depth recursion depth.
 * @returns {void}
 */
function assertNoSecrets(value, path, depth) {
  if (depth > MAX_DEPTH) throw coded('BAD_SCRIPT', 'script definition is nested too deeply')
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`, depth + 1))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      throw coded('BAD_SCRIPT', `script definitions must not contain secret fields (found ${path}.${key})`)
    }
    assertNoSecrets(entry, `${path}.${key}`, depth + 1)
  }
}

/**
 * Build the list-facing summary of a definition.
 * @param {{ name: string, description?: string, folder?: string, params?: Record<string, ScriptParamSpec>, steps?: unknown[], updatedAt?: number }} definition definition.
 * @returns {ScriptSummary} summary.
 */
/**
 * Count every step, including the bodies of if/else and loop blocks.
 * @param {unknown} steps step list.
 * @returns {number} total step count.
 */
function countSteps(steps) {
  if (!Array.isArray(steps)) return 0
  let total = 0
  for (const step of steps) {
    if (step === null || typeof step !== 'object') continue
    total += 1
    if (Array.isArray(step.then)) total += countSteps(step.then)
    if (Array.isArray(step.else)) total += countSteps(step.else)
    if (Array.isArray(step.steps)) total += countSteps(step.steps)
  }
  return total
}

function summarize(definition) {
  return {
    name: definition.name,
    description: definition.description ?? '',
    folder: typeof definition.folder === 'string' ? definition.folder : '',
    params: definition.params ?? {},
    stepCount: countSteps(definition.steps),
    updatedAt: typeof definition.updatedAt === 'number' && Number.isFinite(definition.updatedAt) ? definition.updatedAt : 0,
  }
}

/**
 * File-backed catalogue of saved scripts.
 */
export class ScriptStore {
  /**
   * @param {object} options options.
   * @param {string} options.dir directory holding one `<name>.json` per script.
   * @param {(level: string, message: string) => void} [options.log] logger.
   */
  constructor({ dir, log } = {}) {
    if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('ScriptStore requires a script directory')
    this.dir = dir
    this.log = typeof log === 'function' ? log : () => {}
  }

  /**
   * @param {string} name validated script name.
   * @returns {string} absolute file path.
   */
  fileFor(name) {
    return join(this.dir, `${name}${FILE_SUFFIX}`)
  }

  /**
   * Validate a script name, throwing a coded error on bad input.
   * @param {unknown} name candidate name.
   * @returns {string} trimmed, valid name.
   */
  validateName(name) {
    const value = typeof name === 'string' ? name.trim() : ''
    if (!NAME_PATTERN.test(value)) throw coded('BAD_SCRIPT', `script name must match ${NAME_PATTERN.source}`)
    return value
  }

  /**
   * Create the script directory.
   * @returns {Promise<void>} completion.
   */
  async init() {
    await ensureDir(this.dir)
  }

  /**
   * Summaries of every readable script, sorted by name.
   * @returns {Promise<ScriptSummary[]>} summaries.
   */
  async list() {
    await this.init()
    let files
    try {
      files = await readdir(this.dir)
    } catch (error) {
      this.log('warn', `[aiterm] cannot read script directory ${this.dir}: ${errorMessage(error)}`)
      return []
    }
    /** @type {ScriptSummary[]} */
    const summaries = []
    for (const file of files.filter((entry) => entry.endsWith(FILE_SUFFIX))) {
      const name = file.slice(0, -FILE_SUFFIX.length)
      if (!NAME_PATTERN.test(name)) {
        this.log('warn', `[aiterm] ignoring script file with an invalid name: ${file}`)
        continue
      }
      const definition = await this.readDefinition(name)
      if (definition === undefined) continue
      summaries.push(summarize(definition))
    }
    summaries.sort((left, right) => left.name.localeCompare(right.name))
    return summaries
  }

  /**
   * Load one script.
   * @param {string} name script name.
   * @returns {Promise<ScriptDefinition | undefined>} definition, or `undefined` when absent.
   * @throws {import('./util.js').CodedError} `BAD_SCRIPT` for an invalid name.
   */
  async get(name) {
    const safe = this.validateName(name)
    return this.readDefinition(safe)
  }

  /**
   * Validate and persist a script (atomic replace).
   * @param {unknown} input definition (raw JSON from the browser or the model).
   * @param {'human' | 'ai'} [actor] caller, for the audit log only.
   * @returns {Promise<ScriptSummary>} stored summary.
   * @throws {import('./util.js').CodedError} `BAD_SCRIPT` / `BAD_STEPS` / `BAD_ACTOR`.
   */
  async save(input, actor = 'human') {
    if (actor !== 'human' && actor !== 'ai') throw coded('BAD_ACTOR', "actor must be 'human' or 'ai'")
    const definition = normalizeScript(input)
    const record = { ...definition, updatedAt: Date.now() }
    await writeJsonAtomic(this.fileFor(definition.name), record)
    this.log('info', `[aiterm] saved script ${definition.name} (${actor})`)
    return summarize(record)
  }

  /**
   * Delete one script.
   * @param {string} name script name.
   * @returns {Promise<boolean>} whether a file was removed.
   * @throws {import('./util.js').CodedError} `BAD_SCRIPT` for an invalid name.
   */
  async delete(name) {
    const safe = this.validateName(name)
    const file = this.fileFor(safe)
    try {
      await stat(file)
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return false
      this.log('warn', `[aiterm] cannot stat script ${file}: ${errorMessage(error)}`)
      return false
    }
    try {
      await rm(file, { force: true })
    } catch (error) {
      this.log('warn', `[aiterm] cannot delete script ${file}: ${errorMessage(error)}`)
      return false
    }
    this.log('info', `[aiterm] deleted script ${safe}`)
    return true
  }

  /**
   * Render a script definition into executable steps.
   *
   * Templates are substituted through the whole step tree (via
   * {@link import('./script-lang.js').renderScriptProgram}), so flat v2 programs
   * keep exactly the §11.1 step shape the batch runner expects while rich v3
   * programs can be previewed too. `runScript` resolves parameters itself; this
   * method is for callers that execute the rendered steps directly.
   * @param {ScriptDefinition} definition loaded definition.
   * @param {Record<string, unknown>} [params] caller-supplied parameter values.
   * @returns {import('./script-lang.js').ScriptStep[]} rendered, normalized steps.
   * @throws {import('./util.js').CodedError} `MISSING_PARAM`, `BAD_PARAM`, `BAD_STEPS` or `BAD_SCRIPT`.
   */
  render(definition, params = {}) {
    const source = definition !== null && typeof definition === 'object' ? definition : {}
    const declared =
      source.params !== null && typeof source.params === 'object' && !Array.isArray(source.params) ? source.params : {}
    const provided = params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}
    /** @type {Record<string, string>} */
    const values = {}
    for (const [key, entry] of Object.entries(declared)) {
      const spec = entry !== null && typeof entry === 'object' ? entry : {}
      const given = provided[key]
      if (given !== undefined && given !== null) {
        if (typeof given === 'string') values[key] = given
        else if (typeof given === 'number' || typeof given === 'boolean') values[key] = String(given)
        else throw coded('BAD_PARAM', `parameter "${key}" must be a string, number or boolean`)
      } else if (spec.default !== undefined) {
        values[key] = String(spec.default)
      } else {
        throw coded('MISSING_PARAM', `missing required script parameter: ${key}`)
      }
    }
    const steps = normalizeScriptProgram(Array.isArray(source.steps) ? source.steps : [])
    return renderScriptProgram(steps, values)
  }

  /**
   * Read and validate one script file, tolerating malformed content.
   * @param {string} name valid script name.
   * @returns {Promise<ScriptDefinition | undefined>} definition or `undefined`.
   */
  async readDefinition(name) {
    const file = this.fileFor(name)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') {
        this.log('warn', `[aiterm] cannot read script ${file}: ${errorMessage(error)}`)
      }
      return undefined
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      this.log('warn', `[aiterm] ignoring malformed script file ${file}`)
      return undefined
    }
    let definition
    try {
      definition = normalizeScript(parsed)
    } catch (error) {
      this.log('warn', `[aiterm] ignoring invalid script file ${file}: ${errorMessage(error)}`)
      return undefined
    }
    if (definition.name !== name) {
      this.log('warn', `[aiterm] ignoring script file ${file}: it declares name "${definition.name}"`)
      return undefined
    }
    const updatedAt =
      parsed !== null && typeof parsed === 'object' && typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0
    return { ...definition, updatedAt }
  }
}

/**
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} error thrown value.
 * @returns {string | undefined} Node error code such as `ENOENT`.
 */
function errorCodeOf(error) {
  if (error === null || typeof error !== 'object') return undefined
  const code = /** @type {{ code?: unknown }} */ (error).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}
