/**
 * Authenticated HTTP RPC + SSE surface of the SSH/Telnet panel.
 *
 * Every route lives under the configured prefix (default `/aiterm`) and
 * authenticates through `ctx.connection.admit(req)` — the same trusted-origin and
 * signed-cookie admission the Web GUI itself uses. The wire format is plain JSON;
 * SSE carries per-session terminal output and control-state changes.
 *
 * The browser is always the human caller: this is the only place where
 * `actor: 'human'` is chosen, and the user-only operations (permission changes,
 * takeover, profile edits) exist only here, never as model tools.
 */

import { SessionRegistry, normalizeOwner, ownerScopedRegistry } from './registry.js'
import { normalizeSteps, runBatch } from './batch.js'
import { runScript } from './script-lang.js'
import { CodedError, readJsonBody, sendJson, toBase64 } from './util.js'

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 1024 * 1024
/** Heartbeat interval for SSE responses. */
const HEARTBEAT_MS = 20_000
/** Drop an SSE follower that falls this far behind. */
const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * A single Server-Sent Events response.
 */
class SseChannel {
  /**
   * @param {import('node:http').ServerResponse} res response.
   * @param {() => void} onClose cleanup hook.
   */
  constructor(res, onClose) {
    this.res = res
    this.closed = false
    this.onClose = onClose
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    this.res.write(': connected\n\n')
    this.heartbeat = setInterval(() => {
      if (this.closed) return
      try {
        this.res.write(': ping\n\n')
      } catch {
        this.close()
      }
    }, HEARTBEAT_MS)
    if (typeof this.heartbeat?.unref === 'function') this.heartbeat.unref()
    res.on('close', () => this.close())
    res.on('error', () => this.close())
  }

  /**
   * Send one JSON frame.
   * @param {unknown} payload frame payload.
   * @returns {void}
   */
  send(payload) {
    if (this.closed) return
    if (this.res.writableLength > MAX_STREAM_BUFFER_BYTES) {
      // A follower too slow for a terminal stream reconnects and gets a bounded
      // replay instead of growing the Host's buffer without limit.
      this.close()
      return
    }
    try {
      this.res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      this.close()
    }
  }

  /** @returns {void} */
  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    try {
      this.res.end()
    } catch {
      // already gone
    }
    this.onClose()
  }
}

/**
 * Register the panel routes on a context that owns `webServer` and `connection`.
 * @param {any} webCtx context with `webServer` and `connection`.
 * @param {{ config: any, registry: SessionRegistry, profiles: any, log: (level: string, message: string) => void }} plugin plugin state.
 * @returns {void}
 */
export function registerRoutes(webCtx, plugin) {
  const prefix = plugin.config.routePath
  webCtx.effect(
    () =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: (req, res) => {
          handleRequest(webCtx, plugin, req, res).catch((error) => {
            if (res.headersSent) {
              try {
                res.destroy()
              } catch {
                // already gone
              }
              return
            }
            const status = error instanceof CodedError ? error.statusCode : Number.isInteger(error?.statusCode) ? error.statusCode : 500
            sendJson(res, status, {
              ok: false,
              error: { code: error instanceof CodedError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
            })
          })
        },
      }),
    'aiterm: http rpc + sse',
  )
}

/**
 * @param {any} webCtx web context.
 * @param {{ config: any, registry: SessionRegistry, profiles: any, log: Function }} plugin plugin state.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @returns {Promise<void>} handler completion.
 */
async function handleRequest(webCtx, plugin, req, res) {
  const prefix = plugin.config.routePath
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const route = url.pathname.slice(prefix.length)
  const method = req.method ?? 'GET'

  const connection = webCtx.connection
  if (connection === undefined || typeof connection.admit !== 'function') {
    sendJson(res, 503, { ok: false, error: { code: 'NO_CONNECTION', message: 'the SSH/Telnet panel requires the connection service' } })
    return
  }
  const admission = connection.admit(req)
  if (admission === undefined || admission === null || 'rejection' in admission) {
    const code = admission?.rejection === 403 ? 403 : 401
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(code === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  if (route === '/rpc' && method === 'POST') {
    const body = await readJsonBody(req, MAX_BODY_BYTES)
    const name = typeof body.method === 'string' ? body.method : ''
    const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {}
    try {
      const result = await invoke(plugin, name, params)
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      const status = error instanceof CodedError ? error.statusCode : 500
      sendJson(res, status, {
        ok: false,
        error: {
          code: error instanceof CodedError ? error.code : 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    return
  }

  if (route === '/events' && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    const owner = normalizeOwner(url.searchParams.get('owner'))
    if (sessionId !== null && sessionId.length > 0) openSessionEvents(plugin, res, sessionId, owner)
    else openGlobalEvents(plugin, res, owner)
    return
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown route ${route}` } })
}

/**
 * Dispatch one RPC method. The actor is always `human` here.
 * @param {{ config: any, registry: SessionRegistry, profiles: any }} plugin plugin state.
 * @param {string} name method name.
 * @param {Record<string, any>} params parameters.
 * @returns {Promise<unknown>} method result.
 */
async function invoke(plugin, name, params) {
  // The browser sends the DSH (AI) session id as `owner`; every terminal call is
  // scoped to it so two DSH sessions cannot see or touch each other's terminals.
  const owner = normalizeOwner(params.owner)
  const registry = ownerScopedRegistry(plugin.registry, owner)
  const profiles = plugin.profiles
  switch (name) {
    case 'sessions.list':
      return { sessions: registry.list() }
    case 'sessions.create':
      return { session: await registry.create(params, 'human') }
    case 'sessions.disconnect':
      return { session: await registry.disconnect(String(params.id ?? ''), typeof params.reason === 'string' ? params.reason : 'user disconnect', 'human') }
    case 'sessions.reconnect':
      return { session: await registry.reconnect(String(params.id ?? ''), { cols: params.cols, rows: params.rows }, 'human') }
    case 'sessions.close':
      return registry.close(String(params.id ?? ''), 'closed from the panel', 'human')
    case 'sessions.rename':
      return { session: registry.rename(String(params.id ?? ''), params.title) }
    case 'sessions.resize':
      return registry.resize(String(params.id ?? ''), params.cols, params.rows, 'human')
    case 'sessions.replay':
      return registry.replay(String(params.id ?? ''))
    case 'sessions.input':
      return registry.write(String(params.id ?? ''), typeof params.data === 'string' ? params.data : '', 'human')
    case 'permission.get': {
      const session = registry.get(String(params.id ?? ''))
      return { permission: registry.info(session).permission }
    }
    case 'permission.set':
      return registry.setAiAccess(String(params.id ?? ''), params.aiAccess, 'human')
    case 'lock.takeOver':
      return registry.takeOver(String(params.id ?? ''), 'human')
    case 'lock.release':
      return registry.release(String(params.id ?? ''), 'human')
    case 'profiles.list':
      return profiles.listWithFolders()
    case 'profiles.save': {
      const profile = await profiles.save(params.profile ?? params)
      return { profile }
    }
    case 'profiles.rename': {
      const profile = await profiles.rename(String(params.id ?? ''), params.name)
      return { profile }
    }
    case 'profiles.setFolder': {
      const profile = await profiles.setFolder(String(params.id ?? ''), params.folder)
      return { profile }
    }
    case 'profiles.delete':
      return { ok: await profiles.delete(String(params.id ?? '')) }
    case 'audit.list':
      return {
        entries: registry.audit({
          actor: 'human',
          sessionId: typeof params.id === 'string' ? params.id : undefined,
          limit: params.limit,
        }),
      }
    case 'read.delta':
      return registry.readDelta(String(params.id ?? params.sessionId ?? ''), {
        actor: 'human',
        reader: 'human',
        cursor: params.cursor,
        maxBytes: params.maxBytes,
      })
    case 'read.screen':
      return registry.readScreen(String(params.id ?? params.sessionId ?? ''), {
        actor: 'human',
        reader: 'human',
        changedOnly: params.changedOnly === true,
        maxLines: params.maxLines,
      })
    case 'history.sessions': {
      const page = await registry.historySessionsPage({
        actor: 'human',
        limit: params.limit,
        offset: params.offset,
        snapshot: params.snapshot,
        since: params.since,
        until: params.until,
      })
      return page
    }
    case 'history.query':
      return registry.historyQuery({
        actor: 'human',
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        historyId: typeof params.historyId === 'string' ? params.historyId : undefined,
        since: params.since,
        until: params.until,
        search: params.search,
        context: params.context,
        maxMatches: params.maxMatches,
        maxBytes: params.maxBytes,
        limit: params.limit,
      })
    case 'history.legacy.sessions': {
      const page = await registry.legacyHistorySessionsPage({
        actor: 'human',
        limit: params.limit,
        offset: params.offset,
        snapshot: params.snapshot,
        since: params.since,
        until: params.until,
      })
      return page
    }
    case 'history.legacy.query':
      return registry.legacyHistoryQuery({
        actor: 'human',
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        since: params.since,
        until: params.until,
        search: params.search,
        context: params.context,
        maxMatches: params.maxMatches,
        maxBytes: params.maxBytes,
      })
    case 'history.legacy.export':
      return registry.legacyHistoryExport({
        actor: 'human',
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        since: params.since,
        until: params.until,
      })
    case 'history.export':
      return registry.exportHistory({
        actor: 'human',
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        historyId: typeof params.historyId === 'string' ? params.historyId : undefined,
        all: params.all === true,
        since: params.since,
        until: params.until,
      })
    case 'autolog.get':
      return autoLog(registry).get()
    case 'autolog.set':
      return autoLog(registry).set({
        enabled: typeof params.enabled === 'boolean' ? params.enabled : undefined,
        dir: params.dir,
        confirmLegacy: params.confirmLegacy === true,
      })
    case 'scripts.list':
      return { scripts: await requireScripts(plugin).list() }
    case 'scripts.get': {
      // The editor needs the full definition (steps included) to edit a script
      // without wiping it; the list only carries summaries.
      const name = String(params.name ?? '')
      const definition = await requireScripts(plugin).get(name)
      if (definition === undefined) throw new CodedError('SCRIPT_NOT_FOUND', `script ${name} does not exist`, 404)
      return { script: definition }
    }
    case 'scripts.save':
      return { script: await requireScripts(plugin).save(params.script ?? params, 'human') }
    case 'scripts.delete':
      return { ok: await requireScripts(plugin).delete(String(params.name ?? '')) }
    case 'scripts.run': {
      const name = String(params.name ?? '')
      const store = requireScripts(plugin)
      const definition = await store.get(name)
      if (definition === undefined) throw new CodedError('SCRIPT_NOT_FOUND', `script ${name} does not exist`, 404)
      const targets = resolveTargets(
        registry,
        params.targets ?? (params.sessionId === undefined ? undefined : [params.sessionId]),
        definition.steps,
      )
      const label = `script:${name}`
      const batchId = `s-${Date.now().toString(36)}`
      const result = await runScript(registry, definition, {
        params: params.params ?? {},
        targets,
        stopOnError: params.stopOnError !== false,
        maxTotalMs: params.maxTotalMs,
        parallel: params.parallel === true,
        label,
        onStep: (event) => registry.emit({ type: 'batch', batchId, label, state: 'step', ...event }),
      })
      registry.emit({ type: 'batch', batchId, label, state: 'done', sessionId: targets[0] ?? '', stepIndex: -1, ok: result.ok === true })
      return { result }
    }
    case 'batch.run': {
      const steps = normalizeSteps(params.steps)
      const targets = resolveTargets(registry, params.targets, steps)
      const label = typeof params.label === 'string' && params.label.length > 0 ? params.label.slice(0, 80) : 'batch'
      const batchId = `b-${Date.now().toString(36)}`
      const result = await runBatch(registry, steps, {
        targets,
        stopOnError: params.stopOnError !== false,
        maxTotalMs: params.maxTotalMs,
        parallel: params.parallel === true,
        label,
        onStep: (event) => registry.emit({ type: 'batch', batchId, label, state: 'step', ...event }),
      })
      registry.emit({ type: 'batch', batchId, label, state: 'done', sessionId: targets[0] ?? '', stepIndex: -1, ok: result.ok === true })
      return { result }
    }
    default:
      throw new CodedError('UNKNOWN_METHOD', `unknown RPC method ${name}`, 400)
  }
}

/**
 * @param {{ scripts?: any }} plugin plugin state.
 * @returns {any} the script store.
 */
function requireScripts(plugin) {
  if (plugin.scripts === undefined) throw new CodedError('SCRIPTS_UNAVAILABLE', 'the script store is not ready yet', 503)
  return plugin.scripts
}

/**
 * @param {SessionRegistry} registry session registry.
 * @returns {import('./autolog.js').AutoLog} the automatic log controller.
 */
function autoLog(registry) {
  if (registry.autolog === undefined || registry.autolog === null) {
    throw new CodedError('AUTOLOG_UNAVAILABLE', 'automatic log files are not available in this build', 503)
  }
  return registry.autolog
}

/**
 * Resolve batch targets (explicit ids, else a step's session, else the only open session).
 *
 * The registry passed in is already owner-scoped, so `get()` turns another DSH
 * session's id into `SESSION_NOT_FOUND` and every returned target is reachable.
 * @param {SessionRegistry} registry owner-scoped registry view.
 * @param {unknown} explicit explicit targets.
 * @param {Array<Record<string, any>>} steps steps.
 * @returns {string[]} target ids.
 */
function resolveTargets(registry, explicit, steps) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    const ids = explicit.filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) throw new CodedError('BAD_TARGETS', 'targets must contain at least one session id', 400)
    const targets = ids.slice(0, 16)
    for (const id of targets) registry.get(id)
    return targets
  }
  const fromSteps = steps.find((step) => typeof step.sessionId === 'string' && step.sessionId.length > 0)
  if (fromSteps !== undefined) {
    registry.get(fromSteps.sessionId)
    return [fromSteps.sessionId]
  }
  const open = registry.list().filter((session) => session.state === 'open')
  if (open.length === 1) return [open[0].id]
  if (open.length === 0) throw new CodedError('NO_SESSION', 'no open session to run against; connect one first or pass targets', 409)
  throw new CodedError(
    'AMBIGUOUS_TARGET',
    `several sessions are open (${open.map((session) => session.id).join(', ')}); pass targets explicitly`,
    409,
  )
}

/**
 * Stream the session list plus control-state changes for one DSH (AI) session.
 *
 * Frames for terminals owned by another DSH session are dropped here, never
 * serialized, so the browser cannot observe them even by accident.
 * @param {{ registry: SessionRegistry }} plugin plugin state.
 * @param {import('node:http').ServerResponse} res response.
 * @param {string | null} owner requesting DSH session id (`null` = legacy bucket).
 * @returns {void}
 */
function openGlobalEvents(plugin, res, owner) {
  const registry = plugin.registry
  const wanted = normalizeOwner(owner)
  /** @type {SseChannel | undefined} */
  let channel
  const unsubscribe = registry.subscribe((event) => {
    if (channel === undefined) return
    if (event.type === 'sessions') {
      channel.send({ type: 'sessions', sessions: registry.list(wanted) })
      return
    }
    const sessionId = event.type === 'audit' ? event.entry?.sessionId : event.sessionId
    if (typeof sessionId === 'string' && registry.ownerOf(sessionId) !== wanted) return
    if (event.type === 'state') channel.send({ type: 'state', session: event.session })
    else if (event.type === 'audit') channel.send({ type: 'audit', entry: event.entry })
    else if (event.type === 'exit') channel.send({ type: 'exit', sessionId: event.sessionId, code: event.code, reason: event.reason })
    else if (event.type === 'reset') channel.send({ type: 'reset', sessionId: event.sessionId, session: event.session, reason: event.reason })
    else if (event.type === 'batch') {
      // Batch/script progress for the panel's live step log (CONTRACTS §12.3).
      channel.send({
        type: 'batch',
        batchId: event.batchId,
        label: event.label,
        state: event.state,
        sessionId: event.sessionId,
        stepIndex: event.stepIndex,
        ok: event.ok,
        text: event.text,
        error: event.error,
      })
    }
  })
  channel = new SseChannel(res, unsubscribe)
  channel.send({ type: 'sessions', sessions: registry.list(wanted) })
}

/**
 * Stream one session: retained output for replay, then live frames.
 * @param {{ registry: SessionRegistry }} plugin plugin state.
 * @param {import('node:http').ServerResponse} res response.
 * @param {string} sessionId session id.
 * @param {string | null} owner requesting DSH session id (`null` = legacy bucket).
 * @returns {void}
 */
function openSessionEvents(plugin, res, sessionId, owner) {
  const registry = plugin.registry
  /** @type {SseChannel | undefined} */
  let channel
  let session
  try {
    session = registry.get(sessionId, normalizeOwner(owner))
  } catch (error) {
    // A terminal owned by another DSH session answers exactly like a missing one.
    sendJson(res, 404, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: error instanceof Error ? error.message : 'unknown session' } })
    return
  }
  const unsubscribe = registry.subscribe((event) => {
    if (channel === undefined || event.sessionId !== sessionId) return
    if (event.type === 'data') channel.send({ type: 'data', chunk: event.chunk })
    else if (event.type === 'reset') channel.send({ type: 'reset', session: event.session, reason: event.reason })
    else if (event.type === 'state') channel.send({ type: 'state', session: event.session })
    else if (event.type === 'audit') channel.send({ type: 'audit', entry: event.entry })
    else if (event.type === 'exit') {
      channel.send({ type: 'exit', code: event.code, reason: event.reason })
      channel.close()
    }
  })
  channel = new SseChannel(res, unsubscribe)
  channel.send({ type: 'hello', session: registry.info(session), replay: toBase64(session.ring.toBuffer()) })
}
