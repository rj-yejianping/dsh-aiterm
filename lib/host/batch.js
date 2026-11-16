/**
 * Batch execution engine (CONTRACTS.md §11.1–§11.2).
 *
 * A batch is a list of declarative steps ("send this, optionally wait for that,
 * then read the resulting output") fanned out over one or more live sessions.
 * Everything goes through {@link import('./registry.js').SessionRegistry}, so
 * writes still obey the permission model: a refusal is reported as a failed
 * *step*, never as an exception that would abort the tool call.
 *
 * The runner is intentionally strict about input shape (`normalizeSteps`) and
 * forgiving at runtime: apart from a missing/empty `targets` list, `runBatch`
 * never throws.
 */

import { boundInteger, coded, truncateTail } from './util.js'

/** Hard cap on the number of steps accepted in one batch. */
export const MAX_BATCH_STEPS = 100
/** Default per-step readback budget. */
export const BATCH_DEFAULT_MAX_BYTES = 8192

/** Default overall wall-clock budget for a batch (ms). */
const DEFAULT_MAX_TOTAL_MS = 120_000
/** Upper bound for `maxTotalMs`. */
const MAX_MAX_TOTAL_MS = 3_600_000
/** Largest accepted `send` payload (matches the registry's input limit). */
const MAX_SEND_BYTES = 64 * 1024
/** Default `waitFor.timeoutMs`. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
/** Default `waitFor.idleMs` when only a pattern (or nothing) is given. */
const DEFAULT_IDLE_MS = 500
/** Upper bounds for wait knobs. */
const MAX_TIMEOUT_MS = 3_600_000
const MAX_IDLE_MS = 600_000
/** Longest accepted pattern source. */
const MAX_PATTERN_LENGTH = 2048
/** Upper bound for `maxLines` on screen readback (matches the registry). */
const MAX_SCREEN_LINES = 2000
/** Readback modes understood by the runner. */
const READ_MODES = new Set(['delta', 'screen', 'none'])

/**
 * @typedef {object} BatchStep
 * @property {string} [sessionId] override the fan-out target for this step.
 * @property {string} [send] text to write (may contain `{{param}}` before render).
 * @property {boolean} [enter] append `\r` after `send`.
 * @property {{ pattern?: string, idleMs?: number, timeoutMs?: number }} [waitFor]
 * @property {number} [waitMs] fixed delay, used only when `waitFor` is absent.
 * @property {'delta' | 'screen' | 'none'} [read] readback mode (default `delta`).
 * @property {number} [maxLines] retained lines for `read: 'screen'`.
 */

/**
 * @typedef {object} BatchStepResult
 * @property {number} index step index within the batch.
 * @property {boolean} ok whether the step completed without error.
 * @property {boolean} [matched] result of a `waitFor` condition.
 * @property {string} [text] readback text (already capped).
 * @property {string} [cursor] opaque read cursor after the step.
 * @property {string} [error] human readable failure message.
 * @property {string} [code] stable error code, when the failure carries one.
 */

/**
 * @typedef {object} BatchRunResult
 * @property {string} sessionId target session.
 * @property {boolean} ok whether every executed step succeeded and none timed out.
 * @property {BatchStepResult[]} steps steps that actually executed.
 * @property {number} [stoppedAt] index of the first step that did not execute.
 */

/**
 * Validate and bound a list of steps.
 *
 * Every returned step carries explicit defaults (`read: 'delta'`, `enter: false`,
 * a bounded `waitFor.timeoutMs`), so the executor never re-interprets raw input.
 * @param {unknown} input candidate step list.
 * @returns {BatchStep[]} normalized, bounded steps.
 * @throws {import('./util.js').CodedError} `BAD_STEPS` when the input is invalid.
 */
export function normalizeSteps(input) {
  if (!Array.isArray(input)) throw coded('BAD_STEPS', 'steps must be an array')
  if (input.length > MAX_BATCH_STEPS) {
    throw coded('BAD_STEPS', `at most ${MAX_BATCH_STEPS} steps are allowed (received ${input.length})`)
  }
  return input.map((raw, index) => normalizeStep(raw, index))
}

/**
 * Normalize one step.
 * @param {unknown} raw candidate step.
 * @param {number} index position, used in error messages.
 * @returns {BatchStep} normalized step.
 */
function normalizeStep(raw, index) {
  const where = `steps[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coded('BAD_STEPS', `${where} must be an object`)
  }
  /** @type {BatchStep} */
  const step = {}
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0) {
      throw coded('BAD_STEPS', `${where}.sessionId must be a non-empty string`)
    }
    step.sessionId = raw.sessionId.trim()
  }
  if (raw.send !== undefined && raw.send !== null) {
    if (typeof raw.send !== 'string') throw coded('BAD_STEPS', `${where}.send must be a string`)
    if (Buffer.byteLength(raw.send, 'utf8') > MAX_SEND_BYTES) {
      throw coded('BAD_STEPS', `${where}.send exceeds ${MAX_SEND_BYTES} bytes`)
    }
    if (raw.send.length > 0) step.send = raw.send
  }
  if (raw.enter !== undefined) {
    if (typeof raw.enter !== 'boolean') throw coded('BAD_STEPS', `${where}.enter must be a boolean`)
    step.enter = raw.enter
  }
  if (raw.waitFor !== undefined) step.waitFor = normalizeWaitFor(raw.waitFor, `${where}.waitFor`)
  if (raw.waitMs !== undefined) {
    step.waitMs = boundedNumber(raw.waitMs, `${where}.waitMs`, 0, MAX_MAX_TOTAL_MS)
  }
  if (raw.read !== undefined) {
    if (typeof raw.read !== 'string' || !READ_MODES.has(raw.read)) {
      throw coded('BAD_STEPS', `${where}.read must be one of ${[...READ_MODES].join(', ')}`)
    }
    step.read = raw.read
  } else {
    step.read = 'delta'
  }
  if (raw.maxLines !== undefined) {
    step.maxLines = boundedNumber(raw.maxLines, `${where}.maxLines`, 1, MAX_SCREEN_LINES)
  }
  // A step that neither sends, reads, waits nor sleeps would silently do nothing:
  // reject it early instead of returning a no-op result the model cannot explain.
  const reads = step.read !== 'none'
  if (step.send === undefined && !reads && step.waitFor === undefined && step.waitMs === undefined) {
    throw coded('BAD_STEPS', `${where} has neither a send nor a read request`)
  }
  return step
}

/**
 * Normalize a `waitFor` condition.
 * @param {unknown} raw candidate condition.
 * @param {string} where path for error messages.
 * @returns {{ pattern?: string, idleMs?: number, timeoutMs: number }} normalized condition.
 */
function normalizeWaitFor(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coded('BAD_STEPS', `${where} must be an object`)
  }
  /** @type {{ pattern?: string, idleMs?: number, timeoutMs: number }} */
  const waitFor = { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS }
  if (raw.pattern !== undefined && raw.pattern !== null) {
    if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
      throw coded('BAD_STEPS', `${where}.pattern must be a non-empty string`)
    }
    if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      throw coded('BAD_STEPS', `${where}.pattern exceeds ${MAX_PATTERN_LENGTH} characters`)
    }
    try {
      // Compile once so a bad pattern fails at normalization time, not mid-batch.
      new RegExp(raw.pattern)
    } catch {
      throw coded('BAD_STEPS', `${where}.pattern is not a valid regular expression`)
    }
    waitFor.pattern = raw.pattern
  }
  if (raw.idleMs !== undefined) {
    waitFor.idleMs = boundedNumber(raw.idleMs, `${where}.idleMs`, 0, MAX_IDLE_MS)
  }
  if (raw.timeoutMs !== undefined) {
    waitFor.timeoutMs = boundedNumber(raw.timeoutMs, `${where}.timeoutMs`, 1, MAX_TIMEOUT_MS)
  }
  if (waitFor.pattern === undefined && waitFor.idleMs === undefined) waitFor.idleMs = DEFAULT_IDLE_MS
  return waitFor
}

/**
 * Coerce a bounded integer, rejecting non-numbers instead of silently ignoring them.
 * @param {unknown} value candidate number.
 * @param {string} where path for error messages.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} bounded integer.
 */
function boundedNumber(value, where, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw coded('BAD_STEPS', `${where} must be a finite number`)
  }
  return boundInteger(value, min, min, max)
}

/**
 * Execute a batch against one or more sessions.
 *
 * Targets are fanned out sequentially in the order given (each target receives
 * the full step list before the next target starts) unless `parallel` is true.
 * @param {object} registry the session registry (see CONTRACTS.md §11.2).
 * @param {unknown} steps raw steps; validated with {@link normalizeSteps}.
 * @param {object} [options] execution options.
 * @param {string[]} options.targets required, at least one session id.
 * @param {boolean} [options.stopOnError] default `true`.
 * @param {number} [options.maxTotalMs] overall wall-clock budget, default 120000.
 * @param {boolean} [options.parallel] run targets concurrently, default `false`.
 * @param {string} [options.label] audit label such as `batch` or `script:<name>`.
 * @param {(progress: { sessionId: string, stepIndex: number, ok: boolean, text?: string, error?: string }) => void} [options.onStep] progress hook (used for SSE).
 * @param {number} [options.maxBytes] per-step readback budget, default 8192.
 * @param {number} [options.maxTotalBytes] total readback budget for the whole result.
 * @param {(ms: number) => Promise<void>} [options.sleep] injected timer (tests).
 * @param {() => number} [options.now] injected clock (tests).
 * @returns {Promise<{ ok: boolean, timedOut: boolean, label?: string, runs: BatchRunResult[] }>} batch result.
 * @throws {import('./util.js').CodedError} `BAD_TARGETS` when `targets` is missing/empty,
 *   and `BAD_STEPS` when the step list is invalid. Every other failure is a step result.
 */
export async function runBatch(registry, steps, options = {}) {
  const opts = options ?? {}
  const targets = Array.isArray(opts.targets)
    ? opts.targets.filter((target) => typeof target === 'string' && target.trim().length > 0).map((target) => target.trim())
    : []
  if (targets.length === 0) throw coded('BAD_TARGETS', 'at least one target session id is required')
  const normalized = normalizeSteps(steps)
  const stopOnError = opts.stopOnError !== false
  const parallel = opts.parallel === true
  const maxTotalMs = boundInteger(opts.maxTotalMs, DEFAULT_MAX_TOTAL_MS, 1, MAX_MAX_TOTAL_MS)
  const maxBytes = boundInteger(opts.maxBytes, BATCH_DEFAULT_MAX_BYTES, 64, 1024 * 1024)
  const maxTotalBytes = boundInteger(opts.maxTotalBytes, maxBytes * 8, maxBytes, 4 * 1024 * 1024)
  const label = typeof opts.label === 'string' && opts.label.trim().length > 0 ? opts.label.trim() : undefined
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : undefined
  const deadline = now() + maxTotalMs
  /** @type {{ timedOut: boolean }} */
  const state = { timedOut: false }

  /**
   * @returns {number} milliseconds left in the overall budget (never negative).
   */
  const remainingMs = () => Math.max(0, deadline - now())

  /**
   * Execute one step against one session.
   * @param {BatchStep} step normalized step.
   * @param {string} sessionId effective target.
   * @param {number} index step index.
   * @param {string | undefined} lastCursor cursor from the previous read of this target.
   * @returns {Promise<BatchStepResult>} step result.
   */
  const executeStep = async (step, sessionId, index, lastCursor) => {
    /** @type {BatchStepResult} */
    const record = { index, ok: true }
    if (step.send !== undefined) {
      // The permission model lives in the registry: role 'ai' is the only caller
      // this runner ever uses, exactly like the CLI-style batch tool.
      await registry.write(sessionId, step.enter === true ? `${step.send}\r` : step.send, 'ai')
    }
    /** @type {{ text?: string, cursor?: string, matched?: boolean, code?: string, error?: string } | undefined} */
    let waited
    if (step.waitFor !== undefined) {
      if (typeof registry.waitFor !== 'function') {
        throw coded('UNSUPPORTED', 'the session registry does not support waitFor')
      }
      const timeoutMs = Math.max(1, Math.min(step.waitFor.timeoutMs, remainingMs()))
      /** @type {Record<string, unknown>} */
      // The registry defaults to `until: 'idle'`; a step that names a pattern has
      // to switch the wait mode or the pattern would be ignored.
      const waitOptions = { until: step.waitFor.pattern !== undefined ? 'pattern' : 'idle', timeoutMs }
      if (step.waitFor.pattern !== undefined) waitOptions.pattern = step.waitFor.pattern
      if (step.waitFor.idleMs !== undefined) waitOptions.idleMs = step.waitFor.idleMs
      if (lastCursor !== undefined) waitOptions.cursor = lastCursor
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
      }
      if (waited.cursor !== undefined) record.cursor = waited.cursor
    } else if (typeof step.waitMs === 'number' && step.waitMs > 0) {
      // A fixed delay is cut at the deadline so one step cannot overrun the batch.
      await sleep(Math.min(step.waitMs, remainingMs()))
    }
    if (step.read === 'none') {
      // A wait still reports the output it observed; keep it, it is the only
      // readback this step has.
      if (waited?.text !== undefined) record.text = waited.text
    } else if (step.read === 'delta' && waited?.text !== undefined) {
      // `waitFor` already consumed and returned the delta: the registry advances
      // its reader cursor when the wait settles, so a second read would be empty.
      record.text = waited.text
    } else {
      const reader = step.read === 'screen' ? 'readScreen' : 'readDelta'
      if (typeof registry[reader] !== 'function') {
        throw coded('UNSUPPORTED', `the session registry does not support ${reader}`)
      }
      /** @type {Record<string, unknown>} */
      const readOptions = step.read === 'screen' ? {} : { maxBytes }
      if (step.read === 'screen' && step.maxLines !== undefined) readOptions.maxLines = step.maxLines
      const payload = toReadPayload(await registry[reader](sessionId, readOptions))
      if (payload.text !== undefined) record.text = payload.text
      if (payload.cursor !== undefined) record.cursor = payload.cursor
    }
    if (record.text !== undefined) record.text = truncateTail(record.text, maxBytes)
    return record
  }

  /**
   * Run the whole step list against one target.
   * @param {string} target session id.
   * @returns {Promise<BatchRunResult>} per-target run result.
   */
  const runTarget = async (target) => {
    /** @type {BatchStepResult[]} */
    const stepsOut = []
    let ok = true
    /** @type {number | undefined} */
    let stoppedAt
    let usedBytes = 0
    /** @type {string | undefined} */
    let lastCursor
    for (let index = 0; index < normalized.length; index += 1) {
      const step = normalized[index]
      if (state.timedOut || now() >= deadline) {
        state.timedOut = true
        stoppedAt = index
        ok = false
        break
      }
      const sessionId = step.sessionId ?? target
      /** @type {BatchStepResult} */
      let record
      try {
        record = await executeStep(step, sessionId, index, lastCursor)
      } catch (error) {
        record = { index, ok: false, error: errorMessage(error) }
        const code = errorCode(error)
        if (code !== undefined) record.code = code
      }
      if (record.cursor !== undefined) lastCursor = record.cursor
      // Whole-result budget: cap what this step contributes, then drop text once
      // the budget is exhausted so a 100-step batch cannot flood the model.
      if (record.text !== undefined) {
        const left = maxTotalBytes - usedBytes
        if (left <= 0) {
          delete record.text
        } else {
          record.text = truncateTail(record.text, Math.min(maxBytes, left))
          usedBytes += Buffer.byteLength(record.text, 'utf8')
        }
      }
      stepsOut.push(record)
      if (onStep !== undefined) {
        try {
          const flat = normalized[index]
          onStep({
            sessionId,
            stepIndex: index,
            // Flat batches still report the nesting fields so one progress
            // renderer serves both batch and script runs.
            depth: 0,
            path: String(index),
            kind: flat === undefined ? 'send' : flat.read === 'screen' ? 'screen' : 'send',
            ok: record.ok,
            text: record.text,
            error: record.error,
          })
        } catch {
          // A broken progress subscriber must never fail the batch.
        }
      }
      if (!record.ok) {
        ok = false
        if (stopOnError) {
          stoppedAt = index
          break
        }
      }
    }
    /** @type {BatchRunResult} */
    const run = { sessionId: target, ok, steps: stepsOut }
    if (stoppedAt !== undefined) run.stoppedAt = stoppedAt
    return run
  }

  /** @type {BatchRunResult[]} */
  const runs = []
  if (parallel) {
    runs.push(...(await Promise.all(targets.map((target) => runTarget(target)))))
  } else {
    for (const target of targets) runs.push(await runTarget(target))
  }
  const result = { ok: !state.timedOut && runs.every((run) => run.ok), timedOut: state.timedOut, runs }
  if (label !== undefined) result.label = label
  return result
}

/**
 * Interpret a registry read/wait result, tolerating a bare string.
 * @param {unknown} payload registry payload.
 * @returns {{ text?: string, cursor?: string, matched?: boolean, code?: string, error?: string }} fields.
 */
function toReadPayload(payload) {
  if (typeof payload === 'string') return { text: payload }
  if (payload === null || typeof payload !== 'object') return {}
  /** @type {{ text?: string, cursor?: string, matched?: boolean, code?: string, error?: string }} */
  const out = {}
  if (typeof payload.text === 'string') out.text = payload.text
  if (typeof payload.cursor === 'string') out.cursor = payload.cursor
  else if (typeof payload.cursor === 'number' && Number.isFinite(payload.cursor)) out.cursor = String(payload.cursor)
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
