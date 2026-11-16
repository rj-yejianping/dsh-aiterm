/**
 * v3 scripting language (CONTRACTS.md §14).
 *
 * A script is *pure data*: nested declarative steps (`send`, `delay`, `set`,
 * `log`, `expect`, `if`, `loop`) that are validated up front by
 * {@link normalizeScriptProgram} and then interpreted by {@link runScript}
 * against one or more live sessions through the same registry primitives the
 * flat batch runner uses (`write(id, text, 'ai')`, `waitFor`, `readDelta`,
 * `readScreen`). Nothing is evaluated as code.
 *
 * Three rules shape the design:
 *
 * 1. **Strict input, forgiving runtime.** Malformed programs throw
 *    `coded('BAD_SCRIPT')` / `coded('BAD_STEPS')` with a JSON-path-like location
 *    (`steps[2].then[0].loop`). Once validation passes, a failing step (a denied
 *    write, a failed expectation, a timeout) is recorded as a {@link StepResult}
 *    and never rejects the returned promise.
 * 2. **Per-target state.** Every target gets its own variables and its own
 *    "checkpoint" (the byte position up to which output has been consumed for
 *    condition evaluation), so parallel fan-out cannot leak state across
 *    sessions.
 * 3. **Bounded output.** Step text is capped per step (8 KiB) and across the
 *    whole result, variables are capped (50 variables, 8 KiB each), and the
 *    whole run is bounded by `maxTotalMs` (default 10 minutes).
 *
 * Checkpoint semantics (§14.1, revised 2026-10-21): conditions and `expect`
 * evaluate "output produced since the last condition evaluation", not since the
 * last `send`. Every target therefore keeps *two* positions per session: a
 * condition checkpoint (moved only by `if`/`loop.while`/`loop.until`/`expect`,
 * to the current end of output) and a readback position (moved by `send`, so a
 * step returns only its own new output). This is what makes the natural
 * `{ send, waitFor }, { if: { match } }` sequence see the send's output while
 * still preventing two consecutive conditions from matching the same text.
 * Condition text is the bounded retained tail, never the whole scrollback.
 */

import { normalizeSteps } from './batch.js'
import { boundInteger, coded, truncateTail } from './util.js'

/** Hard cap on the total number of steps (top level + nested). */
export const MAX_SCRIPT_STEPS = 500
/** Maximum nesting depth of blocks (`if`/`loop`); top-level steps have depth 0. */
export const MAX_SCRIPT_DEPTH = 5
/** Hard cap on one loop's iteration count. */
export const MAX_LOOP_ITERATIONS = 1000
/** Default loop iteration cap, used when the loop gives no explicit count. */
export const DEFAULT_LOOP_ITERATIONS = 100
/** Maximum number of distinct variables (seeded params + `set` + `capture`). */
export const MAX_SCRIPT_VARIABLES = 50
/** Maximum byte length of one variable value. */
export const MAX_VARIABLE_VALUE_BYTES = 8 * 1024
/** Default overall wall-clock budget for one script run (ms). */
export const DEFAULT_SCRIPT_TOTAL_MS = 600_000
/** Upper bound for `options.maxTotalMs` (ms). */
export const MAX_SCRIPT_TOTAL_MS = 3_600_000

/** Largest accepted rendered `send` payload (matches the registry input limit). */
const MAX_SEND_BYTES = 64 * 1024
/** Longest accepted condition string / pattern source. */
const MAX_CONDITION_LENGTH = 2048
/** Guard against pathological `not`/`all`/`any` nesting in untrusted JSON. */
const MAX_CONDITION_DEPTH = 8
/** Largest accepted `delay` step (ms). */
const MAX_DELAY_MS = 3_600_000
/** Per-step readback / log budget (bytes); inherited from the flat runner. */
const READ_BYTES = 8192
/** Whole-result text budget, mirroring `runBatch`'s `maxTotalBytes` default. */
const MAX_RESULT_TEXT_BYTES = 64 * 1024
/** Number of `log` entries retained in the run result. */
const MAX_LOG_ENTRIES = 200
/** Total bytes retained across all `log` entries. */
const MAX_LOG_TOTAL_BYTES = 64 * 1024
/** Cap on the compiled-regex cache kept for one run. */
const MAX_REGEX_CACHE = 200
/**
 * Upper bound on the delta chunks walked to reach the tail of the output when a
 * condition is evaluated. Conditions only ever see a bounded tail, never the
 * whole scrollback.
 */
const MAX_CONDITION_READ_ROUNDS = 8

/** A script variable / capture name (§14.1). */
const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/
/** A script parameter name; kept broad for backwards compatibility (§11.3). */
const PARAM_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** `{{name}}` placeholder; unknown names stay literal. */
const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z0-9_-]{1,64})\s*\}\}/g

/** Step discriminators of the §14.1 union. */
const STEP_KINDS = new Set(['send', 'delay', 'set', 'log', 'expect', 'if', 'loop'])
/** Fields a `send` step may carry (the §11.1 batch step plus `capture`). */
const SEND_FIELDS = new Set(['sessionId', 'send', 'enter', 'waitFor', 'waitMs', 'read', 'maxLines', 'capture'])
/** Condition discriminators of the §14.1 union. */
const CONDITION_KINDS = new Set(['always', 'match', 'contains', 'variable', 'not', 'all', 'any'])
/** Operators a `variable` condition may carry. */
const VARIABLE_OPERATORS = new Set(['equals', 'notEquals', 'contains', 'matches'])
/** Fields a `loop` block may carry. */
const LOOP_FIELDS = new Set(['count', 'while', 'until', 'maxIterations'])

/**
 * @typedef {object} SendStep
 * @property {string} send text to write (templated).
 * @property {string} [sessionId] override the fan-out target for this step.
 * @property {boolean} [enter] append `\r`.
 * @property {{ pattern?: string, idleMs?: number, timeoutMs: number }} [waitFor]
 * @property {number} [waitMs]
 * @property {'delta' | 'screen' | 'none'} [read] defaults to `'delta'`.
 * @property {number} [maxLines]
 * @property {string} [capture] variable receiving the readback text.
 */

/**
 * @typedef {object} DelayStep
 * @property {number} delay milliseconds, `> 0`.
 */

/**
 * @typedef {object} SetStep
 * @property {string} set variable name.
 * @property {string} value value (templated).
 */

/**
 * @typedef {object} LogStep
 * @property {string} log human readable message (templated).
 */

/**
 * @typedef {object} ExpectStep
 * @property {object} expect condition.
 * @property {'stop' | 'continue'} onFail defaults to `'stop'`.
 * @property {string} [capture] variable receiving the observed checkpoint text.
 */

/**
 * @typedef {object} IfStep
 * @property {object} if condition.
 * @property {object[]} then non-empty nested step list.
 * @property {object[]} [else] nested step list.
 */

/**
 * @typedef {object} LoopStep
 * @property {{ count?: number, while?: object, until?: object, maxIterations: number }} loop
 * @property {object[]} steps non-empty nested step list.
 */

/**
 * @typedef {SendStep | DelayStep | SetStep | LogStep | ExpectStep | IfStep | LoopStep} ScriptStep
 */

/**
 * @typedef {object} StepResult
 * @property {number} index index of the step within its containing step list
 *   (siblings share a numbering; `path` disambiguates nesting).
 * @property {number} depth nesting depth (`0` at top level).
 * @property {string} path dotted path such as `"3"` or `"3.2"` (top-level index
 *   first, then the index within each nested block).
 * @property {string} kind `send | delay | set | log | expect | if | loop`.
 * @property {boolean} ok
 * @property {boolean} [matched] condition / wait verdict.
 * @property {string} [text] capped readback (or log message / observed condition text).
 * @property {string} [error]
 * @property {string} [code]
 */

/**
 * @typedef {object} ScriptRunResult
 * @property {boolean} ok
 * @property {boolean} timedOut
 * @property {string} [label]
 * @property {Array<{ sessionId: string, ok: boolean, steps: StepResult[], stoppedAt?: number }>} runs
 *   `stoppedAt` is the top-level index of the step that stopped the run (failure or timeout).
 * @property {Record<string, string>} variables merged final variables (later targets win).
 * @property {string[]} logs
 */

/**
 * Validate and normalize a complete step program (§14.1) against the hard caps
 * of §14.2. The result is plain JSON (no RegExp instances), so it can be stored
 * back into a script file.
 *
 * Structural problems (step list shape, step union, unknown fields, invalid
 * batch-step fields) use `BAD_STEPS`, matching the flat runner; everything the
 * v3 interpreter adds (conditions, loop bounds, variable/cap rules) uses
 * `BAD_SCRIPT`. Error messages carry a JSON-path-like location.
 * @param {unknown} steps candidate step list.
 * @returns {ScriptStep[]} normalized program.
 * @throws {import('./util.js').CodedError} `BAD_SCRIPT` / `BAD_STEPS`.
 */
export function normalizeScriptProgram(steps) {
  if (!Array.isArray(steps)) throw coded('BAD_STEPS', 'script steps must be an array')
  /** @type {{ steps: number, variables: Set<string> }} */
  const counter = { steps: 0, variables: new Set() }
  return normalizeStepList(steps, 'steps', 0, counter)
}

/**
 * Normalize one step list.
 * @param {unknown} raw candidate list.
 * @param {string} path location used in error messages.
 * @param {number} depth nesting depth of the steps in this list.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {ScriptStep[]} normalized list.
 */
function normalizeStepList(raw, path, depth, counter) {
  if (!Array.isArray(raw)) throw coded('BAD_STEPS', `${path} must be an array`)
  return raw.map((entry, index) => normalizeStep(entry, `${path}[${index}]`, depth, counter))
}

/**
 * Normalize one step of the §14.1 union.
 * @param {unknown} raw candidate step.
 * @param {string} path location used in error messages.
 * @param {number} depth nesting depth.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {ScriptStep} normalized step.
 */
function normalizeStep(raw, path, depth, counter) {
  if (depth > MAX_SCRIPT_DEPTH) {
    throw coded('BAD_SCRIPT', `${path}: steps may be nested at most ${MAX_SCRIPT_DEPTH} levels deep`)
  }
  counter.steps += 1
  if (counter.steps > MAX_SCRIPT_STEPS) {
    throw coded('BAD_SCRIPT', `${path}: at most ${MAX_SCRIPT_STEPS} steps are allowed (including nested steps)`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coded('BAD_STEPS', `${path} must be an object`)
  }
  const kinds = Object.keys(raw).filter((key) => STEP_KINDS.has(key))
  if (kinds.length !== 1) {
    throw coded('BAD_STEPS', `${path} must have exactly one of send, delay, set, log, expect, if, loop`)
  }
  const kind = kinds[0]
  if (kind === 'send') return normalizeSendStep(raw, path, counter)
  if (kind === 'delay') return normalizeDelayStep(raw, path)
  if (kind === 'set') return normalizeSetStep(raw, path, counter)
  if (kind === 'log') return normalizeLogStep(raw, path)
  if (kind === 'expect') return normalizeExpectStep(raw, path, counter)
  if (kind === 'if') return normalizeIfStep(raw, path, depth, counter)
  return normalizeLoopStep(raw, path, depth, counter)
}

/**
 * Reject fields a step of a given kind must not carry.
 * @param {Record<string, unknown>} raw candidate step.
 * @param {string} path location.
 * @param {Set<string>} allowed accepted field names.
 * @returns {void}
 */
function assertOnlyFields(raw, path, allowed) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw coded('BAD_STEPS', `${path}.${key} is not a supported field for this step`)
  }
}

/**
 * Normalize a `send` step by delegating the batch half to
 * {@link import('./batch.js').normalizeSteps}, so both runners interpret the
 * exact same fields (`read` default, `waitFor` defaults, caps).
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {SendStep} normalized step.
 */
function normalizeSendStep(raw, path, counter) {
  assertOnlyFields(raw, path, SEND_FIELDS)
  if (typeof raw.send !== 'string') throw coded('BAD_STEPS', `${path}.send must be a string`)
  if (raw.send.length === 0) throw coded('BAD_STEPS', `${path}.send must be a non-empty string`)
  /** @type {Record<string, unknown>} */
  const batchStep = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'capture') batchStep[key] = raw[key]
  }
  /** @type {any} */
  let normalized
  try {
    normalized = normalizeSteps([batchStep])[0]
  } catch (error) {
    throw recodeBatchError(error, path)
  }
  if (raw.capture !== undefined) {
    normalized.capture = requireVariableName(raw.capture, `${path}.capture`, counter)
  }
  return normalized
}

/**
 * Re-throw a flat-runner error with the script path substituted in.
 * @param {unknown} error thrown value.
 * @param {string} path location in the script.
 * @returns {import('./util.js').CodedError} rewritten error.
 */
function recodeBatchError(error, path) {
  const code = errorCode(error) ?? 'BAD_STEPS'
  const message = errorMessage(error).replace(/steps\[0\]/g, path)
  return coded(code, message)
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @returns {DelayStep} normalized step.
 */
function normalizeDelayStep(raw, path) {
  assertOnlyFields(raw, path, new Set(['delay']))
  const value = raw.delay
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw coded('BAD_SCRIPT', `${path}.delay must be a positive number of milliseconds`)
  }
  if (value > MAX_DELAY_MS) {
    throw coded('BAD_SCRIPT', `${path}.delay must be at most ${MAX_DELAY_MS} milliseconds`)
  }
  return { delay: value }
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {SetStep} normalized step.
 */
function normalizeSetStep(raw, path, counter) {
  assertOnlyFields(raw, path, new Set(['set', 'value']))
  const name = requireVariableName(raw.set, `${path}.set`, counter)
  if (typeof raw.value !== 'string') throw coded('BAD_SCRIPT', `${path}.value must be a string`)
  if (Buffer.byteLength(raw.value, 'utf8') > MAX_VARIABLE_VALUE_BYTES) {
    throw coded('BAD_SCRIPT', `${path}.value exceeds ${MAX_VARIABLE_VALUE_BYTES} bytes`)
  }
  return { set: name, value: raw.value }
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @returns {LogStep} normalized step.
 */
function normalizeLogStep(raw, path) {
  assertOnlyFields(raw, path, new Set(['log']))
  if (typeof raw.log !== 'string') throw coded('BAD_SCRIPT', `${path}.log must be a string`)
  if (Buffer.byteLength(raw.log, 'utf8') > MAX_VARIABLE_VALUE_BYTES) {
    throw coded('BAD_SCRIPT', `${path}.log exceeds ${MAX_VARIABLE_VALUE_BYTES} bytes`)
  }
  return { log: raw.log }
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {ExpectStep} normalized step.
 */
function normalizeExpectStep(raw, path, counter) {
  assertOnlyFields(raw, path, new Set(['expect', 'onFail', 'capture']))
  const condition = normalizeCondition(raw.expect, `${path}.expect`, 0)
  let onFail = 'stop'
  if (raw.onFail !== undefined) {
    if (raw.onFail !== 'stop' && raw.onFail !== 'continue') {
      throw coded('BAD_SCRIPT', `${path}.onFail must be 'stop' or 'continue'`)
    }
    onFail = raw.onFail
  }
  /** @type {ExpectStep} */
  const step = { expect: condition, onFail }
  if (raw.capture !== undefined) step.capture = requireVariableName(raw.capture, `${path}.capture`, counter)
  return step
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @param {number} depth nesting depth.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {IfStep} normalized step.
 */
function normalizeIfStep(raw, path, depth, counter) {
  assertOnlyFields(raw, path, new Set(['if', 'then', 'else']))
  const condition = normalizeCondition(raw.if, `${path}.if`, 0)
  if (!Array.isArray(raw.then) || raw.then.length === 0) {
    throw coded('BAD_SCRIPT', `${path}.then must be a non-empty array of steps`)
  }
  const thenSteps = normalizeStepList(raw.then, `${path}.then`, depth + 1, counter)
  /** @type {IfStep} */
  const step = { if: condition, then: thenSteps }
  if (raw.else !== undefined) {
    if (!Array.isArray(raw.else) || raw.else.length === 0) {
      throw coded('BAD_SCRIPT', `${path}.else must be a non-empty array of steps`)
    }
    step.else = normalizeStepList(raw.else, `${path}.else`, depth + 1, counter)
  }
  return step
}

/**
 * @param {Record<string, any>} raw candidate step.
 * @param {string} path location.
 * @param {number} depth nesting depth.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {LoopStep} normalized step.
 */
function normalizeLoopStep(raw, path, depth, counter) {
  assertOnlyFields(raw, path, new Set(['loop', 'steps']))
  const loopRaw = raw.loop
  if (loopRaw === null || typeof loopRaw !== 'object' || Array.isArray(loopRaw)) {
    throw coded('BAD_SCRIPT', `${path}.loop must be an object`)
  }
  for (const key of Object.keys(loopRaw)) {
    if (!LOOP_FIELDS.has(key)) throw coded('BAD_SCRIPT', `${path}.loop.${key} is not a supported field`)
  }
  /** @type {{ count?: number, while?: object, until?: object, maxIterations: number }} */
  const loop = { maxIterations: DEFAULT_LOOP_ITERATIONS }
  if (loopRaw.count !== undefined) {
    loop.count = requireBoundedInteger(loopRaw.count, `${path}.loop.count`, 1, MAX_LOOP_ITERATIONS)
  }
  if (loopRaw.while !== undefined) loop.while = normalizeCondition(loopRaw.while, `${path}.loop.while`, 0)
  if (loopRaw.until !== undefined) loop.until = normalizeCondition(loopRaw.until, `${path}.loop.until`, 0)
  if (loop.count === undefined && loop.while === undefined && loop.until === undefined) {
    throw coded('BAD_SCRIPT', `${path}.loop must declare at least one of count, while, until`)
  }
  if (loopRaw.maxIterations !== undefined) {
    loop.maxIterations = requireBoundedInteger(loopRaw.maxIterations, `${path}.loop.maxIterations`, 1, MAX_LOOP_ITERATIONS)
  } else if (loop.count !== undefined) {
    // A fixed-count loop runs exactly `count` times; the default iteration cap
    // only applies when the loop length is not already explicit.
    loop.maxIterations = loop.count
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw coded('BAD_SCRIPT', `${path}.steps must be a non-empty array of steps`)
  }
  const body = normalizeStepList(raw.steps, `${path}.steps`, depth + 1, counter)
  return { loop, steps: body }
}

/**
 * Normalize a condition (§14.1).
 * @param {unknown} raw candidate condition.
 * @param {string} path location.
 * @param {number} depth `not`/`all`/`any` nesting depth.
 * @returns {Record<string, any>} normalized condition (plain JSON).
 */
function normalizeCondition(raw, path, depth) {
  if (depth > MAX_CONDITION_DEPTH) {
    throw coded('BAD_SCRIPT', `${path}: conditions may be nested at most ${MAX_CONDITION_DEPTH} levels deep`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coded('BAD_SCRIPT', `${path} must be a condition object`)
  }
  // `variable` is resolved first because it shares the `contains`/`matches`
  // spellings with the standalone text conditions.
  let kind
  if (raw.variable !== undefined) {
    kind = 'variable'
    const conflicting = Object.keys(raw).filter(
      (key) => CONDITION_KINDS.has(key) && key !== 'variable' && !VARIABLE_OPERATORS.has(key),
    )
    if (conflicting.length > 0) {
      throw coded('BAD_SCRIPT', `${path} must have exactly one of always, match, contains, variable, not, all, any`)
    }
  } else {
    const kinds = Object.keys(raw).filter((key) => CONDITION_KINDS.has(key))
    if (kinds.length !== 1) {
      throw coded('BAD_SCRIPT', `${path} must have exactly one of always, match, contains, variable, not, all, any`)
    }
    kind = kinds[0]
  }
  if (kind === 'always') {
    assertOnlyFields(raw, path, new Set(['always']))
    if (raw.always !== true) throw coded('BAD_SCRIPT', `${path}.always must be true`)
    return { always: true }
  }
  if (kind === 'match') {
    assertOnlyFields(raw, path, new Set(['match']))
    const pattern = requireConditionString(raw.match, `${path}.match`)
    assertCompilableRegex(pattern, `${path}.match`)
    return { match: pattern }
  }
  if (kind === 'contains') {
    assertOnlyFields(raw, path, new Set(['contains']))
    return { contains: requireConditionString(raw.contains, `${path}.contains`) }
  }
  if (kind === 'variable') {
    assertOnlyFields(raw, path, new Set(['variable', ...VARIABLE_OPERATORS]))
    const name = raw.variable
    if (typeof name !== 'string' || !VARIABLE_NAME_PATTERN.test(name)) {
      throw coded('BAD_SCRIPT', `${path}.variable must be a variable name matching ${VARIABLE_NAME_PATTERN.source}`)
    }
    const operators = Object.keys(raw).filter((key) => VARIABLE_OPERATORS.has(key))
    if (operators.length !== 1) {
      throw coded('BAD_SCRIPT', `${path} must have exactly one of equals, notEquals, contains, matches`)
    }
    const operator = operators[0]
    const value = requireConditionString(raw[operator], `${path}.${operator}`)
    if (operator === 'matches') assertCompilableRegex(value, `${path}.matches`)
    /** @type {Record<string, any>} */
    const condition = { variable: name }
    condition[operator] = value
    return condition
  }
  if (kind === 'not') {
    assertOnlyFields(raw, path, new Set(['not']))
    return { not: normalizeCondition(raw.not, `${path}.not`, depth + 1) }
  }
  // `all` / `any`
  assertOnlyFields(raw, path, new Set([kind]))
  if (!Array.isArray(raw[kind]) || raw[kind].length === 0) {
    throw coded('BAD_SCRIPT', `${path}.${kind} must be a non-empty array of conditions`)
  }
  const list = raw[kind].map((entry, index) =>
    normalizeCondition(entry, `${path}.${kind}[${index}]`, depth + 1),
  )
  return { [kind]: list }
}

/**
 * @param {unknown} value candidate string.
 * @param {string} where location.
 * @returns {string} accepted string.
 */
function requireConditionString(value, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw coded('BAD_SCRIPT', `${where} must be a non-empty string`)
  }
  if (value.length > MAX_CONDITION_LENGTH) {
    throw coded('BAD_SCRIPT', `${where} exceeds ${MAX_CONDITION_LENGTH} characters`)
  }
  return value
}

/**
 * Compile a regex early unless the pattern contains a template placeholder (a
 * templated pattern can only be checked once variables are known).
 * @param {string} pattern source.
 * @param {string} where location.
 * @returns {void}
 */
function assertCompilableRegex(pattern, where) {
  if (pattern.includes('{{')) return
  try {
    new RegExp(pattern)
  } catch {
    throw coded('BAD_SCRIPT', `${where} is not a valid regular expression`)
  }
}

/**
 * Register a variable name, enforcing the 50-variable cap with a precise path.
 * @param {unknown} value candidate name.
 * @param {string} where location.
 * @param {{ steps: number, variables: Set<string> }} counter program-wide counters.
 * @returns {string} accepted name.
 */
function requireVariableName(value, where, counter) {
  if (typeof value !== 'string' || !VARIABLE_NAME_PATTERN.test(value)) {
    throw coded('BAD_SCRIPT', `${where} must be a variable name matching ${VARIABLE_NAME_PATTERN.source}`)
  }
  if (!counter.variables.has(value)) {
    if (counter.variables.size >= MAX_SCRIPT_VARIABLES) {
      throw coded('BAD_SCRIPT', `${where}: at most ${MAX_SCRIPT_VARIABLES} variables are allowed in one script`)
    }
    counter.variables.add(value)
  }
  return value
}

/**
 * Validate a bounded integer.
 * @param {unknown} value candidate.
 * @param {string} where location.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} accepted integer.
 */
function requireBoundedInteger(value, where, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw coded('BAD_SCRIPT', `${where} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * Unknown names are left literal: a script that references a parameter the
 * caller did not supply should still be inspectable rather than silently
 * changed. Non-string input is returned unchanged so callers can pass a value
 * through without a type check.
 * @param {unknown} value template text.
 * @param {Record<string, string>} variables variable values.
 * @returns {string} substituted text (or the original value when not a string).
 */
export function renderTemplates(value, variables) {
  if (typeof value !== 'string') return /** @type {any} */ (value)
  const values = variables !== null && typeof variables === 'object' ? variables : {}
  return value.replace(TEMPLATE_PATTERN, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match
    const replacement = values[key]
    if (typeof replacement === 'string') return replacement
    if (typeof replacement === 'number' || typeof replacement === 'boolean') return String(replacement)
    return match
  })
}

/**
 * Render every template in a normalized program against the given variables.
 *
 * Used by `ScriptStore.render()` for previews and for the flat, backwards
 * compatible `render()` path; `runScript` renders per evaluation instead, so a
 * `set` in the middle of a script is visible to later steps.
 * @param {ScriptStep[]} steps normalized program.
 * @param {Record<string, string>} variables variable values.
 * @returns {ScriptStep[]} rendered copy (the input is not mutated).
 */
export function renderScriptProgram(steps, variables) {
  return steps.map((step) => renderScriptStep(step, variables))
}

/**
 * Render one normalized step.
 * @param {ScriptStep} step normalized step.
 * @param {Record<string, string>} variables variable values.
 * @returns {ScriptStep} rendered copy.
 */
function renderScriptStep(step, variables) {
  if (step.send !== undefined) {
    /** @type {SendStep} */
    const next = { ...step, send: renderTemplates(step.send, variables) }
    return next
  }
  if (step.delay !== undefined) return { ...step }
  if (step.set !== undefined) return { ...step, value: renderTemplates(step.value, variables) }
  if (step.log !== undefined) return { ...step, log: renderTemplates(step.log, variables) }
  if (step.expect !== undefined) {
    /** @type {ExpectStep} */
    const next = { ...step, expect: renderCondition(step.expect, variables) }
    return next
  }
  if (step.if !== undefined) {
    /** @type {IfStep} */
    const next = { if: renderCondition(step.if, variables), then: renderScriptProgram(step.then, variables) }
    if (step.else !== undefined) next.else = renderScriptProgram(step.else, variables)
    return next
  }
  const loop = { ...step.loop }
  if (loop.while !== undefined) loop.while = renderCondition(loop.while, variables)
  if (loop.until !== undefined) loop.until = renderCondition(loop.until, variables)
  return { loop, steps: renderScriptProgram(step.steps, variables) }
}

/**
 * Render the string operands of a condition.
 * @param {Record<string, any>} condition normalized condition.
 * @param {Record<string, string>} variables variable values.
 * @returns {Record<string, any>} rendered condition.
 */
function renderCondition(condition, variables) {
  if (condition.always === true) return { always: true }
  // A `variable` condition may carry its own `contains`/`matches` operator, so
  // it must be recognized before the top-level text operators.
  if (condition.variable !== undefined) {
    /** @type {Record<string, any>} */
    const next = { variable: condition.variable }
    for (const operator of VARIABLE_OPERATORS) {
      if (condition[operator] !== undefined) next[operator] = renderTemplates(condition[operator], variables)
    }
    return next
  }
  if (condition.match !== undefined) return { match: renderTemplates(condition.match, variables) }
  if (condition.contains !== undefined) return { contains: renderTemplates(condition.contains, variables) }
  if (condition.not !== undefined) return { not: renderCondition(condition.not, variables) }
  if (condition.all !== undefined) return { all: condition.all.map((entry) => renderCondition(entry, variables)) }
  if (condition.any !== undefined) return { any: condition.any.map((entry) => renderCondition(entry, variables)) }
  return { always: true }
}

/**
 * Execute a normalized script against one or more sessions.
 *
 * Targets run one after another in order unless `options.parallel` is true.
 * Every target gets independent variables and an independent output
 * checkpoint; the result merges the final variables in target order (later
 * targets win).
 * @param {object} registry session registry (see CONTRACTS.md §11.2).
 * @param {unknown} definition script definition (`{ name?, description?, params?, steps }`).
 * @param {object} [options] execution options.
 * @param {Record<string, unknown>} [options.params] script parameters (seeded as variables).
 * @param {string[]} options.targets required session ids; at least one.
 * @param {boolean} [options.stopOnError] default `true`; `false` keeps going after a failed step.
 * @param {number} [options.maxTotalMs] overall budget, default 600000, capped at 3600000.
 * @param {boolean} [options.parallel] run targets concurrently, default `false`.
 * @param {(event: { sessionId: string, stepIndex: number, depth: number, path: string, kind: string, ok: boolean, text?: string, error?: string, code?: string }) => void} [options.onStep]
 *   progress hook; field `stepIndex` is the index within the containing step list and
 *   `path` is the full dotted location (`"3"`, `"3.2"`).
 * @param {(ms: number) => Promise<void>} [options.sleep] injected timer (tests).
 * @param {() => number} [options.now] injected clock (tests).
 * @param {string} [options.label] audit label; defaults to `script:<name>`.
 * @returns {Promise<ScriptRunResult>} run result. Step failures never reject.
 * @throws {import('./util.js').CodedError} `BAD_TARGETS`, `BAD_SCRIPT`, `BAD_STEPS`,
 *   `MISSING_PARAM` or `BAD_PARAM` for invalid input.
 */
export async function runScript(registry, definition, options = {}) {
  const opts = options ?? {}
  const targets = Array.isArray(opts.targets)
    ? opts.targets.filter((target) => typeof target === 'string' && target.trim().length > 0).map((target) => target.trim())
    : []
  if (targets.length === 0) throw coded('BAD_TARGETS', 'at least one target session id is required')
  const def = definition !== null && typeof definition === 'object' && !Array.isArray(definition) ? definition : {}
  const program = normalizeScriptProgram(def.steps)
  const baseVariables = resolveParameters(def.params, opts.params)
  const stopOnError = opts.stopOnError !== false
  const parallel = opts.parallel === true
  const maxTotalMs = boundInteger(opts.maxTotalMs, DEFAULT_SCRIPT_TOTAL_MS, 1, MAX_SCRIPT_TOTAL_MS)
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : undefined
  const label =
    typeof opts.label === 'string' && opts.label.trim().length > 0
      ? opts.label.trim()
      : typeof def.name === 'string' && def.name.trim().length > 0
        ? `script:${def.name.trim()}`
        : undefined
  const deadline = now() + maxTotalMs
  /** @type {{ timedOut: boolean }} */
  const state = { timedOut: false }
  /** @type {string[]} */
  const logs = []
  let logBytes = 0
  let textBudget = MAX_RESULT_TEXT_BYTES
  /** @type {Map<string, RegExp>} */
  const regexCache = new Map()

  /**
   * @returns {number} milliseconds left in the overall budget (never negative).
   */
  const remainingMs = () => Math.max(0, deadline - now())

  /**
   * Cap one step's text against the per-step and whole-result budgets.
   * @param {string | undefined} text candidate text.
   * @returns {string | undefined} capped text, or `undefined` when the budget is gone.
   */
  const takeText = (text) => {
    if (typeof text !== 'string') return undefined
    if (text.length === 0) return ''
    const left = textBudget
    if (left <= 0) return undefined
    const capped = truncateTail(text, Math.min(READ_BYTES, left))
    textBudget = Math.max(0, textBudget - Buffer.byteLength(capped, 'utf8'))
    return capped
  }

  /**
   * Compile (and cache) a regular expression used by a condition.
   * @param {string} source pattern source.
   * @returns {RegExp} compiled expression.
   */
  const compileRegex = (source) => {
    const cached = regexCache.get(source)
    if (cached !== undefined) return cached
    let compiled
    try {
      compiled = new RegExp(source)
    } catch (error) {
      throw coded('BAD_REGEX', `invalid regular expression /${source}/: ${errorMessage(error)}`)
    }
    if (regexCache.size >= MAX_REGEX_CACHE) regexCache.clear()
    regexCache.set(source, compiled)
    return compiled
  }

  /**
   * Read one bounded delta chunk from an explicit position.
   * @param {string} sessionId effective session.
   * @param {string | undefined} cursor position; `undefined` keeps the registry's own reader position.
   * @returns {Promise<{ text?: string, cursor?: string, newBytes?: number }>} payload.
   */
  const readDeltaAt = async (sessionId, cursor) => {
    if (typeof registry.readDelta !== 'function') {
      throw coded('UNSUPPORTED', 'the session registry does not support readDelta')
    }
    /** @type {Record<string, unknown>} */
    const readOptions = { maxBytes: READ_BYTES }
    if (cursor !== undefined) readOptions.cursor = cursor
    return toReadPayload(await registry.readDelta(sessionId, readOptions))
  }

  /**
   * Make sure both per-session positions exist.
   *
   * Two independent positions are kept:
   * - `cursors` is the *condition checkpoint*, advanced only when a condition
   *   (`if`, `loop.while`, `loop.until`, `expect`) is evaluated;
   * - `readCursors` is the readback position, advanced when a `send` step
   *   returns output.
   *
   * Splitting them is what makes `{ send: 'x', waitFor: … }, { if: { match: … } }`
   * work: the send's readback consumes its own output without hiding it from the
   * next condition (§14.1). Both start at the current end of output, discovered
   * with a screen read (whose cursor is the total output offset) so a fresh
   * script never re-matches scrollback from before it started.
   * @param {{ cursors: Map<string, string>, readCursors: Map<string, string>, ready: Set<string> }} run per-target state.
   * @param {string} sessionId effective session.
   * @returns {Promise<void>} completion.
   */
  const ensureSessionCursors = async (run, sessionId) => {
    if (run.ready.has(sessionId)) return
    run.ready.add(sessionId)
    if (run.cursors.has(sessionId) && run.readCursors.has(sessionId)) return
    let cursor = '0'
    if (typeof registry.readScreen === 'function') {
      try {
        const payload = toReadPayload(await registry.readScreen(sessionId, {}))
        if (payload.cursor !== undefined) cursor = payload.cursor
      } catch {
        // A denied/screen-less read still surfaces on the real readback below;
        // starting from the retained window is the safe fallback.
      }
    }
    if (!run.cursors.has(sessionId)) run.cursors.set(sessionId, cursor)
    if (!run.readCursors.has(sessionId)) run.readCursors.set(sessionId, cursor)
  }

  /**
   * Read the output produced since the last condition evaluation.
   *
   * Only a bounded tail is returned: the retained delta is walked chunk by
   * chunk (at most {@link MAX_CONDITION_READ_ROUNDS}) and the most recent chunk
   * is kept, so one long-running session cannot make the condition text grow.
   * @param {{ cursors: Map<string, string> }} run per-target state.
   * @param {string} sessionId effective session.
   * @returns {Promise<{ text: string, cursor?: string }>} observed text and the end position.
   */
  const readConditionText = async (run, sessionId) => {
    let cursor = run.cursors.get(sessionId) ?? '0'
    let text = ''
    let finalCursor = cursor
    for (let round = 0; round < MAX_CONDITION_READ_ROUNDS; round += 1) {
      const payload = await readDeltaAt(sessionId, cursor)
      if (payload.cursor !== undefined) {
        cursor = payload.cursor
        finalCursor = payload.cursor
      }
      if (typeof payload.text === 'string') text = payload.text
      const newBytes = typeof payload.newBytes === 'number' ? payload.newBytes : 0
      if (newBytes < READ_BYTES) break
      if (typeof payload.text !== 'string' || payload.text.length === 0) break
    }
    return { text, cursor: finalCursor }
  }

  /**
   * Move the condition checkpoint to the observed end of output. Called after
   * every condition evaluation, even when the condition needed no text, so the
   * same output is never matched twice.
   * @param {{ cursors: Map<string, string> }} run per-target state.
   * @param {string} sessionId effective session.
   * @param {{ text: string, cursor?: string } | undefined} observed already-read text.
   * @returns {Promise<{ text: string, cursor?: string }>} the observed text.
   */
  const advanceConditionCheckpoint = async (run, sessionId, observed) => {
    const final = observed ?? (await readConditionText(run, sessionId))
    if (final.cursor !== undefined) run.cursors.set(sessionId, final.cursor)
    return final
  }

  /**
   * Lazily read once per condition evaluation.
   * @param {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} ctx evaluation context.
   * @returns {Promise<{ text: string, cursor?: string }>} observed text.
   */
  const contextText = async (ctx) => {
    if (ctx.pending === undefined) ctx.pending = await readConditionText(ctx.run, ctx.sessionId)
    return ctx.pending
  }

  /**
   * Evaluate a condition. `if`/`loop` call this without advancing the checkpoint.
   * @param {Record<string, any>} condition normalized condition.
   * @param {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} ctx evaluation context.
   * @param {Record<string, string>} variables current variables.
   * @returns {Promise<boolean>} verdict.
   */
  const evaluateCondition = async (condition, ctx, variables) => {
    if (condition.always === true) return true
    // `variable` is checked before the text operators: a variable condition may
    // itself carry a `contains`/`matches` operator, which must look at the
    // variable value rather than at the output.
    if (condition.variable !== undefined) {
      const name = condition.variable
      const known = Object.prototype.hasOwnProperty.call(variables, name)
      const value = known && typeof variables[name] === 'string' ? variables[name] : undefined
      if (condition.equals !== undefined) return value === renderTemplates(condition.equals, variables)
      if (condition.notEquals !== undefined) return value !== renderTemplates(condition.notEquals, variables)
      if (condition.contains !== undefined) {
        return value !== undefined && value.includes(renderTemplates(condition.contains, variables))
      }
      if (condition.matches !== undefined) {
        return value !== undefined && compileRegex(renderTemplates(condition.matches, variables)).test(value)
      }
      return false
    }
    if (condition.match !== undefined) {
      const { text } = await contextText(ctx)
      return compileRegex(renderTemplates(condition.match, variables)).test(text)
    }
    if (condition.contains !== undefined) {
      const { text } = await contextText(ctx)
      return text.includes(renderTemplates(condition.contains, variables))
    }
    if (condition.not !== undefined) return !(await evaluateCondition(condition.not, ctx, variables))
    if (condition.all !== undefined) {
      for (const entry of condition.all) {
        if (!(await evaluateCondition(entry, ctx, variables))) return false
      }
      return true
    }
    if (condition.any !== undefined) {
      for (const entry of condition.any) {
        if (await evaluateCondition(entry, ctx, variables)) return true
      }
      return false
    }
    return false
  }

  /**
   * Truncate a captured value so it fits the per-variable byte cap exactly
   * (captures are derived output, so trimming is preferable to failing the
   * step; `set` with an oversized template still fails explicitly).
   * @param {string} text candidate value.
   * @returns {string} value of at most {@link MAX_VARIABLE_VALUE_BYTES} bytes.
   */
  const capVariableValue = (text) => {
    if (Buffer.byteLength(text, 'utf8') <= MAX_VARIABLE_VALUE_BYTES) return text
    let out = ''
    let bytes = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (bytes + size > MAX_VARIABLE_VALUE_BYTES) break
      out += char
      bytes += size
    }
    return out
  }

  /**
   * Store a variable, enforcing the runtime caps.
   * @param {{ variables: Record<string, string> }} run per-target state.
   * @param {string} name variable name.
   * @param {string} value value.
   * @returns {void}
   */
  const setVariable = (run, name, value) => {
    if (Buffer.byteLength(value, 'utf8') > MAX_VARIABLE_VALUE_BYTES) {
      throw coded('LIMIT_EXCEEDED', `variable "${name}" value exceeds ${MAX_VARIABLE_VALUE_BYTES} bytes`)
    }
    if (!Object.prototype.hasOwnProperty.call(run.variables, name)) {
      if (Object.keys(run.variables).length >= MAX_SCRIPT_VARIABLES) {
        throw coded('LIMIT_EXCEEDED', `at most ${MAX_SCRIPT_VARIABLES} variables are allowed in one run`)
      }
    }
    run.variables[name] = value
  }

  /**
   * Emit one progress event; a throwing subscriber never fails the run.
   * @param {StepResult} record step result.
   * @param {string} sessionId effective session.
   * @returns {void}
   */
  const emitStep = (record, sessionId) => {
    if (onStep === undefined) return
    /** @type {Record<string, any>} */
    const event = {
      sessionId,
      stepIndex: record.index,
      depth: record.depth,
      path: record.path,
      kind: record.kind,
      ok: record.ok,
    }
    if (record.text !== undefined) event.text = record.text
    if (record.error !== undefined) event.error = record.error
    if (record.code !== undefined) event.code = record.code
    try {
      onStep(event)
    } catch {
      // A broken progress subscriber must never fail the script.
    }
  }

  /**
   * Execute one `send` step (a §11.1 batch step plus `capture`).
   * @param {SendStep} step normalized step.
   * @param {StepResult} record result being filled.
   * @param {object} run per-target state.
   * @param {string} sessionId effective session.
   * @returns {Promise<undefined>} nothing.
   */
  const runSendStep = async (step, record, run, sessionId) => {
    const rendered = renderTemplates(step.send, run.variables)
    if (Buffer.byteLength(rendered, 'utf8') > MAX_SEND_BYTES) {
      throw coded('LIMIT_EXCEEDED', `rendered send text exceeds ${MAX_SEND_BYTES} bytes`)
    }
    if (typeof registry.write !== 'function') {
      throw coded('UNSUPPORTED', 'the session registry does not support write')
    }
    // Establish the readback position *before* the write so the output this send
    // produces counts as new output for its own readback. The condition
    // checkpoint is untouched: conditions still see this output afterwards.
    await ensureSessionCursors(run, sessionId)
    await registry.write(sessionId, step.enter === true ? `${rendered}\r` : rendered, 'ai')
    /** @type {{ text?: string, cursor?: string, matched?: boolean, code?: string, error?: string } | undefined} */
    let waited
    if (step.waitFor !== undefined) {
      if (typeof registry.waitFor !== 'function') {
        throw coded('UNSUPPORTED', 'the session registry does not support waitFor')
      }
      const timeoutMs = Math.max(1, Math.min(step.waitFor.timeoutMs, remainingMs()))
      /** @type {Record<string, unknown>} */
      // The registry defaults to `until: 'idle'`; a step naming a pattern must
      // switch the wait mode or the pattern would be ignored (same as §11.2).
      const waitOptions = { until: step.waitFor.pattern !== undefined ? 'pattern' : 'idle', timeoutMs }
      if (step.waitFor.pattern !== undefined) waitOptions.pattern = step.waitFor.pattern
      if (step.waitFor.idleMs !== undefined) waitOptions.idleMs = step.waitFor.idleMs
      const waitCursor = run.readCursors.get(sessionId)
      if (waitCursor !== undefined) waitOptions.cursor = waitCursor
      waited = toReadPayload(await registry.waitFor(sessionId, waitOptions))
      if (waited.matched === false) {
        record.ok = false
        record.matched = false
        record.code = waited.code ?? 'WAIT_TIMEOUT'
        record.error =
          waited.error ??
          (step.waitFor.pattern !== undefined
            ? `timed out after ${timeoutMs}ms waiting for /${step.waitFor.pattern}/`
            : `timed out after ${timeoutMs}ms waiting for the session to go idle`)
      } else {
        record.matched = true
        if (waited.cursor !== undefined) run.readCursors.set(sessionId, waited.cursor)
      }
    }
    /** @type {string | undefined} */
    let output
    /** @type {string | undefined} */
    let cursor
    if (step.read === 'screen') {
      if (typeof registry.readScreen !== 'function') {
        throw coded('UNSUPPORTED', 'the session registry does not support readScreen')
      }
      const payload = toReadPayload(
        await registry.readScreen(sessionId, step.maxLines !== undefined ? { maxLines: step.maxLines } : {}),
      )
      output = payload.text
      cursor = payload.cursor
    } else if (step.read === 'delta') {
      if (waited?.text !== undefined) {
        // `waitFor` already read the delta: a second read would be empty.
        output = waited.text
        cursor = waited.cursor
      } else {
        const payload = await readDeltaAt(sessionId, run.readCursors.get(sessionId))
        output = payload.text
        cursor = payload.cursor
      }
    } else if (waited?.text !== undefined) {
      // `read: 'none'` skips the readback, but a wait still reports what it saw.
      output = waited.text
      cursor = waited.cursor
    }
    // Only the readback position advances here; the condition checkpoint is
    // moved exclusively by conditions and `expect` (§14.1).
    if (cursor !== undefined) run.readCursors.set(sessionId, cursor)
    if (output !== undefined) {
      const capped = takeText(output)
      if (capped !== undefined) record.text = capped
    }
    if (step.capture !== undefined) {
      setVariable(run, step.capture, capVariableValue(output ?? ''))
    }
    return undefined
  }

  /**
   * Execute one `expect` step. Evaluating it always advances the condition
   * checkpoint — including on a failed assertion, because the output was read
   * and evaluated — so two consecutive expectations never re-match the same text.
   * @param {ExpectStep} step normalized step.
   * @param {StepResult} record result being filled.
   * @param {object} run per-target state.
   * @param {string} sessionId effective session.
   * @returns {Promise<'halt' | 'continue' | undefined>} stop hint for the caller.
   */
  const runExpectStep = async (step, record, run, sessionId) => {
    await ensureSessionCursors(run, sessionId)
    /** @type {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} */
    const ctx = { run, sessionId }
    const matched = await evaluateCondition(step.expect, ctx, run.variables)
    record.matched = matched
    const observed = await advanceConditionCheckpoint(run, sessionId, ctx.pending)
    if (!matched) {
      record.ok = false
      record.code = 'EXPECT_FAILED'
      record.error = `expectation failed: ${describeCondition(step.expect)}`
      const capped = takeText(observed.text)
      if (capped !== undefined) record.text = capped
      return step.onFail === 'continue' ? 'continue' : 'halt'
    }
    if (step.capture !== undefined) {
      setVariable(run, step.capture, capVariableValue(observed.text))
    }
    return undefined
  }

  /**
   * Execute one step.
   * @param {ScriptStep} step normalized step.
   * @param {StepResult} record result being filled (may be pre-pushed for containers).
   * @param {object} run per-target state.
   * @param {string} sessionId effective session.
   * @param {number} rootIndex top-level index of this step (for `stoppedAt`).
   * @returns {Promise<'halt' | 'continue' | undefined>} stop hint.
   */
  const executeStep = async (step, record, run, sessionId, rootIndex) => {
    if (step.send !== undefined) return runSendStep(step, record, run, sessionId)
    if (step.delay !== undefined) {
      await sleep(Math.min(step.delay, remainingMs()))
      return undefined
    }
    if (step.set !== undefined) {
      const value = renderTemplates(step.value, run.variables)
      setVariable(run, step.set, value)
      return undefined
    }
    if (step.log !== undefined) {
      const message = renderTemplates(step.log, run.variables)
      const capped = takeText(message)
      if (capped !== undefined) record.text = capped
      if (logs.length < MAX_LOG_ENTRIES) {
        const entry = truncateTail(message, READ_BYTES)
        if (logBytes + Buffer.byteLength(entry, 'utf8') <= MAX_LOG_TOTAL_BYTES) {
          logs.push(entry)
          logBytes += Buffer.byteLength(entry, 'utf8')
        }
      }
      return undefined
    }
    if (step.expect !== undefined) return runExpectStep(step, record, run, sessionId)
    if (step.if !== undefined) {
      await ensureSessionCursors(run, sessionId)
      /** @type {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} */
      const ctx = { run, sessionId }
      const matched = await evaluateCondition(step.if, ctx, run.variables)
      record.matched = matched
      // Evaluating an `if` always advances the condition checkpoint, even when
      // the branch is taken by a variable/always condition (§14.1).
      await advanceConditionCheckpoint(run, sessionId, ctx.pending)
      const branch = matched ? step.then : step.else
      if (branch === undefined) return undefined
      const childrenOk = await executeList(branch, record.path, record.depth + 1, rootIndex, run)
      if (!childrenOk) {
        record.ok = false
        if (record.error === undefined) record.error = 'a nested step failed'
      }
      return undefined
    }
    // `loop`
    const loop = step.loop
    let iterations = 0
    let childrenOk = true
    while (iterations < loop.maxIterations) {
      if (state.timedOut || now() >= deadline) {
        state.timedOut = true
        run.failed = true
        if (run.stoppedAt === undefined) run.stoppedAt = rootIndex
        run.halt = true
        break
      }
      if (loop.count !== undefined && iterations >= loop.count) break
      if (loop.while !== undefined) {
        await ensureSessionCursors(run, sessionId)
        /** @type {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} */
        const ctx = { run, sessionId }
        const verdict = await evaluateCondition(loop.while, ctx, run.variables)
        await advanceConditionCheckpoint(run, sessionId, ctx.pending)
        if (!verdict) break
      }
      const bodyOk = await executeList(step.steps, record.path, record.depth + 1, rootIndex, run)
      iterations += 1
      if (!bodyOk) childrenOk = false
      if (run.halt) break
      if (loop.until !== undefined) {
        await ensureSessionCursors(run, sessionId)
        /** @type {{ run: object, sessionId: string, pending?: { text: string, cursor?: string } }} */
        const ctx = { run, sessionId }
        const done = await evaluateCondition(loop.until, ctx, run.variables)
        await advanceConditionCheckpoint(run, sessionId, ctx.pending)
        if (done) break
      }
    }
    if (!childrenOk) {
      record.ok = false
      if (record.error === undefined) record.error = 'a nested step failed'
    }
    return undefined
  }

  /**
   * Execute a step list against one target.
   *
   * Container results are appended before their children (structural order in
   * `run.steps`), while `onStep` fires when a step completes, so nested events
   * arrive before their parent.
   * @param {ScriptStep[]} steps normalized step list.
   * @param {string | undefined} parentPath path of the containing step.
   * @param {number} depth nesting depth of these steps.
   * @param {number | undefined} rootIndex top-level index of the containing step.
   * @param {object} run per-target state.
   * @returns {Promise<boolean>} whether every executed step in the list succeeded.
   */
  const executeList = async (steps, parentPath, depth, rootIndex, run) => {
    let allOk = true
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const currentRoot = rootIndex ?? index
      if (state.timedOut || now() >= deadline) {
        state.timedOut = true
        run.failed = true
        if (run.stoppedAt === undefined) run.stoppedAt = currentRoot
        run.halt = true
        return false
      }
      const path = parentPath === undefined ? String(index) : `${parentPath}.${index}`
      /** @type {StepResult} */
      const record = { index, depth, path, kind: stepKind(step), ok: true }
      run.steps.push(record)
      const sessionId = typeof step.sessionId === 'string' ? step.sessionId : run.sessionId
      /** @type {'halt' | 'continue' | undefined} */
      let hint
      try {
        hint = await executeStep(step, record, run, sessionId, currentRoot)
      } catch (error) {
        record.ok = false
        record.error = errorMessage(error)
        const code = errorCode(error)
        if (code !== undefined) record.code = code
      }
      if (!record.ok) {
        allOk = false
        run.failed = true
        if (run.stoppedAt === undefined) run.stoppedAt = currentRoot
        if (hint === 'halt' || (hint !== 'continue' && stopOnError)) run.halt = true
      }
      emitStep(record, sessionId)
      if (run.halt) return allOk
    }
    return allOk
  }

  /**
   * Run the whole program against one target.
   * @param {string} target session id.
   * @returns {Promise<{ result: { sessionId: string, ok: boolean, steps: StepResult[], stoppedAt?: number }, variables: Record<string, string> }>} outcome.
   */
  const runTarget = async (target) => {
    const run = {
      sessionId: target,
      steps: /** @type {StepResult[]} */ ([]),
      /** @type {number | undefined} */
      stoppedAt: undefined,
      failed: false,
      halt: false,
      /** Condition checkpoint: advanced only by condition evaluation. @type {Map<string, string>} */
      cursors: new Map(),
      /** Send readback position: advanced by `send` steps only. @type {Map<string, string>} */
      readCursors: new Map(),
      /** Sessions whose cursors have been seeded. @type {Set<string>} */
      ready: new Set(),
      /** @type {Record<string, string>} */
      variables: cloneVariables(baseVariables),
    }
    await executeList(program, undefined, 0, undefined, run)
    /** @type {{ sessionId: string, ok: boolean, steps: StepResult[], stoppedAt?: number }} */
    const result = { sessionId: target, ok: !run.failed && !state.timedOut, steps: run.steps }
    if (run.stoppedAt !== undefined) result.stoppedAt = run.stoppedAt
    return { result, variables: run.variables }
  }

  /** @type {Array<{ result: { sessionId: string, ok: boolean, steps: StepResult[], stoppedAt?: number }, variables: Record<string, string> }>} */
  let outcomes
  if (parallel) {
    outcomes = await Promise.all(targets.map((target) => runTarget(target)))
  } else {
    outcomes = []
    for (const target of targets) outcomes.push(await runTarget(target))
  }
  /** @type {Record<string, string>} */
  const merged = Object.create(null)
  for (const outcome of outcomes) Object.assign(merged, outcome.variables)
  const runs = outcomes.map((outcome) => outcome.result)
  /** @type {ScriptRunResult} */
  const result = {
    ok: !state.timedOut && runs.every((run) => run.ok),
    timedOut: state.timedOut,
    runs,
    variables: Object.fromEntries(Object.entries(merged)),
    logs,
  }
  if (label !== undefined) result.label = label
  return result
}

/**
 * Resolve script parameters into the initial variable values.
 *
 * Declared defaults fill omissions; an undeclared parameter without a default
 * is `MISSING_PARAM`, exactly like {@link import('./scripts.js').ScriptStore.render}.
 * @param {unknown} declared `definition.params`.
 * @param {unknown} provided caller values.
 * @returns {Record<string, string>} initial variables (null-prototype object).
 */
function resolveParameters(declared, provided) {
  const params = declared === undefined || declared === null ? {} : declared
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw coded('BAD_SCRIPT', 'script params must be an object')
  }
  const given = provided === undefined || provided === null ? {} : provided
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw coded('BAD_PARAM', 'script params supplied by the caller must be an object')
  }
  const keys = Object.keys(params)
  if (keys.length > MAX_SCRIPT_VARIABLES) {
    throw coded('BAD_SCRIPT', `at most ${MAX_SCRIPT_VARIABLES} script parameters are allowed`)
  }
  /** @type {Record<string, string>} */
  const values = Object.create(null)
  for (const key of keys) {
    if (!PARAM_NAME_PATTERN.test(key)) {
      throw coded('BAD_SCRIPT', `parameter name "${key}" must match ${PARAM_NAME_PATTERN.source}`)
    }
    const spec = params[key] === null || params[key] === undefined ? {} : params[key]
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      throw coded('BAD_SCRIPT', `parameter "${key}" must be an object with optional default/description`)
    }
    const providedValue = given[key]
    if (providedValue !== undefined && providedValue !== null) {
      if (typeof providedValue === 'string') values[key] = providedValue
      else if (typeof providedValue === 'number' || typeof providedValue === 'boolean') values[key] = String(providedValue)
      else throw coded('BAD_PARAM', `parameter "${key}" must be a string, number or boolean`)
      continue
    }
    const fallback = /** @type {Record<string, unknown>} */ (spec).default
    if (typeof fallback === 'string') values[key] = fallback
    else if (fallback !== undefined) throw coded('BAD_SCRIPT', `parameter "${key}".default must be a string`)
    else throw coded('MISSING_PARAM', `missing required script parameter: ${key}`)
  }
  return values
}

/**
 * Copy the seeded variables for one target (per-target isolation).
 * @param {Record<string, string>} source seeded variables.
 * @returns {Record<string, string>} independent copy.
 */
function cloneVariables(source) {
  const copy = Object.create(null)
  for (const [key, value] of Object.entries(source)) copy[key] = value
  return copy
}

/**
 * @param {ScriptStep} step normalized step.
 * @returns {string} discriminators name.
 */
function stepKind(step) {
  if (step.send !== undefined) return 'send'
  if (step.delay !== undefined) return 'delay'
  if (step.set !== undefined) return 'set'
  if (step.log !== undefined) return 'log'
  if (step.expect !== undefined) return 'expect'
  if (step.if !== undefined) return 'if'
  return 'loop'
}

/**
 * Human readable description of a condition, used in `EXPECT_FAILED` messages.
 * @param {Record<string, any>} condition normalized condition.
 * @param {number} [depth] recursion guard.
 * @returns {string} description.
 */
function describeCondition(condition, depth = 0) {
  if (depth > 4) return '…'
  if (condition.always === true) return 'always'
  if (condition.match !== undefined) return `match /${condition.match}/`
  if (condition.contains !== undefined) return `contains "${condition.contains}"`
  if (condition.variable !== undefined) {
    if (condition.equals !== undefined) return `variable "${condition.variable}" equals "${condition.equals}"`
    if (condition.notEquals !== undefined) return `variable "${condition.variable}" not equals "${condition.notEquals}"`
    if (condition.contains !== undefined) return `variable "${condition.variable}" contains "${condition.contains}"`
    if (condition.matches !== undefined) return `variable "${condition.variable}" matches /${condition.matches}/`
    return `variable "${condition.variable}"`
  }
  if (condition.not !== undefined) return `not (${describeCondition(condition.not, depth + 1)})`
  if (condition.all !== undefined) {
    return `all of [${condition.all.map((entry) => describeCondition(entry, depth + 1)).join(', ')}]`
  }
  if (condition.any !== undefined) {
    return `any of [${condition.any.map((entry) => describeCondition(entry, depth + 1)).join(', ')}]`
  }
  return 'condition'
}

/**
 * Interpret a registry read/wait result, tolerating a bare string.
 * @param {unknown} payload registry payload.
 * @returns {{ text?: string, cursor?: string, newBytes?: number, matched?: boolean, code?: string, error?: string }} fields.
 */
function toReadPayload(payload) {
  if (typeof payload === 'string') return { text: payload }
  if (payload === null || typeof payload !== 'object') return {}
  /** @type {{ text?: string, cursor?: string, newBytes?: number, matched?: boolean, code?: string, error?: string }} */
  const out = {}
  if (typeof payload.text === 'string') out.text = payload.text
  if (typeof payload.cursor === 'string') out.cursor = payload.cursor
  else if (typeof payload.cursor === 'number' && Number.isFinite(payload.cursor)) out.cursor = String(payload.cursor)
  if (typeof payload.newBytes === 'number' && Number.isFinite(payload.newBytes)) out.newBytes = Math.max(0, payload.newBytes)
  if (typeof payload.matched === 'boolean') out.matched = payload.matched
  if (typeof payload.code === 'string') out.code = payload.code
  if (typeof payload.error === 'string') out.error = payload.error
  return out
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
 * @returns {string | undefined} stable code when the error carries one.
 */
function errorCode(error) {
  if (error === null || typeof error !== 'object') return undefined
  const code = /** @type {{ code?: unknown }} */ (error).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * Default delay: a real timer that does not keep the process alive on its own.
 * @param {number} ms delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    if (!(ms > 0)) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}
