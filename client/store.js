/**
 * Panel state shared by the tab body, the tab title and the terminal view.
 *
 * A tiny external store (module singletons + `useSyncExternalStore`) keeps the
 * session list across slot remounts: the right sidebar unmounts bodies when a
 * session switches or the pane collapses, and refetching every time would flash
 * the panel. The global SSE stream is reference-counted by mounted bodies.
 */

import { useSyncExternalStore } from 'react'
import {
  ROUTE,
  setOwnerResolver,
  normalizeAuditEntry,
  normalizeBatchFrame,
  normalizeBatchResult,
  normalizePermission,
  normalizeSession,
  parseFrame,
  rpc,
} from './api.js'

/** How many batch progress lines the panel keeps (one per executed step). */
export const BATCH_MAX_LINES = 500

/**
 * Create an idle batch-progress record.
 *
 * `runs` is the normalized `BatchResult` of the RPC that started the batch;
 * `lines` are the compact per-step progress rows from the global `batch` SSE
 * frame, kept in arrival order.
 *
 * @returns a fresh batch state.
 */
export function createBatchState() {
  return {
    batchId: null,
    label: null,
    /** 'idle' | 'running' | 'done' */
    state: 'idle',
    startedAt: 0,
    /** `{ key, batchId, sessionId, stepIndex, depth, path, kind, ok, text, error, code, at }` */
    lines: [],
    /** Normalized BatchResult, or null. */
    runs: null,
    /** Localized/raw failure of the RPC that started the batch. */
    error: null,
    /** True while the start RPC is in flight. */
    pending: false,
  }
}

/**
 * Bottom of the navigation stack: the terminal (or the connection library when
 * there is no session at all). Every other view is pushed on top of it.
 */
const ROOT_VIEW = Object.freeze({ kind: 'terminal' })

/** Overlay panels that can be pushed on the view stack. */
const PANEL_NAMES = ['history', 'scripts', 'profiles']

/** Session objects by id, in Host order. */
const initialState = {
  sessions: [],
  selectedId: null,
  /**
   * Visible view, projected from {@link initialState.viewStack} so components
   * and tests can read it without walking the stack: 'terminal' | 'connect'.
   */
  view: 'terminal',
  /**
   * Rebuilt-screen events by session id (`CONTRACTS.md` §15/§18):
   * `{ [sessionId]: { seq, generation, reason, at } }`.
   *
   * Both the explicit `reset` SSE frame and a `state` frame with a higher
   * `generation` land here. The terminal resets once per entry, so the same
   * event arriving on the global and on the per-session stream still clears the
   * screen exactly once.
   */
  resets: {},
  /**
   * Profile loaded into the connect form for editing (normalized `ProfileInfo`),
   * or null for a brand-new connection. Its presence switches the form into
   * "edit profile" mode: an empty secret field means "keep the stored
   * credential" and save payloads keep this profile's id.
   */
  connectDraft: null,
  /**
   * Explicit navigation stack; the last entry is the visible view.
   *
   * Entries are `{ kind: 'terminal' }`, `{ kind: 'connect', draft }` or
   * `{ kind: 'panel', name, sessionId }`. A stack (instead of the old
   * `view` + `panel` booleans) is what makes ← return to where the user came
   * from: 配置管理 → 编辑连接 → ← lands back on 配置管理, while
   * 终端 → 脚本 → ← lands back on the terminal.
   */
  viewStack: [ROOT_VIEW],
  /** Overlay panel projection of the top entry: null | 'history' | 'scripts' | 'profiles'. */
  panel: null,
  /**
   * Profile to highlight after returning from its editor (`profiles.save`),
   * so the user sees where the saved row went. Cleared on navigation away.
   */
  highlightProfileId: null,
  /** True after the first session list arrived (SSE or RPC). */
  ready: false,
  /** Non-blocking transport problem (SSE or RPC failure). */
  transportError: null,
  /** Transient message rendered as a toast. */
  toast: null,
  /** Bounded per-session audit tail: { [sessionId]: AuditEntry[] }. */
  audit: {},
  /**
   * DSH (AI) session this panel belongs to. Every terminal is scoped to it, so
   * two conversations never share SSH/Telnet sessions.
   */
  owner: undefined,

  /** Live batch execution progress (global `batch` SSE frame). */
  batch: createBatchState(),
}

let state = initialState
const listeners = new Set()
let toastTimer = 0

/* ------------------------------------------------------------------ *
 * Session generation / screen-reset tracking (CONTRACTS.md §15, §17, §18)
 * ------------------------------------------------------------------ */

/** Last generation seen per session id (scratch; never triggers a render). */
const generations = new Map()

/** Monotonic id for reset events, used to dedupe the two SSE streams. */
let resetSeq = 0

/**
 * Track one session's generation and decide whether its screen was rebuilt.
 *
 * A rebuild is announced twice at most: by the explicit `reset` SSE frame and
 * by any later `state` frame whose `generation` grew. Both funnel through this
 * helper so the terminal clears exactly once per generation even when the
 * global and per-session streams both deliver the event — and so a missed
 * `reset` frame (stream was down) still clears the screen on the next `state`.
 *
 * @param session - normalized session record.
 * @param reason - reset reason from a `reset` frame; undefined on the fallback path.
 * @param explicit - true when the caller saw a `reset` frame.
 * @returns a fresh reset entry to store, or null when nothing changed.
 */
function noteGeneration(session, reason, explicit) {
  const previous = generations.get(session.id)
  generations.set(session.id, session.generation)
  const existing = state.resets[session.id]
  // A first sighting is not a reset: on the fallback path we need a *previous*
  // generation, on the explicit path the frame itself announces the rebuild.
  const grew = previous !== undefined && session.generation > previous
  if (!explicit && !grew) return null
  if (existing && session.generation <= existing.generation) return null
  resetSeq += 1
  return {
    seq: resetSeq,
    generation: session.generation,
    reason: typeof reason === 'string' && reason ? reason : null,
    at: Date.now(),
  }
}

/** Insert or replace one session in a list copy. */
function upsertSession(sessions, session) {
  const index = sessions.findIndex((entry) => entry.id === session.id)
  if (index >= 0) {
    sessions[index] = session
    return sessions
  }
  sessions.push(session)
  return sessions
}

/**
 * Store a reset entry together with the session it belongs to.
 *
 * @param session - normalized session.
 * @param entry - reset entry, or null.
 * @param base - partial state patch to extend.
 */
function withReset(session, entry, patch) {
  return entry ? { ...patch, resets: { ...state.resets, [session.id]: entry } } : patch
}

/** @returns the current immutable state snapshot. */
export function getState() {
  return state
}

/**
 * Subscribe to state changes.
 *
 * @param listener - synchronous invalidation callback.
 * @returns unsubscribe callback.
 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Merge a partial state patch and notify subscribers.
 *
 * @param patch - object, or a function producing one from the current state.
 */
export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[aiterm] state listener failed', error)
    }
  }
}

/** React binding for the store. */
export function useAppState() {
  return useSyncExternalStore(subscribe, getState, getState)
}

/**
 * Replace the whole session list from an authoritative Host list.
 *
 * @param rawList - `sessions.list` / `sessions` SSE payload.
 */
export function replaceSessions(rawList) {
  const sessions = Array.isArray(rawList) ? rawList.map(normalizeSession).filter(Boolean) : []
  const live = new Set(sessions.map((session) => session.id))
  const resets = {}
  for (const id of Object.keys(state.resets)) {
    if (live.has(id)) resets[id] = state.resets[id]
  }
  for (const session of sessions) {
    const entry = noteGeneration(session, undefined, false)
    if (entry) resets[session.id] = entry
  }
  // Forget tracking for sessions the Host dropped (close removes them from the
  // list); the id is never reused, so stale generations must not linger.
  for (const id of [...generations.keys()]) {
    if (!live.has(id)) generations.delete(id)
  }
  const selectedId = state.selectedId && sessions.some((session) => session.id === state.selectedId)
    ? state.selectedId
    : sessions.length > 0
      ? sessions[0].id
      : null
  setState({ sessions, selectedId, ready: true, transportError: null, resets })
}

/**
 * Insert or replace one session (state SSE event, local create, permission RPC).
 *
 * A `state` frame with a higher `generation` means the Host rebuilt the remote
 * screen (§15); it records a reset entry so the terminal clears even if the
 * dedicated `reset` frame was missed.
 *
 * @param raw - Host session record.
 * @returns the normalized session, or null when the payload was unusable.
 */
export function mergeSession(raw) {
  const session = normalizeSession(raw)
  if (!session) return null
  const entry = noteGeneration(session, undefined, false)
  const sessions = upsertSession(state.sessions.slice(), session)
  const selectedId = state.selectedId ?? session.id
  setState(withReset(session, entry, { sessions, selectedId, ready: true }))
  return session
}

/**
 * Apply one `reset` SSE frame (`{ type: 'reset', session, reason }`).
 *
 * The frame may arrive on the global stream and on the session's own stream;
 * the generation check makes the second delivery a no-op, so the terminal
 * renders the notice once.
 *
 * @param raw - Host-provided SSE frame.
 */
export function applyResetFrame(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const session = normalizeSession(source.session)
  if (!session) return null
  const entry = noteGeneration(session, source.reason, true)
  const sessions = upsertSession(state.sessions.slice(), session)
  const selectedId = state.selectedId ?? session.id
  setState(withReset(session, entry, { sessions, selectedId, ready: true }))
  return entry
}

/**
 * Read the latest reset entry of one session.
 *
 * @param id - session id.
 * @returns `{ seq, generation, reason, at }` or null.
 */
export function resetEntryFor(id) {
  return state.resets[id] || null
}

/* ------------------------------------------------------------------ *
 * Terminal geometry
 *
 * The reconnect RPC carries the *fitted* xterm size (`sessions.reconnect
 * { id, cols, rows }`), which differs from the session record once the pane
 * has been resized. The terminal publishes it here; the control bar reads it
 * when it builds the payload. Deliberately outside the reactive state: no
 * component needs to re-render when the pane grows by one cell.
 * ------------------------------------------------------------------ */

const terminalSizes = new Map()

/**
 * Record the fitted terminal size of one session.
 *
 * @param id - session id.
 * @param cols - fitted columns.
 * @param rows - fitted rows.
 */
export function setTerminalSize(id, cols, rows) {
  if (!id) return
  const columns = Number(cols)
  const lineCount = Number(rows)
  if (!Number.isFinite(columns) || !Number.isFinite(lineCount)) return
  if (columns < 1 || lineCount < 1) return
  terminalSizes.set(String(id), { cols: Math.trunc(columns), rows: Math.trunc(lineCount) })
}

/**
 * Read the fitted terminal size of one session.
 *
 * @param id - session id.
 * @returns `{ cols, rows }` or null when the terminal never reported one.
 */
export function getTerminalSize(id) {
  return terminalSizes.get(String(id || '')) || null
}


/**
 * Merge a permission result for one session without waiting for the state SSE.
 *
 * @param id - session id.
 * @param rawPermission - `permission` payload from the Host.
 */
export function patchPermission(id, rawPermission) {
  if (!rawPermission) return
  const permission = normalizePermission(rawPermission)
  const sessions = state.sessions.map((session) => (session.id === id ? { ...session, permission } : session))
  setState({ sessions })
}

/**
 * Mark a session closed locally (exit SSE frame, close RPC).
 *
 * @param id - session id.
 * @param reason - optional close reason for the overlay.
 */
export function markSessionClosed(id, reason) {
  const sessions = state.sessions.map((session) => (session.id === id
    ? { ...session, state: 'closed', error: reason || session.error }
    : session))
  setState({ sessions })
}

/* ------------------------------------------------------------------ *
 * View navigation stack (terminal ↔ connect form ↔ overlay panels)
 * ------------------------------------------------------------------ */

/**
 * Project a stack into the flat state keys components render from.
 *
 * @param stack - stack entries (must not be empty).
 * @param extra - additional state patch fields.
 * @returns the state patch.
 */
function stackPatch(stack, extra = {}) {
  const next = stack.length > 0 ? stack : [ROOT_VIEW]
  const top = next[next.length - 1]
  return {
    viewStack: next,
    view: top.kind === 'connect' ? 'connect' : 'terminal',
    panel: top.kind === 'panel' ? top.name : null,
    connectDraft: top.kind === 'connect' ? top.draft || null : null,
    ...extra,
  }
}

/**
 * Apply one stack together with its projections.
 *
 * @param stack - stack entries.
 * @param extra - additional state patch fields.
 */
function setStack(stack, extra = {}) {
  setState(stackPatch(stack, extra))
}

/** @returns the top (visible) stack entry. */
export function currentView() {
  return state.viewStack[state.viewStack.length - 1] || ROOT_VIEW
}

/** @returns true when ← / Esc would leave the current view. */
export function canGoBack() {
  return state.viewStack.length > 1
}

/**
 * Leave the current view (← / Esc). The root terminal view never pops.
 *
 * @returns the entry that was left, or null at the root.
 */
export function popView() {
  if (state.viewStack.length <= 1) return null
  const popped = currentView()
  setStack(state.viewStack.slice(0, -1))
  return popped
}

/** Select a session: leave any sub-view and show its terminal. @param id - session id. */
export function selectSession(id) {
  setState(stackPatch([ROOT_VIEW], { selectedId: id, highlightProfileId: null }))
}

/**
 * Show the connect form, pushed on top of the current view.
 *
 * @param draft - optional normalized profile to edit; omit for a new connection.
 */
export function openConnectView(draft) {
  const normalized = draft && typeof draft === 'object' && typeof draft.id === 'string' && draft.id ? draft : null
  const stack = state.viewStack.slice()
  const top = stack[stack.length - 1]
  const pendingDraft = top.kind === 'connect' && top.draft && top.draft.id ? top.draft.id : null
  const nextDraft = normalized ? normalized.id : null
  if (top.kind === 'connect' && pendingDraft === nextDraft) return
  // The form is a transient view: re-opening it replaces itself instead of
  // stacking two forms.
  if (top.kind === 'connect') stack.pop()
  stack.push({ kind: 'connect', draft: normalized })
  setStack(stack, { highlightProfileId: null })
}

/**
 * Leave the connect form and return to the view it was opened from.
 *
 * @param savedProfileId - id of a profile saved by this form; the profile
 *   library highlights it when the form was opened from there.
 * @returns the now-visible stack entry, or null when the form was not open.
 */
export function closeConnectView(savedProfileId) {
  if (currentView().kind !== 'connect') return null
  const stack = state.viewStack.slice(0, -1)
  const highlight = typeof savedProfileId === 'string' && savedProfileId
    ? savedProfileId
    : state.highlightProfileId
  setStack(stack, { highlightProfileId: highlight || null })
  return currentView()
}

/**
 * Open (or switch to) one overlay panel on top of the terminal.
 *
 * Overlay panels do not nest: opening another one replaces the current panel so
 * ← always returns to the terminal. Opening a panel from the connect form
 * leaves the form first.
 *
 * @param name - 'history' | 'scripts' | 'profiles' | null to close.
 */
export function openPanel(name) {
  if (name === null || name === undefined || !PANEL_NAMES.includes(name)) {
    closePanel()
    return
  }
  // Without a session the library already is the home view: pushing it would
  // only add an invisible stack level.
  if (!state.selectedId && name === 'profiles') return
  const top = currentView()
  if (top.kind === 'panel' && top.name === name) return
  const stack = state.viewStack.slice()
  if (stack[stack.length - 1].kind !== 'terminal') stack.pop()
  stack.push({ kind: 'panel', name, sessionId: state.selectedId })
  setStack(stack)
}

/**
 * Close the overlay panel or leave the connect form (whichever is on top).
 *
 * @returns the closed entry, or null when nothing was open.
 */
export function closePanel() {
  if (currentView().kind !== 'panel') return null
  return popView()
}

/**
 * Highlight one profile row in the library (after saving it).
 *
 * @param id - profile id, or null to clear.
 */
export function setHighlightProfile(id) {
  const next = typeof id === 'string' && id ? id : null
  if (state.highlightProfileId === next) return
  setState({ highlightProfileId: next })
}

/* ------------------------------------------------------------------ *
 * Batch progress (global `batch` SSE frame, CONTRACTS.md §12.3)
 * ------------------------------------------------------------------ */

/**
 * Reset batch progress and mark a batch as starting.
 *
 * @param label - audit label of the batch about to run (e.g. `script:<name>`).
 */
export function startBatch(label) {
  setState({
    batch: {
      ...createBatchState(),
      label: typeof label === 'string' && label ? label : null,
      state: 'running',
      startedAt: Date.now(),
      pending: true,
    },
  })
}

/**
 * Record the settled RPC of a batch started from the UI.
 *
 * Called when `scripts.run` / `batch.run` resolves or fails; the SSE `done`
 * frame may arrive before or after this, so both paths are idempotent.
 *
 * @param outcome.result - raw `BatchResult` payload.
 * @param outcome.error - error message when the RPC itself failed.
 */
export function finishBatch(outcome = {}) {
  const batch = state.batch
  const runs = outcome.result === undefined || outcome.result === null
    ? batch.runs
    : normalizeBatchResult(outcome.result)
  const error = typeof outcome.error === 'string' && outcome.error ? outcome.error : null
  setState({
    batch: {
      ...batch,
      state: 'done',
      pending: false,
      runs,
      error,
    },
  })
}

/**
 * Apply one global `batch` progress frame.
 *
 * `step` frames append a compact line; `done` re-enables the run button. A
 * frame carrying a different batch id than the one in progress starts a new
 * record (so a batch launched by the AI tool shows up too, without mixing).
 *
 * @param raw - Host-provided SSE frame.
 */
export function applyBatchFrame(raw) {
  const frame = normalizeBatchFrame(raw)
  if (!frame) return
  const batch = state.batch

  if (frame.state === 'done') {
    if (batch.batchId && batch.batchId !== frame.batchId) return
    setState({
      batch: {
        ...batch,
        batchId: batch.batchId || frame.batchId,
        label: batch.label || frame.label || null,
        state: 'done',
        pending: false,
      },
    })
    return
  }

  let next = batch
  const differentBatch = batch.batchId !== null && batch.batchId !== frame.batchId
  if (batch.state !== 'running' || differentBatch) {
    // A new batch began (possibly started by the AI or another tab).
    next = {
      ...createBatchState(),
      batchId: frame.batchId,
      label: frame.label || null,
      state: 'running',
      startedAt: Date.now(),
    }
  } else if (!batch.batchId) {
    next = { ...batch, batchId: frame.batchId, label: batch.label || frame.label || null }
  }

  const line = {
    key: `${frame.batchId}:${frame.sessionId}:${frame.stepIndex}:${next.lines.length}`,
    batchId: frame.batchId,
    sessionId: frame.sessionId,
    stepIndex: frame.stepIndex,
    depth: frame.depth,
    path: frame.path,
    kind: frame.kind,
    ok: frame.ok,
    text: frame.text,
    error: frame.error,
    code: frame.code,
    at: Date.now(),
  }
  setState({ batch: { ...next, lines: next.lines.concat(line).slice(-BATCH_MAX_LINES) } })
}

/**
 * Alias of {@link openPanel} for callers that read as "set the active panel".
 *
 * @param name - 'history' | 'scripts' | 'profiles' | null to close.
 */
export function setPanel(name) {
  openPanel(name)
}

/**
 * Show a transient toast.
 *
 * @param text - already-localized message.
 */
export function notify(text) {
  if (!text) return
  setState({ toast: { text, id: Date.now() + Math.random() } })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastTimer = 0
    setState({ toast: null })
  }, 3500)
  if (typeof toastTimer === 'object' && toastTimer && typeof toastTimer.unref === 'function') toastTimer.unref()
}

/**
 * Show a transport problem in the status area (null clears it).
 *
 * @param message - localized message or null.
 */
export function setTransportError(message) {
  if (state.transportError === (message || null)) return
  setState({ transportError: message || null })
}

/**
 * Replace the audit tail of one session.
 *
 * @param sessionId - session id.
 * @param entries - audit entries.
 */
export function setAudit(sessionId, entries) {
  if (!sessionId) return
  const list = Array.isArray(entries) ? entries.map(normalizeAuditEntry).filter(Boolean) : []
  setState({ audit: { ...state.audit, [sessionId]: list.slice(-200) } })
}

/**
 * Append one live audit entry.
 *
 * @param sessionId - session id the entry belongs to.
 * @param raw - Host audit entry.
 */
export function pushAudit(sessionId, raw) {
  const entry = normalizeAuditEntry(raw)
  if (!entry) return
  if (entry.sessionId && entry.sessionId !== sessionId) return
  const current = state.audit[sessionId] || []
  const next = current.concat({ ...entry, sessionId: entry.sessionId || sessionId })
  setState({ audit: { ...state.audit, [sessionId]: next.slice(-200) } })
}

/**
 * Refetch the session list over RPC (SSE fallback).
 *
 * @returns the normalized sessions.
 */
/**
 * Point the panel at a DSH (AI) session and reload its terminals.
 *
 * Terminals belong to the AI session that opened them, so switching the
 * conversation must drop the previous list, selection and any open panels:
 * showing them would leak one conversation into another.
 *
 * @param owner - DSH session id, or undefined when the seat does not provide one.
 * @returns {void}
 */
export function setOwner(owner) {
  const next = typeof owner === 'string' && owner.length > 0 ? owner : undefined
  if (next === state.owner) return
  // Nothing is mounted yet on the very first call: just record the owner, the
  // mounted body will open an already-filtered stream in its own effect.
  const mounted = eventSourceRefs > 0
  if (mounted && eventSource) {
    try {
      eventSource.close()
    } catch {
      /* ignore */
    }
    eventSource = null
  }
  setState({
    owner: next,
    sessions: [],
    selectedId: null,
    ready: false,
    viewStack: [ROOT_VIEW],
    panel: null,
    batch: createBatchState(),
    connectDraft: null,
    highlightProfileId: null,
  })
  if (mounted) {
    // Re-open immediately for whoever is still mounted, then refetch: the new
    // conversation may already own terminals, and waiting for the stream
    // reopen would leave the panel blank for a moment.
    eventSourceRefs -= 1
    retainGlobalStream()
  }
  refreshSessions().catch(() => {})
}

export async function refreshSessions() {
  const result = await rpc('sessions.list', {})
  replaceSessions(result ? result.sessions : [])
  return state.sessions
}

/* ------------------------------------------------------------------ *
 * Global SSE stream (all sessions) — reference counted by mounted bodies.
 * ------------------------------------------------------------------ */

// The wire layer asks for the owner on every call; keep one source of truth.
setOwnerResolver(() => state.owner)

let eventSource = null
let eventSourceRefs = 0

/** Start (or retain) the global SSE stream. */
export function retainGlobalStream() {
  eventSourceRefs += 1
  if (eventSource || typeof EventSource === 'undefined') return
  let source
  try {
    const owner = state.owner
    const query = typeof owner === 'string' && owner.length > 0 ? `?owner=${encodeURIComponent(owner)}` : ''
    source = new EventSource(ROUTE + '/events' + query)
  } catch {
    return
  }
  eventSource = source
  source.onmessage = (event) => {
    const frame = parseFrame(event.data)
    if (!frame) return
    if (frame.type === 'sessions') replaceSessions(frame.sessions)
    else if (frame.type === 'state') mergeSession(frame.session)
    else if (frame.type === 'reset') {
      // Screen rebuilt (§18). The terminal consumes the recorded entry; when
      // this stream saw it first, the per-session delivery is deduped there.
      try {
        applyResetFrame(frame)
      } catch (error) {
        console.error('[aiterm] reset frame failed', error)
      }
    } else if (frame.type === 'batch') {
      try {
        applyBatchFrame(frame)
      } catch (error) {
        console.error('[aiterm] batch frame failed', error)
      }
    }
    // Global `audit` frames are intentionally ignored: the audit popover keeps
    // the bounded per-session tail it receives from that session's stream.
  }
  source.onopen = () => {
    setTransportError(null)
    if (!state.ready) refreshSessions().catch(() => {})
  }
  source.onerror = () => {
    // EventSource retries on its own; keep the last known list and say so.
    setTransportError('stream')
    if (!state.ready) refreshSessions().catch(() => {})
  }
}

/** Release the global SSE stream once the last body unmounts. */
export function releaseGlobalStream() {
  eventSourceRefs = Math.max(0, eventSourceRefs - 1)
  if (eventSourceRefs > 0 || !eventSource) return
  try {
    eventSource.close()
  } catch {
    /* ignore */
  }
  eventSource = null
}
