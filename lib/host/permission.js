/**
 * Permission model shared by both writers: the human in the browser and the AI
 * through tools.
 *
 * Two independent axes:
 *
 * 1. `aiAccess` — what the AI is allowed to do with the session:
 *      - `ro` read-only: it may read output/screens but never send input.
 *      - `wo` write-only: it may send input but never read output.
 *      - `rw` read-write: both.
 * 2. `lockOwner` — who holds the exclusive control token right now:
 *      - `'ai'`   the AI is operating; with `blockHumanWhileAi` the human's
 *                 keystrokes are refused until the AI goes idle or the human
 *                 takes over.
 *      - `'human'` the human took over; AI writes are refused until released.
 *      - `null`   free for either side.
 *
 * The human can always take over (`humanCanPreempt`), and read access is never
 * blocked for the human. Everything here is pure so it can be unit-tested
 * without a session, a socket, or the Cordis runtime.
 */

/** @typedef {'ro' | 'wo' | 'rw'} AiAccess */
/** @typedef {'human' | 'ai'} Actor */
/** @typedef {'ai' | 'human' | null} LockOwner */

/**
 * @typedef {object} PermissionState
 * @property {AiAccess} aiAccess
 * @property {LockOwner} lockOwner
 * @property {number | null} lockExpiresAt
 * @property {boolean} humanWriteBlocked derived; the human's keystrokes are refused
 * @property {boolean} aiWriteBlocked derived; the AI's writes are refused
 * @property {number} updatedAt
 * @property {number} revision monotonic change counter (internal)
 * @property {number} readRevision read-authorization revision (internal)
 */

/**
 * A verdict returned by the permission gates.
 * @typedef {object} Verdict
 * @property {boolean} allowed
 * @property {string} [code] stable machine code when denied
 * @property {string} [message] human readable explanation when denied
 */

/**
 * @param {boolean} allowed verdict.
 * @param {string} [code] denial code.
 * @param {string} [message] denial message.
 * @returns {Verdict} the verdict.
 */
function verdict(allowed, code, message) {
  return allowed ? { allowed: true } : { allowed: false, code, message }
}

/**
 * Create the initial permission state for a new session.
 * @param {{ aiAccessDefault: AiAccess }} config plugin config.
 * @returns {PermissionState} state.
 */
export function createPermission(config) {
  /** @type {PermissionState} */
  const state = {
    aiAccess: config.aiAccessDefault,
    lockOwner: null,
    lockExpiresAt: null,
    humanWriteBlocked: false,
    aiWriteBlocked: false,
    updatedAt: Date.now(),
    revision: 0,
    readRevision: 0,
  }
  return derive(state, config)
}

/**
 * Recompute the derived flags after any change.
 * @param {PermissionState} state mutable state.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @returns {PermissionState} the same state, updated.
 */
export function derive(state, config) {
  state.humanWriteBlocked = state.lockOwner === 'ai' && config.blockHumanWhileAi
  state.aiWriteBlocked = (state.aiAccess !== 'wo' && state.aiAccess !== 'rw') || state.lockOwner === 'human'
  return state
}

/**
 * Clear an expired AI lock. Called lazily before every gate so no timer drift or
 * suspended host process can leave the human locked out.
 * @param {PermissionState} state mutable state.
 * @param {number} now epoch ms.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @returns {boolean} whether the state changed.
 */
export function expireIfIdle(state, now, config) {
  if (state.lockOwner !== 'ai' || state.lockExpiresAt === null) return false
  if (now < state.lockExpiresAt) return false
  state.lockOwner = null
  state.lockExpiresAt = null
  state.updatedAt = now
  state.revision = (state.revision ?? 0) + 1
  derive(state, config)
  return true
}

/**
 * Gate a read of the session's output.
 * @param {PermissionState} state permission state.
 * @param {Actor} actor who is reading.
 * @returns {Verdict} verdict.
 */
export function checkRead(state, actor) {
  if (actor === 'human') return verdict(true)
  if (state.aiAccess === 'ro' || state.aiAccess === 'rw') return verdict(true)
  return verdict(
    false,
    'AI_READ_DENIED',
    'AI permission for this session is write-only (只写); reading terminal output is not allowed. Ask the user to switch the session to 只读 or 读写.',
  )
}

/**
 * Gate a write of input to the remote session.
 * @param {PermissionState} state permission state.
 * @param {Actor} actor who is writing.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @returns {Verdict} verdict.
 */
export function checkWrite(state, actor, config) {
  if (actor === 'human') {
    if (state.lockOwner === 'ai' && config.blockHumanWhileAi) {
      return verdict(
        false,
        'HUMAN_WRITE_BLOCKED',
        'The AI is operating this session; human input is blocked until it goes idle or you take over control.',
      )
    }
    return verdict(true)
  }
  if (state.aiAccess !== 'wo' && state.aiAccess !== 'rw') {
    return verdict(
      false,
      'AI_WRITE_DENIED',
      'AI permission for this session is read-only (只读); sending input is not allowed. Ask the user to switch the session to 只写 or 读写.',
    )
  }
  if (state.lockOwner === 'human') {
    return verdict(
      false,
      'AI_WRITE_DENIED',
      'The human took over control of this session (人工接管); AI writes are refused until the human releases control.',
    )
  }
  return verdict(true)
}

/**
 * Record an accepted AI write: acquire or refresh the AI control lock.
 * @param {PermissionState} state mutable state.
 * @param {{ aiAutoLock: boolean, aiLockIdleMs: number, blockHumanWhileAi: boolean }} config plugin config.
 * @param {number} [now] epoch ms.
 * @returns {boolean} whether the state changed.
 */
export function noteAiWrite(state, config, now = Date.now()) {
  state.updatedAt = now
  if (!config.aiAutoLock) {
    // Coexistence mode: the AI writes without ever blocking the human.
    if (state.lockOwner === 'ai') {
      state.lockOwner = null
      state.lockExpiresAt = null
      state.revision = (state.revision ?? 0) + 1
      derive(state, config)
      return true
    }
    return false
  }
  state.lockOwner = 'ai'
  state.lockExpiresAt = now + config.aiLockIdleMs
  state.revision = (state.revision ?? 0) + 1
  derive(state, config)
  return true
}

/**
 * The human takes over: the AI may no longer write until released.
 * @param {PermissionState} state mutable state.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @param {number} [now] epoch ms.
 * @returns {boolean} whether the state changed.
 */
export function takeOver(state, config, now = Date.now()) {
  if (state.lockOwner === 'human') return false
  state.lockOwner = 'human'
  state.lockExpiresAt = null
  state.updatedAt = now
  state.revision = (state.revision ?? 0) + 1
  state.readRevision = (state.readRevision ?? 0) + 1
  derive(state, config)
  return true
}

/**
 * Release control: free for either side again.
 * @param {PermissionState} state mutable state.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @param {number} [now] epoch ms.
 * @returns {boolean} whether the state changed.
 */
export function releaseLock(state, config, now = Date.now()) {
  if (state.lockOwner === null && state.lockExpiresAt === null) return false
  state.lockOwner = null
  state.lockExpiresAt = null
  state.updatedAt = now
  state.revision = (state.revision ?? 0) + 1
  state.readRevision = (state.readRevision ?? 0) + 1
  derive(state, config)
  return true
}

/**
 * Change the AI's access mode.
 * @param {PermissionState} state mutable state.
 * @param {AiAccess} aiAccess requested mode.
 * @param {{ blockHumanWhileAi: boolean }} config plugin config.
 * @param {number} [now] epoch ms.
 * @returns {boolean} whether the state changed.
 */
export function setAiAccess(state, aiAccess, config, now = Date.now()) {
  if (state.aiAccess === aiAccess) return false
  state.aiAccess = aiAccess
  state.updatedAt = now
  state.revision = (state.revision ?? 0) + 1
  state.readRevision = (state.readRevision ?? 0) + 1
  derive(state, config)
  return true
}

/**
 * Freeze a permission state for the wire.
 * @param {PermissionState} state permission state.
 * @returns {{ aiAccess: AiAccess, lockOwner: LockOwner, lockExpiresAt: number | null, humanWriteBlocked: boolean, aiWriteBlocked: boolean, updatedAt: number }} snapshot.
 */
export function permissionSnapshot(state) {
  return {
    aiAccess: state.aiAccess,
    lockOwner: state.lockOwner,
    lockExpiresAt: state.lockExpiresAt,
    humanWriteBlocked: state.humanWriteBlocked,
    aiWriteBlocked: state.aiWriteBlocked,
    updatedAt: state.updatedAt,
  }
}
