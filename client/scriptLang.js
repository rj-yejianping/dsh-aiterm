/**
 * The v3 script language, browser side (CONTRACTS.md §14).
 *
 * Two jobs, both pure so they can be unit-tested through the UI:
 *
 * 1. {@link STEP_TEMPLATES} + {@link insertTemplate} — insert a valid JSON
 *    skeleton for the seven step kinds into the editor text.
 * 2. {@link validateScriptDefinition} — structural validation mirroring
 *    `normalizeScriptProgram` (§14.1/§14.2) before the RPC is attempted, so a
 *    typo is reported with a precise JSON path (`steps[2].then[0]`) instead of
 *    the Host rejecting the whole script.
 *
 * Errors carry a locale key plus its placeholders; the panel formats them with
 * `ctx.locale`, so this module holds no user-visible prose.
 */

/** Recognized step discriminators (§14.1). */
export const STEP_KINDS = ['send', 'delay', 'set', 'log', 'expect', 'if', 'loop']

/** Hard limits from §14.2. */
export const MAX_STEPS = 500
export const MAX_DEPTH = 5
export const MAX_ITERATIONS = 1000

/** Condition nesting cap (mirrors the Host's `MAX_CONDITION_DEPTH`). */
export const MAX_CONDITION_DEPTH = 8

/** A `set` variable name (§14.1). */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

/**
 * Skeleton steps offered by the editor's template dropdown.
 *
 * Each entry produces a complete, valid step object so inserting it and saving
 * never trips validation.
 */
export const STEP_TEMPLATES = [
  {
    id: 'send',
    labelKey: 'tplSend',
    make: () => ({ send: 'uptime', enter: true }),
  },
  {
    id: 'delay',
    labelKey: 'tplDelay',
    make: () => ({ delay: 1000 }),
  },
  {
    id: 'set',
    labelKey: 'tplSet',
    make: () => ({ set: 'target', value: 'world' }),
  },
  {
    id: 'if',
    labelKey: 'tplIf',
    make: () => ({
      if: { contains: 'error' },
      then: [{ log: 'matched "error"' }],
      else: [{ log: 'no error seen' }],
    }),
  },
  {
    id: 'loop',
    labelKey: 'tplLoop',
    make: () => ({
      loop: { count: 3, maxIterations: 10 },
      steps: [
        { send: 'echo tick', enter: true },
        { delay: 200 },
      ],
    }),
  },
  {
    id: 'expect',
    labelKey: 'tplExpect',
    make: () => ({ expect: { match: 'ok' }, onFail: 'stop' }),
  },
  {
    id: 'log',
    labelKey: 'tplLog',
    make: () => ({ log: 'note' }),
  },
]

/**
 * Locale key for one step kind, used by the progress rows.
 *
 * @param kind - kind string from a batch frame.
 * @returns the `kind<X>` dictionary key (`kindUnknown` when unrecognized).
 */
export function kindLabelKey(kind) {
  if (typeof kind !== 'string' || kind === '') return 'kindUnknown'
  if (!STEP_KINDS.includes(kind)) return 'kindUnknown'
  return `kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

/**
 * Insert one template skeleton into the editor text.
 *
 * Valid JSON with a `steps` array gets the skeleton appended; empty or
 * unparsable text is rebuilt as a fresh script definition so the result is
 * always parseable JSON again.
 *
 * @param text - current editor text.
 * @param templateId - id from {@link STEP_TEMPLATES}.
 * @returns `{ ok, text, rebuilt }`.
 */
export function insertTemplate(text, templateId) {
  const template = STEP_TEMPLATES.find((entry) => entry.id === templateId)
  const raw = typeof text === 'string' ? text : ''
  if (!template) return { ok: false, text: raw, rebuilt: false }

  let base = null
  let rebuilt = false
  if (raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
      else rebuilt = true
    } catch {
      rebuilt = true
    }
  }
  if (!base) base = { name: '', description: '', params: {}, steps: [] }
  if (!Array.isArray(base.steps)) {
    base.steps = []
    rebuilt = true
  }

  let step
  try {
    step = template.make()
  } catch {
    return { ok: false, text: raw, rebuilt }
  }

  const next = { ...base, steps: base.steps.concat([step]) }
  try {
    return { ok: true, text: JSON.stringify(next, null, 2), rebuilt }
  } catch {
    return { ok: false, text: raw, rebuilt }
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function kindsOf(step) {
  return STEP_KINDS.filter((kind) => Object.prototype.hasOwnProperty.call(step, kind))
}

function pushConditionError(condition, path, errors, depth = 0) {
  if (depth > MAX_CONDITION_DEPTH) {
    errors.push({ path, key: 'vConditionDeep', params: { max: MAX_CONDITION_DEPTH } })
    return
  }
  const source = record(condition)
  if (!source) {
    errors.push({ path, key: 'vCondition' })
    return
  }
  const keys = ['always', 'match', 'contains', 'variable', 'not', 'all', 'any']
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
  if (keys.length !== 1) {
    errors.push({ path, key: 'vCondition' })
    return
  }
  const key = keys[0]
  if (key === 'always') {
    if (source.always !== true) errors.push({ path, key: 'vCondition' })
    return
  }
  if (key === 'match' || key === 'contains') {
    if (typeof source[key] !== 'string' || source[key] === '') {
      errors.push({ path, key: 'vCondition' })
      return
    }
    if (key === 'match' && !compilableRegex(source.match)) {
      errors.push({ path: `${path}.match`, key: 'vConditionRegex' })
    }
    return
  }
  if (key === 'variable') {
    if (typeof source.variable !== 'string' || source.variable === '') errors.push({ path, key: 'vCondition' })
    for (const field of ['equals', 'notEquals', 'contains', 'matches']) {
      if (source[field] !== undefined && typeof source[field] !== 'string') errors.push({ path, key: 'vCondition' })
    }
    if (typeof source.matches === 'string' && source.matches !== '' && !compilableRegex(source.matches)) {
      errors.push({ path: `${path}.matches`, key: 'vConditionRegex' })
    }
    return
  }
  if (key === 'not') {
    pushConditionError(source.not, `${path}.not`, errors, depth + 1)
    return
  }
  if (!Array.isArray(source[key]) || source[key].length === 0) {
    errors.push({ path, key: 'vConditionList', params: { key } })
    return
  }
  source[key].forEach((entry, index) => {
    pushConditionError(entry, `${path}.${key}[${index}]`, errors, depth + 1)
  })
}

/**
 * Whether a regular expression compiles.
 *
 * @param pattern - candidate regex source.
 * @returns whether `new RegExp(pattern)` succeeds.
 */
function compilableRegex(pattern) {
  try {
    new RegExp(pattern) // eslint-disable-line no-new
    return true
  } catch {
    return false
  }
}

function walkSteps(steps, path, depth, errors, counter) {
  if (!Array.isArray(steps)) {
    errors.push({ path, key: 'vSteps' })
    return
  }
  if (depth > MAX_DEPTH) {
    errors.push({ path, key: 'vTooDeep', params: { max: MAX_DEPTH } })
    return
  }
  steps.forEach((step, index) => {
    counter.total += 1
    if (counter.total > MAX_STEPS && !counter.flagged) {
      counter.flagged = true
      errors.push({ path, key: 'vTooMany', params: { max: MAX_STEPS } })
    }
    walkStep(step, `${path}[${index}]`, depth, errors, counter)
  })
}

function walkStep(step, path, depth, errors, counter) {
  const source = record(step)
  if (!source) {
    errors.push({ path, key: 'vStepObject' })
    return
  }

  const kinds = kindsOf(source)
  if (kinds.length === 0) {
    const keys = Object.keys(source)
    if (keys.length === 0) errors.push({ path, key: 'vNoKind' })
    else errors.push({ path, key: 'vUnknownKind', params: { kind: keys.join('/') } })
    return
  }
  if (kinds.length > 1) {
    errors.push({ path, key: 'vMultiKind', params: { kinds: kinds.join('/') } })
    return
  }

  const kind = kinds[0]
  if (kind === 'send') {
    if (typeof source.send !== 'string' || source.send.trim() === '') errors.push({ path, key: 'vSend' })
    return
  }
  if (kind === 'delay') {
    if (typeof source.delay !== 'number' || !Number.isFinite(source.delay) || source.delay <= 0) {
      errors.push({ path, key: 'vDelay' })
    }
    return
  }
  if (kind === 'set') {
    if (typeof source.set !== 'string' || !VARIABLE_NAME.test(source.set)) errors.push({ path, key: 'vSetName' })
    if (typeof source.value !== 'string') errors.push({ path, key: 'vSetValue' })
    return
  }
  if (kind === 'log') {
    if (typeof source.log !== 'string') errors.push({ path, key: 'vLog' })
    return
  }
  if (kind === 'expect') {
    if (!record(source.expect)) errors.push({ path, key: 'vExpect' })
    else pushConditionError(source.expect, `${path}.expect`, errors)
    if (source.onFail !== undefined && source.onFail !== 'stop' && source.onFail !== 'continue') {
      errors.push({ path, key: 'vExpectOnFail' })
    }
    return
  }
  if (kind === 'if') {
    pushConditionError(source.if, `${path}.if`, errors)
    if (!Array.isArray(source.then)) errors.push({ path, key: 'vIfThen' })
    else if (source.then.length === 0) errors.push({ path, key: 'vIfThenEmpty' })
    else walkSteps(source.then, `${path}.then`, depth + 1, errors, counter)
    if (source.else !== undefined) {
      if (!Array.isArray(source.else)) errors.push({ path, key: 'vIfElse' })
      else walkSteps(source.else, `${path}.else`, depth + 1, errors, counter)
    }
    return
  }

  // kind === 'loop'
  const loop = record(source.loop)
  if (!loop) {
    errors.push({ path, key: 'vLoopCond' })
  } else {
    const hasCount = loop.count !== undefined
    const hasWhile = loop.while !== undefined
    const hasUntil = loop.until !== undefined
    if (!hasCount && !hasWhile && !hasUntil) errors.push({ path, key: 'vLoopCond' })
    if (hasCount && (!Number.isInteger(loop.count) || loop.count < 1 || loop.count > MAX_ITERATIONS)) {
      errors.push({ path: `${path}.loop.count`, key: 'vLoopCount', params: { max: MAX_ITERATIONS } })
    }
    if (hasWhile) pushConditionError(loop.while, `${path}.loop.while`, errors)
    if (hasUntil) pushConditionError(loop.until, `${path}.loop.until`, errors)
    if (loop.maxIterations !== undefined
      && (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1 || loop.maxIterations > MAX_ITERATIONS)) {
      errors.push({ path: `${path}.loop.maxIterations`, key: 'vLoopMax', params: { max: MAX_ITERATIONS } })
    }
  }
  if (!Array.isArray(source.steps) || source.steps.length === 0) errors.push({ path, key: 'vLoopBody' })
  else walkSteps(source.steps, `${path}.steps`, depth + 1, errors, counter)
}

/**
 * Structurally validate a script definition before saving.
 *
 * @param script - parsed script JSON.
 * @returns `[{ path, key, params? }]`, empty when the program is valid.
 */
export function validateScriptDefinition(script) {
  const source = record(script)
  if (!source) return [{ path: 'script', key: 'vSteps' }]
  if (!Array.isArray(source.steps)) return [{ path: 'steps', key: 'vSteps' }]
  const errors = []
  const counter = { total: 0, flagged: false }
  walkSteps(source.steps, 'steps', 0, errors, counter)
  return errors
}
