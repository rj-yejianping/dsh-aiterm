/**
 * Model-facing `aiterm_*` tools.
 *
 * Definitions use hand-written JSON Schema and are registered directly through
 * `ctx.tools.register`; this half imports no `@deepseek-ai/*` module. Every tool
 * goes through the same registry methods the browser uses, so the permission
 * model cannot be bypassed: an AI-only read/write mode, a human takeover, or a
 * human-write lock all apply to tool calls exactly as they do to keystrokes.
 *
 * User-only authority (changing the AI's own permission, taking over control,
 * editing saved profiles) is deliberately absent here.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { coded, jsonSafe } from './util.js'
import { normalizeSteps, runBatch } from './batch.js'
import { createDisclosure, DISCLOSURE_GROUPS } from './disclosure.js'
import { normalizeOwner, ownerScopedRegistry } from './registry.js'
import { runScript } from './script-lang.js'

/** Largest model-facing text produced by a read tool. */
const MAX_RENDER_CHARS = 16_000

/**
 * Owner (DSH session id) of the tool call currently executing.
 *
 * Every `aiterm_*` tool belongs to the AI session that invoked it; the tool
 * schemas deliberately do not expose `owner` because the Host injects it. An
 * async-local scope keeps concurrent tool calls isolated while leaving every
 * tool body's `registry.xxx()` calls unchanged.
 */
const ownerScope = new AsyncLocalStorage()

/** @returns {string | null} owner of the current tool call. */
function currentOwner() {
  return normalizeOwner(ownerScope.getStore())
}

/**
 * Read the session identity from a live DSH Agent.
 *
 * The published `Agent` contract exposes the identity as `agent.id` (a
 * `SessionId`), and `agent.session.id` carries the same value whenever a live
 * session is attached. `agent.sessionId` is accepted because some hosts and test
 * doubles use that spelling. Reading a single spelling is what silently produced
 * ownerless terminals, so every known spelling is tried in authority order.
 * @param {any} agent live agent, or a test double.
 * @returns {string | null} normalized session id.
 */
function agentSessionId(agent) {
  if (agent === undefined || agent === null) return null
  return normalizeOwner(agent.id) ?? normalizeOwner(agent.sessionId) ?? normalizeOwner(agent.session?.id)
}

/**
 * Resolve the DSH conversation a tool call belongs to.
 *
 * A subagent runs under its own session id, but a terminal it opens belongs to
 * the conversation the human is looking at, so the walk stops at the first
 * non-subagent ancestor. A fork keeps its own identity: a fork is a separate
 * conversation, not delegated work.
 * @param {any} ctx plugin context (for the `agents` service, when available).
 * @param {any} exec tool execution.
 * @returns {string | null} owner to bind this call to.
 */
function ownerFromExec(ctx, exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return null
  const own = agentSessionId(agent)
  if (own === null) {
    throw coded(
      'OWNER_UNKNOWN',
      'this SSH/Telnet tool could not determine the calling AI session, so it refused to create a terminal no panel could see',
      500,
    )
  }
  let current = agent
  const seen = new Set([own])
  for (let depth = 0; depth < 8; depth += 1) {
    const header = current?.session?.header
    if (header === undefined || header === null || header.origin !== 'subagent') break
    const parentId = normalizeOwner(header.parentSession)
    if (parentId === null || seen.has(parentId)) break
    seen.add(parentId)
    const registry = ctx?.agents
    const parent = typeof registry?.get === 'function' ? registry.get(parentId) : undefined
    if (parent === undefined || parent === null) break
    current = parent
  }
  return agentSessionId(current) ?? own
}

/** Wire shape of one session (must stay in sync with `SessionRegistry#info`). */
const SESSION_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    transport: { type: 'string', enum: ['ssh', 'telnet'] },
    host: { type: 'string' },
    port: { type: 'integer' },
    username: { type: 'string' },
    profileId: { type: 'string' },
    state: { type: 'string', enum: ['connecting', 'open', 'disconnected', 'closed', 'failed'] },
    error: { type: 'string' },
    cols: { type: 'integer' },
    rows: { type: 'integer' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    lastActivityAt: { type: 'number' },
    bytesIn: { type: 'number' },
    bytesOut: { type: 'number' },
    hostKeyFingerprint: { type: 'string' },
    generation: { type: 'number' },
    disconnectedAt: { type: 'number' },
    closeReason: { type: 'string' },
    reconnecting: { type: 'boolean' },
    permission: {
      type: 'object',
      additionalProperties: false,
      properties: {
        aiAccess: { type: 'string', enum: ['ro', 'wo', 'rw'] },
        lockOwner: { oneOf: [{ type: 'string', enum: ['ai', 'human'] }, { type: 'null' }] },
        lockExpiresAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        humanWriteBlocked: { type: 'boolean' },
        aiWriteBlocked: { type: 'boolean' },
        updatedAt: { type: 'number' },
      },
      required: ['aiAccess', 'lockOwner', 'humanWriteBlocked', 'aiWriteBlocked'],
    },
  },
  required: ['id', 'title', 'transport', 'host', 'port', 'state', 'permission'],
}

/** Audit entry wire shape. */
const AUDIT_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    at: { type: 'number' },
    sessionId: { type: 'string' },
    title: { type: 'string' },
    source: { type: 'string', enum: ['human', 'ai'] },
    action: { type: 'string', enum: ['read', 'write', 'deny', 'lock'] },
    detail: { type: 'string' },
    byteLength: { type: 'number' },
    code: { type: 'string' },
  },
  required: ['at', 'sessionId', 'source', 'action', 'detail'],
}

/** Name of the always-resident progressive-mode discovery entry. */
export const DISCOVER_TOOL_NAME = 'aiterm_discover'

/** Group names accepted by the discovery entry. */
const DISCLOSURE_GROUP_NAMES = Object.freeze(Object.keys(DISCLOSURE_GROUPS))

/**
 * Wire shape of a discovery/expansion result.
 *
 * It accepts both the success payload and every fail-closed refusal produced by
 * the Task 1 controller; `additionalProperties: false` keeps hostile or
 * accidental extras from ever reaching the model.
 */
const DISCOVERY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string', enum: ['full', 'progressive'] },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['group', 'tools'],
      },
    },
    expanded: { type: 'array', items: { type: 'string' } },
    visible: { type: 'array', items: { type: 'string' } },
    dependencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
        },
        required: ['group', 'requires', 'hint'],
      },
    },
    hints: { type: 'array', items: { type: 'string' } },
    nextStep: { type: 'string' },
    error: { type: 'string' },
    group: { type: 'string' },
  },
  required: ['ok', 'mode', 'groups', 'expanded', 'visible', 'dependencies', 'hints', 'nextStep'],
}

/**
 * Render a discovery or expansion result as compact text.
 * @param {Record<string, any>} value JSON-safe result from the controller.
 * @returns {string} model-facing text.
 */
function renderDiscovery(value) {
  const lines = []
  if (value.ok === false) {
    lines.push(`Tool discovery refused (${String(value.error)}).`)
  } else {
    lines.push(`Tool disclosure mode: ${String(value.mode)}.`)
    for (const { group, tools: members } of value.groups) {
      const state = value.expanded.includes(group) ? ' [expanded]' : ''
      lines.push(`${group}${state}${members.length === 0 ? ' — no tools are available to this Agent' : ''}`)
      for (const name of members) lines.push(`  ${name}`)
    }
    if (typeof value.group === 'string') {
      lines.push('', value.mode === 'progressive'
        ? `Expanded "${value.group}"; its tools become callable on the next model step.`
        : `Full mode already exposes every tool; "${value.group}" needs no expansion.`)
    }
  }
  if (typeof value.nextStep === 'string' && value.nextStep.length > 0) lines.push('', value.nextStep)
  for (const hint of value.hints ?? []) lines.push(`- ${hint}`)
  return lines.join('\n')
}

/**
 * One text content block.
 * @param {string} text content.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function textContent(text) {
  return [{ type: 'text', text }]
}

/**
 * Bound a model-facing text, keeping its tail (terminal output's interesting end).
 * @param {string} text content.
 * @returns {string} bounded content.
 */
function boundText(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= MAX_RENDER_CHARS) return value
  return `[output truncated: showing the last ${MAX_RENDER_CHARS} characters]\n${value.slice(-MAX_RENDER_CHARS)}`
}

/**
 * Render one session as a compact human/model readable line block.
 * @param {Record<string, any>} session wire session.
 * @returns {string} description.
 */
function describeSession(session) {
  const permission = session.permission ?? {}
  const access = permission.aiAccess === 'ro' ? 'AI read-only (只读)' : permission.aiAccess === 'wo' ? 'AI write-only (只写)' : 'AI read-write (读写)'
  const lock =
    permission.lockOwner === 'ai'
      ? 'AI holds control (human input blocked)'
      : permission.lockOwner === 'human'
        ? 'human holds control (AI writes refused)'
        : 'control free'
  const lifecycle = []
  if (typeof session.generation === 'number') lifecycle.push(`generation=${session.generation}`)
  if (session.reconnecting === true) lifecycle.push('reconnecting')
  if (session.closeReason !== undefined) lifecycle.push(`closeReason="${session.closeReason}"`)
  if (typeof session.disconnectedAt === 'number') lifecycle.push(`disconnectedAt=${new Date(session.disconnectedAt).toISOString()}`)
  return [
    `${session.id}  ${session.title}  [${session.transport} ${session.host}:${session.port}]`,
    `  state: ${session.state}${session.error === undefined ? '' : ` (${session.error})`}${lifecycle.length > 0 ? `  ${lifecycle.join(' ')}` : ''}`,
    `  size: ${session.cols}x${session.rows}`,
    `  ${access}; ${lock}`,
    `  aiAccess=${String(permission.aiAccess)} lockOwner=${String(permission.lockOwner)} humanWriteBlocked=${String(permission.humanWriteBlocked)} aiWriteBlocked=${String(permission.aiWriteBlocked)}`,
  ].join('\n')
}

/**
 * @param {any} exec tool run context.
 * @returns {any} the initiating agent.
 */
function requireAgent(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) throw new Error('this SSH/Telnet tool requires an initiating agent')
  return agent
}

/**
 * @param {{ registry: any }} plugin plugin state.
 * @returns {any} the registry (owner-scoped for the current tool call) or a clear error.
 */
function requireRegistry(plugin) {
  if (plugin.registry === undefined) throw new Error('the SSH/Telnet backend is not ready yet')
  return ownerScopedRegistry(plugin.registry, currentOwner())
}

/**
 * @param {unknown} value candidate.
 * @param {string} field field name for the error message.
 * @returns {string} required string.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

/**
 * @param {number} ms delay.
 * @returns {Promise<void>} completion.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}

/**
 * Register every `aiterm_*` tool.
 * @param {any} ctx plugin context with the `tools` service.
 * @param {{ get registry(): any, config: any }} plugin plugin state.
 * @returns {void}
 */
export function registerTools(ctx, plugin) {
  // `resolveConfig` guarantees only the exact `progressive` value enables the
  // new behaviour; everything else (including a direct caller's `{}`) keeps the
  // historical unconditional registration untouched, including its lifecycle.
  const progressive = plugin?.config?.toolDisclosure === 'progressive'
  const disclosure = progressive ? createDisclosure({ mode: 'progressive', tools: ctx.tools }) : undefined

  if (disclosure !== undefined) {
    // Agent disposal is the only reliable end-of-life signal for the per-Agent
    // expansion state. `ctx.on` is owned by this plugin's fiber, so unloading
    // the plugin also removes the listener; the effect below additionally
    // clears the controller so late conditions fail closed during teardown.
    if (typeof ctx.on === 'function') {
      ctx.on('agent/disposed', ({ agent }) => {
        disclosure.forget(agent)
      })
    }
    ctx.effect(() => () => disclosure.dispose(), 'aiterm: tool disclosure')
  }

  /**
   * Register one original business tool.
   *
   * Tool results are validated as lossless JSON before they reach the model, so
   * every payload is normalized (absent optional fields dropped, non-finite
   * numbers nulled) on the way out.
   *
   * In progressive mode only, the original registration gains a step-time
   * condition reading the invoking Agent from the `ToolActivationContext`. The
   * condition is side-effect free, synchronous, and catches every failure
   * (including a hostile `agent.id` getter) so a bad caller cannot fail step
   * preparation or widen visibility. No scoped tool is registered, so existing
   * restrictions and scope-local definitions keep their exact behaviour.
   * @param {Record<string, any>} definition tool definition.
   */
  const register = (definition) => {
    const execute = definition.execute
    const guarded = {
      ...definition,
      async execute(args, exec) {
        // Bind the call to the invoking AI session before any registry access.
        const owner = ownerFromExec(ctx, exec)
        const value = await ownerScope.run(owner, () => execute(args, exec))
        const safe = jsonSafe(value)
        return safe === undefined ? null : safe
      },
    }
    if (progressive) {
      const when = (context) => {
        try {
          return disclosure.isVisible(context?.agent, definition.name)
        } catch {
          return false
        }
      }
      ctx.effect(() => ctx.tools.register(guarded, { when }), `aiterm: tool ${definition.name}`)
      return
    }
    ctx.effect(() => ctx.tools.register(guarded), `aiterm: tool ${definition.name}`)
  }

  register({
    name: 'aiterm_list',
    description:
      'List the SSH/Telnet terminal sessions the user has open in the SSH/Telnet panel, with their connection state and per-session AI permission (read-only, write-only, read-write, and who currently holds control). Call this before reading or sending to a session.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessions: { type: 'array', items: SESSION_INFO_SCHEMA }, text: { type: 'string' } },
        required: ['sessions', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute() {
      const registry = requireRegistry(plugin)
      const sessions = registry.list()
      const text =
        sessions.length === 0
          ? 'No SSH/Telnet session is open. Use aiterm_connect with a saved profile id to open one.'
          : sessions.map(describeSession).join('\n\n')
      return { sessions, text }
    },
  })

  register({
    name: 'aiterm_connect',
    description:
      'Open a new SSH or Telnet session in the visible SSH/Telnet panel. Prefer connecting through a saved profile (profileId) — saved passwords and private keys are read by the Host and never exposed to you. With profileId, pass ONLY profileId (plus title/cols/rows): transport/host/port/username/authType overrides are rejected so saved credentials cannot be redirected. Ad-hoc connections may only use agent/none authentication; do not ask the user for a password. The session starts with the deployment default AI permission and the user can change it at any time.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profileId: { type: 'string', description: 'Saved profile id from the panel (recommended).' },
        transport: { type: 'string', enum: ['ssh', 'telnet'], description: 'Ad-hoc connection transport; cannot be combined with profileId (AI calls are rejected).' },
        host: { type: 'string', description: 'Ad-hoc host name or IP; cannot be combined with profileId (AI calls are rejected).' },
        port: { type: 'integer', description: 'Ad-hoc port (default 22 for SSH, 23 for Telnet); cannot be combined with profileId.' },
        username: { type: 'string', description: 'Ad-hoc SSH username; cannot be combined with profileId.' },
        authType: { type: 'string', enum: ['agent', 'none'], description: 'Ad-hoc SSH auth; cannot be combined with profileId. Password/key connections must use a saved profile.' },
        title: { type: 'string', description: 'Optional display title.' },
        cols: { type: 'integer', description: 'Terminal columns (default 100).' },
        rows: { type: 'integer', description: 'Terminal rows (default 30).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { session: SESSION_INFO_SCHEMA, text: { type: 'string' } },
        required: ['session', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute(args, exec) {
      requireAgent(exec)
      const registry = requireRegistry(plugin)
      const session = await registry.create(
        {
          profileId: args.profileId,
          transport: args.transport,
          host: args.host,
          port: args.port,
          username: args.username,
          authType: args.authType,
          title: args.title,
          cols: args.cols,
          rows: args.rows,
        },
        'ai',
      )
      const text =
        session.state === 'open'
          ? `Connected.\n\n${describeSession(session)}`
          : `Connection did not succeed: ${session.error ?? session.state}\n\n${describeSession(session)}`
      return { session, text }
    },
  })

  register({
    name: 'aiterm_status',
    description:
      'Show one session (or all sessions) with its AI permission and control owner. Use it to check why your write was refused or whether the user has taken over.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionId: { type: 'string', description: 'Session id; omit to show every session.' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessions: { type: 'array', items: SESSION_INFO_SCHEMA }, text: { type: 'string' } },
        required: ['sessions', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
        const session = registry.info(registry.get(args.sessionId))
        return { sessions: [session], text: describeSession(session) }
      }
      const sessions = registry.list()
      return {
        sessions,
        text: sessions.length === 0 ? 'No session is open.' : sessions.map(describeSession).join('\n\n'),
      }
    },
  })

  register({
    name: 'aiterm_read',
    description:
      'Read a session\'s output cheaply. mode "delta" (default) returns ONLY output newer than the cursor you were given, so polling a running command costs almost nothing; pass the returned cursor back on the next call. mode "screen" returns the visible screen (optionally only the rows that changed since your previous screen read, with changedOnly:true); "history" returns the scrollback plus the screen; "tail" returns the last raw bytes. Every call returns a fresh cursor and atPrompt (whether the screen looks like a shell prompt). Refused when the session\'s AI permission is write-only (只写).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        mode: { type: 'string', enum: ['delta', 'screen', 'history', 'tail'], description: 'What to read (default delta = new output only).' },
        cursor: { type: 'string', description: 'Cursor from a previous read; omit to continue from your last read position.' },
        maxBytes: { type: 'integer', description: 'Byte cap for delta/tail (default plugin config, typically 8192).' },
        maxLines: { type: 'integer', description: 'Line cap for screen/history.' },
        changedOnly: { type: 'boolean', description: 'For mode "screen": return only rows that changed since your previous screen read.' },
        reader: { type: 'string', description: 'Optional reader name for an independent cursor (default "ai").' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          mode: { type: 'string' },
          truncated: { type: 'boolean' },
          cursor: { type: 'string' },
          newBytes: { type: 'integer' },
          atPrompt: { type: 'boolean' },
          changedLines: { type: 'array', items: { type: 'integer' } },
          unchanged: { type: 'boolean' },
          lineCount: { type: 'integer' },
          session: SESSION_INFO_SCHEMA,
        },
        required: ['text', 'mode', 'truncated', 'cursor', 'atPrompt', 'session'],
      },
      render: (args, value) => {
        const head = `[mode=${value.mode} atPrompt=${value.atPrompt ? 'true' : 'false'} cursor=${value.cursor} +${value.newBytes ?? 0}B${value.unchanged ? ' unchanged' : ''}]`
        if (value.mode === 'delta' && value.text.length === 0) return textContent(`No new output since cursor ${value.cursor}. ${head}`)
        if (value.unchanged) return textContent(`Screen unchanged since your last read. ${head}`)
        return textContent(`${boundText(value.text)}\n\n${head}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      return registry.read(requireString(args.sessionId, 'sessionId'), {
        actor: 'ai',
        mode: args.mode,
        cursor: args.cursor,
        maxBytes: args.maxBytes,
        maxLines: args.maxLines,
        changedOnly: args.changedOnly === true,
        reader: args.reader,
      })
    },
  })

  register({
    name: 'aiterm_screen',
    description:
      'Read the visible screen as text (blank lines trimmed), with the cursor and whether the screen looks like a shell prompt. Use changedOnly:true to receive only the rows that changed since your previous screen read — the cheapest way to follow a progress bar or a TUI. Refused when the session\'s AI permission is write-only (只写).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        changedOnly: { type: 'boolean', description: 'Return only rows changed since your previous screen read (default false).' },
        maxLines: { type: 'integer', description: 'Keep only the last N non-blank lines (default 40).' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          changedLines: { type: 'array', items: { type: 'integer' } },
          unchanged: { type: 'boolean' },
          cursor: { type: 'string' },
          atPrompt: { type: 'boolean' },
          lineCount: { type: 'integer' },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
          session: SESSION_INFO_SCHEMA,
        },
        required: ['text', 'changedLines', 'unchanged', 'cursor', 'atPrompt'],
      },
      render: (args, value) => {
        const head = `[${value.cols ?? '?'}x${value.rows ?? '?'} atPrompt=${value.atPrompt ? 'true' : 'false'} lines=${value.lineCount ?? '?'} changed=${(value.changedLines ?? []).join(',') || 'none'}${value.unchanged ? ' unchanged' : ''}]`
        if (value.unchanged) return textContent(`Screen unchanged since your last read. ${head}`)
        return textContent(`${head}\n${boundText(value.text)}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const sessionId = requireString(args.sessionId, 'sessionId')
      const result = registry.readScreen(sessionId, {
        actor: 'ai',
        changedOnly: args.changedOnly === true,
        maxLines: args.maxLines,
      })
      const session = registry.info(registry.get(sessionId))
      return { ...result, cols: session.cols, rows: session.rows }
    },
  })

  register({
    name: 'aiterm_screenshot',
    description:
      'Deprecated alias of aiterm_screen: returns the visible screen as text with the cursor position and terminal size. Prefer aiterm_read (mode "delta") while following output and aiterm_screen (changedOnly:true) for full-screen programs. Refused when the session\'s AI permission is write-only (只写).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionId: { type: 'string', description: 'Session id from aiterm_list.' } },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
          cursor: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
          alt: { type: 'boolean' },
          atPrompt: { type: 'boolean' },
          cursorToken: { type: 'string' },
          session: SESSION_INFO_SCHEMA,
        },
        required: ['text', 'cols', 'rows', 'cursor', 'session'],
      },
      render: (args, value) =>
        textContent(
          boundText(
            `${value.cols}x${value.rows} cursor ${value.cursor.x},${value.cursor.y}${value.alt ? ' (alternate screen)' : ''}${value.atPrompt ? ' · at prompt' : ''}\n${value.text}`,
          ),
        ),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const sessionId = requireString(args.sessionId, 'sessionId')
      const shot = registry.screenshot(sessionId, 'ai')
      return {
        text: shot.text,
        cols: shot.cols,
        rows: shot.rows,
        cursor: shot.cursor,
        alt: shot.alt === true,
        atPrompt: registry.atPrompt(sessionId),
        cursorToken: String(registry.get(sessionId).output.totalOffset),
        session: shot.session,
      }
    },
  })

  register({
    name: 'aiterm_wait',
    description:
      'Wait for terminal activity instead of polling: until "idle" (default, resolves when output pauses), "pattern" (a regular expression appears in new output, e.g. "Password:|\\\\$ $") or "exit" (the session closes). Returns only the output produced during the wait plus a cursor and atPrompt. This is far cheaper than repeatedly reading the screen.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        until: { type: 'string', enum: ['idle', 'pattern', 'exit'], description: 'What to wait for (default idle).' },
        pattern: { type: 'string', description: 'Regular expression required when until is "pattern".' },
        idleMs: { type: 'integer', description: 'For until "idle": how long output must pause (default 500).' },
        timeoutMs: { type: 'integer', description: 'Give up after this long (default 30000).' },
        cursor: { type: 'string', description: 'Only report output after this cursor (default: output since the wait started).' },
        includeOutput: { type: 'boolean', description: 'Include the produced output text (default true).' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matched: { type: 'boolean' },
          reason: { type: 'string' },
          text: { type: 'string' },
          cursor: { type: 'string' },
          atPrompt: { type: 'boolean' },
          session: SESSION_INFO_SCHEMA,
        },
        required: ['matched', 'reason', 'text', 'cursor', 'atPrompt', 'session'],
      },
      render: (args, value) => {
        const head = value.matched
          ? `[matched=true reason=${value.reason} atPrompt=${value.atPrompt ? 'true' : 'false'} cursor=${value.cursor}]`
          : `[matched=false reason=${value.reason} atPrompt=${value.atPrompt ? 'true' : 'false'} cursor=${value.cursor}] no matching output; the output is still available to a delta read from your previous cursor.`
        return textContent(value.text.length === 0 ? head : `${head}\n\n${boundText(value.text)}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      return registry.waitFor(requireString(args.sessionId, 'sessionId'), {
        until: args.until,
        pattern: args.pattern,
        idleMs: args.idleMs,
        timeoutMs: args.timeoutMs,
        cursor: args.cursor,
        includeOutput: args.includeOutput !== false,
        actor: 'ai',
      })
    },
  })

  register({
    name: 'aiterm_history',
    description:
      'Search or read a session\'s output history with timestamps, including sessions that already closed (history is kept on disk for the configured retention window). Omit sessionId to list recent sessions (live and past) with sizes and time ranges; page with limit/offset and pass the returned snapshot back. If history changed between pages (including a live close), stale:true is returned instead of silently skipping rows. With sessionId: pass search (regex or text) to get matching lines with timestamps and context, or since/until alone to read that time window. Time values accept epoch milliseconds, ISO timestamps, or relative amounts like "10m", "2h", "90s". Cheapest way to answer "what happened at 16:02" without re-reading screens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id; omit to list sessions instead.' },
        historyId: {
          type: 'string',
          description: 'Optional exact incarnation address from the session list. Use it when several incarnations share one logical session id; required to address an older one.',
        },
        since: { type: 'string', description: 'Start time (ISO, epoch ms, or relative like "10m").' },
        until: { type: 'string', description: 'End time.' },
        search: { type: 'string', description: 'Regular expression or plain text to find (case-insensitive).' },
        context: { type: 'integer', description: 'Lines of context around each match (0-5, default 0).' },
        maxMatches: { type: 'integer', description: 'Maximum matches (default 20).' },
        maxBytes: { type: 'integer', description: 'Byte cap for a plain time-window read.' },
        limit: { type: 'integer', description: 'Maximum sessions to list when sessionId is omitted.' },
        offset: { type: 'integer', description: 'Offset for the session list (paging); truncated/total are returned.' },
        snapshot: { type: 'string', description: 'Snapshot token from the previous list page. If history changed, stale:true is returned instead of silently skipping rows.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                transport: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                username: { type: 'string' },
                createdAt: { type: 'number' },
                closedAt: { type: 'number' },
                bytes: { type: 'number' },
                lastTs: { type: 'number' },
                live: { type: 'boolean' },
                historyId: { type: 'string' },
              },
              required: ['id', 'title', 'transport', 'host'],
            },
          },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'number' },
                offset: { type: 'number' },
                line: { type: 'string' },
                before: { type: 'array', items: { type: 'string' } },
                after: { type: 'array', items: { type: 'string' } },
              },
              required: ['at', 'line'],
            },
          },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          total: { type: 'integer' },
          snapshot: { type: 'string' },
          stale: { type: 'boolean' },
          limitReached: { type: 'boolean' },
          scannedBytes: { type: 'number' },
          since: { type: 'number' },
          complete: { type: 'boolean' },
          entry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              transport: { type: 'string' },
              host: { type: 'string' },
              port: { type: 'integer' },
              username: { type: 'string' },
              createdAt: { type: 'number' },
              closedAt: { type: 'number' },
              bytes: { type: 'number' },
              lastTs: { type: 'number' },
              live: { type: 'boolean' },
              historyId: { type: 'string' },
            },
            required: ['id', 'title', 'transport', 'host'],
          },
        },
        required: ['truncated'],
      },
      render: (args, value) => {
        if (Array.isArray(value.sessions)) {
          const snapshot = typeof value.snapshot === 'string' && value.snapshot.length > 0
            ? `\nsnapshot: ${value.snapshot}`
            : ''
          const offset = Number.isInteger(args.offset) ? args.offset : 0
          if (value.stale === true) {
            return textContent(`History changed while paging; restart from the first page (call again with offset 0 and no snapshot) or narrow the time window.${snapshot}`)
          }
          if (value.sessions.length === 0) {
            return textContent(value.limitReached === true
              ? `No more rows can be paged at this server source limit; total may be overestimated for legacy sources; narrow the time window.${snapshot}`
              : `No session history is available yet.${snapshot}`)
          }
          const lines = value.sessions.map((entry) => {
            const when = new Date(entry.createdAt).toISOString().slice(11, 19)
            const end = entry.closedAt === undefined ? 'live' : new Date(entry.closedAt).toISOString().slice(11, 19)
            const address = typeof entry.historyId === 'string' && entry.historyId.length > 0 ? `  historyId=${entry.historyId}` : ''
            return `${entry.id}${address}  ${entry.title}  [${entry.transport} ${entry.host}:${entry.port}]  ${when}→${end}  ${entry.bytes}B`
          })
          const total = Number.isInteger(value.total) ? value.total : value.sessions.length
          const footer = value.limitReached === true
            ? `\n\n[showing ${value.sessions.length} of ${total} — server source limit reached; total may be overestimated for legacy sources; narrow the time window]`
            : (value.truncated === true
              ? `\n\n[showing ${value.sessions.length} of ${total} — more history exists; raise limit, use offset, or narrow the window]`
              : '')
          const next = value.limitReached === true || value.truncated !== true
            ? ''
            : `\nTo page, call aiterm_history again with offset=${offset + value.sessions.length}${snapshot.length > 0 ? ' and the snapshot above' : ''}.`
          return textContent(`${lines.join('\n')}${footer}${snapshot}${next}`)
        }
        if (Array.isArray(value.matches)) {
          if (value.matches.length === 0) return textContent(`No match (scanned ${value.scannedBytes} bytes).`)
          const lines = value.matches.map((match) => {
            const time = new Date(match.at).toISOString().slice(11, 23)
            const before = match.before.map((line) => `        ${line}`).join('\n')
            const after = match.after.map((line) => `        ${line}`).join('\n')
            return [before, `${time}  ${match.line}`, after].filter((part) => part.length > 0).join('\n')
          })
          const footer = `\n\n[${value.matches.length} matches, scanned ${value.scannedBytes} bytes${value.truncated ? ', truncated' : ''}]`
          return textContent(`${lines.join('\n')}${footer}`)
        }
        if (typeof value.text === 'string' && value.text.length > 0) {
          return textContent(`${boundText(value.text)}\n\n[scanned ${value.scannedBytes ?? 0} bytes${value.truncated ? ', truncated' : ''}]`)
        }
        return textContent('No output in that time window.')
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      return registry.historyQuery({
        sessionId: args.sessionId,
        historyId: args.historyId,
        since: args.since,
        until: args.until,
        search: args.search,
        context: args.context,
        maxMatches: args.maxMatches,
        maxBytes: args.maxBytes,
        limit: args.limit,
        offset: args.offset,
        snapshot: args.snapshot,
      })
    },
  })

  register({
    name: 'aiterm_send',
    description:
      'Send text/keystrokes to a session\'s remote shell as the AI. Refused when the session\'s AI permission is read-only (只读) or when the human has taken over control. Use "\\r" or enter:true for a newline; "\\u0003" is Ctrl-C. While the AI operates, human input in the panel is normally blocked; releasing control with aiterm_release_control hands it back to the user between steps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        data: { type: 'string', description: 'Text to send (may contain control characters such as \\u0003 for Ctrl-C).' },
        enter: { type: 'boolean', description: 'Append a carriage return after the text (default false).' },
        waitMs: { type: 'integer', description: 'After sending, wait this many milliseconds and return the new output tail (bounded, 0-30000). Refused output is reported separately when the AI is write-only.' },
      },
      required: ['sessionId', 'data'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          sentBytes: { type: 'integer' },
          permission: SESSION_INFO_SCHEMA.properties.permission,
          output: { type: 'string' },
          outputDenied: { type: 'string' },
        },
        required: ['sessionId', 'sentBytes', 'permission'],
      },
      render: (args, value) => {
        const lines = [`Sent ${value.sentBytes} bytes to ${value.sessionId}.`]
        if (value.permission?.lockOwner === 'ai') lines.push('You now hold control; the user\'s input is blocked until you release or go idle.')
        if (typeof value.outputDenied === 'string') lines.push(`Output not readable: ${value.outputDenied}`)
        if (typeof value.output === 'string' && value.output.length > 0) lines.push('', boundText(value.output))
        return textContent(lines.join('\n'))
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const sessionId = requireString(args.sessionId, 'sessionId')
      const text = `${typeof args.data === 'string' ? args.data : ''}${args.enter === true ? '\r' : ''}`
      const result = await registry.write(sessionId, text, 'ai')
      /** @type {Record<string, unknown>} */
      const value = {
        sessionId,
        sentBytes: Buffer.byteLength(text, 'utf8'),
        permission: result.permission,
      }
      const waitMs = typeof args.waitMs === 'number' && Number.isFinite(args.waitMs) ? Math.max(0, Math.min(30_000, Math.floor(args.waitMs))) : 0
      if (waitMs > 0) {
        await sleep(waitMs)
        try {
          value.output = registry.read(sessionId, { actor: 'ai', mode: 'tail', bytes: 8192 }).text
        } catch (error) {
          value.outputDenied = error instanceof Error ? error.message : String(error)
        }
      }
      return value
    },
  })

  register({
    name: 'aiterm_disconnect',
    description:
      'Disconnect a session while KEEPING it in the list: the same id, title, AI permission, output history and audit trail survive, and aiterm_reconnect brings it back. Use this instead of aiterm_close when the connection should be recoverable (for example between long operations, or when a link is flaky).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        reason: { type: 'string', description: 'Short reason recorded in the audit trail.' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { session: SESSION_INFO_SCHEMA, text: { type: 'string' } }, required: ['session', 'text'] },
      render: (args, value) => textContent(value.text),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const session = await registry.disconnect(requireString(args.sessionId, 'sessionId'), typeof args.reason === 'string' ? args.reason : 'AI disconnect', 'ai')
      return { session, text: `Disconnected (kept for reconnect).\n\n${describeSession(session)}` }
    },
  })

  register({
    name: 'aiterm_reconnect',
    description:
      'Reconnect a disconnected session under the SAME id, preserving its AI permission, output history and audit trail. The terminal screen is reset because the remote shell is new (history search still covers the previous output). A saved profile is re-resolved, so a rotated password is picked up; a session without saved credentials fails with RECONNECT_NO_CREDENTIALS and should be reconnected by the user from its profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session id from aiterm_list.' },
        cols: { type: 'integer', description: 'New terminal columns (default: unchanged).' },
        rows: { type: 'integer', description: 'New terminal rows (default: unchanged).' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { session: SESSION_INFO_SCHEMA, text: { type: 'string' } }, required: ['session', 'text'] },
      render: (args, value) => textContent(value.text),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const session = await registry.reconnect(requireString(args.sessionId, 'sessionId'), { cols: args.cols, rows: args.rows }, 'ai')
      const head = session.state === 'open' ? 'Reconnected; the screen has been reset.' : `Reconnect failed: ${session.error ?? session.state}`
      return { session, text: `${head}\n\n${describeSession(session)}` }
    },
  })

  register({
    name: 'aiterm_resize',
    description: 'Resize a session\'s remote terminal (columns and rows). Use it before reading a screen that was rendered for a different size.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string' },
        cols: { type: 'integer', description: 'Columns (20-500).' },
        rows: { type: 'integer', description: 'Rows (5-300).' },
      },
      required: ['sessionId', 'cols', 'rows'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, session: SESSION_INFO_SCHEMA },
        required: ['ok', 'session'],
      },
      render: (args, value) => textContent(`Resized ${value.session.id} to ${value.session.cols}x${value.session.rows}.`),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const sessionId = requireString(args.sessionId, 'sessionId')
      registry.resize(sessionId, args.cols, args.rows, 'ai')
      return { ok: true, session: registry.info(registry.get(sessionId)) }
    },
  })

  register({
    name: 'aiterm_release_control',
    description:
      'Hand control of a session back to the user. Use it when you have finished operating so the user can type again immediately instead of waiting for the idle timeout. This only releases control the AI itself holds; it never overrides a human takeover.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionId: { type: 'string', description: 'Session id from aiterm_list.' } },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { released: { type: 'boolean' }, permission: SESSION_INFO_SCHEMA.properties.permission },
        required: ['released', 'permission'],
      },
      render: (args, value) => {
        const owner = value.permission?.lockOwner === null ? 'free' : String(value.permission?.lockOwner)
        const head = value.released
          ? 'Control released; the user can type in this session again.'
          : `No AI-held control to release (current owner: ${owner}).`
        return textContent(`${head}\n  aiAccess=${String(value.permission?.aiAccess)} lockOwner=${owner}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      return registry.relinquish(requireString(args.sessionId, 'sessionId'), 'ai')
    },
  })

  register({
    name: 'aiterm_audit',
    description:
      'Read the permission audit trail: every read, write, refusal and control change with its source (human or AI). Use it to explain why an operation was blocked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Limit to one session; omit for every session.' },
        limit: { type: 'integer', description: 'Maximum entries (default 100).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: AUDIT_ENTRY_SCHEMA }, text: { type: 'string' } },
        required: ['entries', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const entries = registry.audit({
        sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
        limit: args.limit,
      })
      const text =
        entries.length === 0
          ? 'The audit trail is empty.'
          : entries
              .map((entry) => {
                const time = new Date(entry.at).toISOString().slice(11, 19)
                const code = entry.code === undefined ? '' : ` ${entry.code}`
                return `${time} ${entry.sessionId} ${entry.source} ${entry.action}${code}: ${entry.detail}`
              })
              .join('\n')
      return { entries, text }
    },
  })

  register({
    name: 'aiterm_close',
    description: 'Close one SSH/Telnet session and drop its connection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionId: { type: 'string', description: 'Session id from aiterm_list.' } },
      required: ['sessionId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (args, value) => textContent(value.ok ? 'Session closed.' : 'Session was already gone.'),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const result = await registry.close(requireString(args.sessionId, 'sessionId'), 'closed by the AI', 'ai')
      return result
    },
  })

  register({
    name: 'aiterm_batch',
    description:
      'Run a sequence of steps — send, then wait for output/idle/a pattern, then read only the new output — in ONE tool call, against one session or fanned out to several. This is the cheap way to drive multi-step operations (deploy checks, logins, service restarts): it avoids one round trip per command and returns only the output each step produced. Every send is permission-checked exactly like aiterm_send, so a read-only session fails that step and a human takeover stops the run. Step fields: sessionId, send, enter, waitFor {pattern, idleMs, timeoutMs}, waitMs, read (delta|screen|none), maxLines.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered steps to execute (max 100).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', description: 'Target session for this step (defaults to the current target).' },
              send: { type: 'string', description: 'Text to send.' },
              enter: { type: 'boolean', description: 'Append a carriage return (default false).' },
              waitFor: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pattern: { type: 'string', description: 'Wait until this regex appears in new output.' },
                  idleMs: { type: 'integer', description: 'Wait until output pauses this long.' },
                  timeoutMs: { type: 'integer', description: 'Wait timeout (default 30000).' },
                },
              },
              waitMs: { type: 'integer', description: 'Fixed wait when waitFor is absent.' },
              read: { type: 'string', enum: ['delta', 'screen', 'none'], description: 'Readback mode after the wait (default delta).' },
              maxLines: { type: 'integer', description: 'For read "screen": keep the last N lines.' },
            },
          },
        },
        targets: { type: 'array', items: { type: 'string' }, description: 'Session ids to run the steps against (defaults to the session of each step).' },
        stopOnError: { type: 'boolean', description: 'Stop the remaining steps on the first failure (default true).' },
        maxTotalMs: { type: 'integer', description: 'Overall budget for the whole batch (default 120000).' },
        parallel: { type: 'boolean', description: 'Run targets concurrently (default false = sequential).' },
        label: { type: 'string', description: 'Optional label recorded in the audit trail and progress events.' },
      },
      required: ['steps'],
    },
    output: {
      schema: BATCH_RESULT_SCHEMA,
      render: (args, value) => textContent(renderBatch(value)),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const steps = normalizeSteps(args.steps)
      const targets = resolveTargets(registry, args.targets, steps)
      const label = typeof args.label === 'string' && args.label.length > 0 ? args.label.slice(0, 80) : 'batch'
      const batchId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const result = await runBatch(registry, steps, {
        targets,
        stopOnError: args.stopOnError !== false,
        maxTotalMs: args.maxTotalMs,
        parallel: args.parallel === true,
        label,
        onStep: (event) => registry.emit({ type: 'batch', batchId, label, state: 'step', ...event }),
      })
      registry.emit({ type: 'batch', batchId, label, state: 'done', sessionId: targets[0] ?? '', stepIndex: -1, ok: result.ok === true })
      return result
    },
  })

  register({
    name: 'aiterm_script_list',
    description:
      'List the saved scripts available on this Host, grouped by folder, with their parameters and step counts. Scripts may contain plain commands plus delay, variable, if/else, loop and expect steps. Run one with aiterm_script_run; author or replace one with aiterm_script_save.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scripts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                folder: { type: 'string' },
                params: { type: 'object' },
                stepCount: { type: 'integer' },
                updatedAt: { type: 'number' },
              },
              required: ['name'],
            },
          },
          text: { type: 'string' },
        },
        required: ['scripts', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute() {
      const store = requireScripts(plugin)
      const scripts = await store.list()
      if (scripts.length === 0) {
        return { scripts, text: 'No saved script exists yet. Author one with aiterm_script_save or from the SSH/Telnet panel.' }
      }
      /** @type {Map<string, typeof scripts>} */
      const byFolder = new Map()
      for (const script of scripts) {
        const folder = typeof script.folder === 'string' && script.folder.length > 0 ? script.folder : ''
        if (!byFolder.has(folder)) byFolder.set(folder, [])
        byFolder.get(folder).push(script)
      }
      const lines = []
      for (const [folder, entries] of [...byFolder.entries()].sort((left, right) => (left[0] || '~').localeCompare(right[0] || '~'))) {
        lines.push(folder.length === 0 ? '[未分组]' : `[${folder}]`)
        for (const script of entries) {
          const params = Object.keys(script.params ?? {})
          lines.push(`  ${script.name}  (${script.stepCount} steps${params.length > 0 ? `, params: ${params.join(', ')}` : ''})`)
          if (typeof script.description === 'string' && script.description.length > 0) lines.push(`    ${script.description}`)
        }
      }
      return { scripts, text: lines.join('\n') }
    },
  })

  register({
    name: 'aiterm_script_save',
    description:
      'Create or replace a saved script. A script is plain JSON data — nothing is evaluated as code: steps may be a command ({send, enter, waitFor, read}), or delay/set/log/expect, or control flow ({if: condition, then: [...], else: [...]}) and ({loop: {count|while|until}, steps: [...]}). Conditions are match/contains/variable/not/all/any. Every send is still permission-checked like aiterm_send, and caps apply (500 steps, depth 5, 100 loop iterations, 50 variables). Ask the user before deleting a script — deletion is not exposed here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        script: {
          type: 'object',
          description: 'Full script definition: { name, description?, folder?, params?, steps }.',
          additionalProperties: true,
        },
      },
      required: ['script'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          script: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              folder: { type: 'string' },
              params: { type: 'object' },
              stepCount: { type: 'integer' },
              updatedAt: { type: 'number' },
            },
            required: ['name'],
          },
          text: { type: 'string' },
        },
        required: ['script', 'text'],
      },
      render: (args, value) => textContent(value.text),
    },
    async execute(args) {
      const store = requireScripts(plugin)
      const saved = await store.save(args.script, 'ai')
      return {
        script: saved,
        text: `Saved script ${saved.name} (${saved.stepCount} steps${saved.folder ? `, folder ${saved.folder}` : ''}).`,
      }
    },
  })

  register({
    name: 'aiterm_script_run',
    description:
      'Run a saved script against a session (or several sessions). Parameters fill {{placeholders}} in the script. Scripts can delay, set variables, branch with if/else on the recent output, loop (count/while/until) and assert with expect; the result lists every executed step with its nesting path and only the output each step produced. Every send is permission-checked like aiterm_send, so a read-only session fails that step and a human takeover stops the run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Script name from aiterm_script_list.' },
        params: { type: 'object', description: 'Parameter values for {{placeholders}}.' },
        sessionId: { type: 'string', description: 'Target session (defaults to the only open session).' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Run against several sessions instead.' },
        stopOnError: { type: 'boolean', description: 'Stop on the first failure (default true).' },
        maxTotalMs: { type: 'integer', description: 'Overall budget (default 120000).' },
        parallel: { type: 'boolean', description: 'Run targets concurrently (default false).' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, result: SCRIPT_RUN_SCHEMA },
        required: ['name', 'result'],
      },
      render: (args, value) => textContent(`Script ${value.name}\n${renderScriptRun(value.result)}`),
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const store = requireScripts(plugin)
      const name = requireString(args.name, 'name')
      const definition = await store.get(name)
      if (definition === undefined) throw new Error(`script "${name}" does not exist; list them with aiterm_script_list`)
      const targets = resolveTargets(registry, args.targets ?? (args.sessionId === undefined ? undefined : [args.sessionId]), definition.steps)
      const label = `script:${name}`
      const batchId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const result = await runScript(registry, definition, {
        params: args.params ?? {},
        targets,
        stopOnError: args.stopOnError !== false,
        maxTotalMs: args.maxTotalMs,
        parallel: args.parallel === true,
        label,
        onStep: (event) => registry.emit({ type: 'batch', batchId, label, state: 'step', ...event }),
      })
      registry.emit({ type: 'batch', batchId, label, state: 'done', sessionId: targets[0] ?? '', stepIndex: -1, ok: result.ok === true })
      return { name, result }
    },
  })

  register({
    name: 'aiterm_export',
    description:
      'Export stored output history for sessions owned by the current conversation (live or already closed) as human-readable text log files on the Host. all:true exports every readable incarnation — including several incarnations that share one logical session id — and returns a skipped list for unreadable/missing sources; a write-only closed incarnation is reported as skipped rather than leaked. Pass historyId to export one exact incarnation. Each line is "<ISO timestamp> <output line>", after a header with transport/host/port/username/title/start. Returns absolute paths with byte and line counts. Time values accept epoch milliseconds, ISO timestamps, or relative amounts like "10m".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Session to export; omit to use the only session.' },
        historyId: {
          type: 'string',
          description: 'Optional exact incarnation address. Use it to export an older incarnation that shares a logical session id.',
        },
        all: { type: 'boolean', description: 'Export every session owned by this conversation, including already closed ones.' },
        since: { type: 'string', description: 'Start time (ISO, epoch ms, or relative like "10m").' },
        until: { type: 'string', description: 'End time (ISO, epoch ms, or relative like "2h").' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                historyId: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'integer' },
                lines: { type: 'integer' },
              },
              required: ['sessionId', 'path', 'bytes', 'lines'],
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                historyId: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
                count: { type: 'integer' },
              },
              required: ['sessionId', 'code', 'message'],
            },
          },
          omitted: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer' },
              limit: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['count', 'limit', 'reason'],
          },
          skippedTotal: { type: 'integer' },
        },
        required: ['dir', 'files', 'skipped'],
      },
      render: (args, value) => {
        const files = Array.isArray(value.files) ? value.files : []
        const skipped = Array.isArray(value.skipped) ? value.skipped : []
        if (files.length === 0 && skipped.length === 0) {
          return textContent(`No history to export (checked ${value.dir}).`)
        }
        const lines = files.map((file) => `${file.sessionId}${file.historyId ? ` (${file.historyId})` : ''}  ${file.bytes}B  ${file.lines} lines  ${file.path}`)
        if (files.length === 0) {
          const skippedTotal = Number.isInteger(value.skippedTotal) ? value.skippedTotal : skipped.length
          const omitted = value.omitted ? `, ${value.omitted.count} incarnation(s) not attempted (${value.omitted.reason})` : ''
          return textContent(`No history file could be exported (checked ${value.dir}); ${skippedTotal} source(s) skipped${omitted}.`)
        }
        const skippedTotal = Number.isInteger(value.skippedTotal) ? value.skippedTotal : skipped.length
        const suffix = skippedTotal > 0 ? `\nSkipped ${skippedTotal} entry/entries (details: ${skipped.length}).` : ''
        const omitted = value.omitted ? `\n${value.omitted.count} incarnation(s) were not attempted (${value.omitted.reason}, limit ${value.omitted.limit}).` : ''
        return textContent(`Exported ${files.length} log file(s) to ${value.dir}:\n${lines.join('\n')}${suffix}${omitted}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      return registry.exportHistory({
        sessionId: args.sessionId,
        historyId: args.historyId,
        all: args.all === true,
        since: args.since,
        until: args.until,
      })
    },
  })

  register({
    name: 'aiterm_autolog',
    description:
      'Query automatic log-file writing. With no arguments it reports the current switch and directory. This is a host-wide privacy setting: only the human can change it from the history panel, so the AI can read the state but any attempt to enable/disable it or choose a directory is refused. Off by default; when enabled, every session appends its live output to <dir>/<sessionId>.log with a header containing only transport/host/port/username/title (never credentials). The setting and directory persist across Host restarts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'Turn automatic log files on or off.' },
        dir: { type: 'string', description: 'Output directory (absolute, or relative to the plugin data directory).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          dir: { type: 'string' },
          needsReview: { type: 'boolean' },
        },
        required: ['enabled', 'dir'],
      },
      render: (args, value) => {
        const review = value.needsReview === true
          ? '\nThis switch was enabled by an older version and is paused: only the human can confirm it in the history panel.'
          : ''
        return textContent(`Automatic log files: ${value.enabled ? 'enabled' : 'disabled'}\nDirectory: ${value.dir}${review}`)
      },
    },
    async execute(args) {
      const registry = requireRegistry(plugin)
      const autolog = registry.autolog
      if (autolog === undefined || autolog === null) throw new Error('automatic log files are not available in this build')
      // The switch and directory are host-wide: enabling them makes every
      // session, including other owners' terminals, write plaintext output to a
      // path the AI chooses. That is a cross-owner disclosure primitive, so the
      // AI may read the state but only the human panel may change it.
      if (args.enabled !== undefined || args.dir !== undefined) {
        throw coded(
          'HUMAN_ONLY',
          'automatic log files are a host-wide privacy setting; only the human can change it from the history panel',
          403,
        )
      }
      return autolog.get()
    },
  })

  // The discovery entry is deliberately not part of any business group: it
  // never touches a terminal, is registered without a condition so it stays
  // resident in progressive mode, and exists only there (full mode keeps the
  // historical 21-tool surface).
  if (progressive) {
    const discoveryDefinition = {
      name: DISCOVER_TOOL_NAME,
      description:
        'Discover the SSH/Telnet toolset. Call with no arguments to list the available groups, the tools this Agent may see, and the groups already expanded; call again with one group (session, history, automation, management) to expand it. Expansion only reveals schemas: it takes effect on the next model step, never grants permission, and existing read-only/write-only AI modes and human control still refuse calls. Begin with the session group.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'string',
            enum: DISCLOSURE_GROUP_NAMES,
            description: 'Group to expand; omit to only inspect the current disclosure state.',
          },
        },
      },
      output: {
        schema: DISCOVERY_OUTPUT_SCHEMA,
        render: (args, value) => textContent(renderDiscovery(value)),
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (args !== null && typeof args === 'object' && args.group !== undefined) {
          return disclosure.expand(agent, args.group)
        }
        return disclosure.discover(agent)
      },
    }
    const discoveryExecute = discoveryDefinition.execute
    const guardedDiscovery = {
      ...discoveryDefinition,
      async execute(args, exec) {
        // No terminal-owner binding: discovery never touches the session
        // registry, so it must work before any terminal exists.
        const value = await discoveryExecute(args, exec)
        const safe = jsonSafe(value)
        return safe === undefined ? null : safe
      },
    }
    ctx.effect(() => ctx.tools.register(guardedDiscovery), `aiterm: tool ${DISCOVER_TOOL_NAME}`)
  }
}

/** Wire shape of one batch run. */
const BATCH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    label: { type: 'string' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          ok: { type: 'boolean' },
          stoppedAt: { type: 'integer' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                ok: { type: 'boolean' },
                matched: { type: 'boolean' },
                text: { type: 'string' },
                cursor: { type: 'string' },
                error: { type: 'string' },
                code: { type: 'string' },
              },
              required: ['index', 'ok'],
            },
          },
        },
        required: ['sessionId', 'ok', 'steps'],
      },
    },
  },
  required: ['ok', 'timedOut', 'runs'],
}

/** One executed script step (nested steps flatten into this list with `depth`/`path`). */
const SCRIPT_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer' },
    depth: { type: 'integer' },
    path: { type: 'string' },
    kind: { type: 'string' },
    ok: { type: 'boolean' },
    matched: { type: 'boolean' },
    text: { type: 'string' },
    error: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['index', 'ok'],
}

/** Wire shape of one script run. */
const SCRIPT_RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    label: { type: 'string' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          ok: { type: 'boolean' },
          stoppedAt: { type: 'integer' },
          steps: { type: 'array', items: SCRIPT_STEP_SCHEMA },
        },
        required: ['sessionId', 'ok', 'steps'],
      },
    },
    variables: { type: 'object' },
    logs: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'timedOut', 'runs'],
}

/**
 * Render a script run as an indented transcript.
 * @param {Record<string, any>} value script result.
 * @returns {string} transcript text.
 */
function renderScriptRun(value) {
  if (!Array.isArray(value.runs) || value.runs.length === 0) return 'The script produced no runs.'
  const lines = []
  lines.push(`Script ${value.label ?? ''}${value.timedOut ? ' (timed out)' : value.ok ? ' (ok)' : ' (failed)'}`)
  for (const run of value.runs) {
    lines.push(`${run.sessionId}: ${run.ok ? 'ok' : 'failed'}${run.stoppedAt === undefined ? '' : `, stopped at step ${run.stoppedAt}`}`)
    for (const step of run.steps) {
      const indent = '  '.repeat((step.depth ?? 0) + 1)
      const status = step.ok ? '✓' : '✗'
      const where = step.path === undefined ? `#${step.index}` : `#${step.path}`
      const kind = step.kind === undefined ? '' : ` ${step.kind}`
      lines.push(`${indent}${where}${kind} ${status}${step.error === undefined ? '' : ` ${step.error}`}`)
      if (typeof step.text === 'string' && step.text.length > 0) {
        for (const line of boundText(step.text).split('\n')) lines.push(`${indent}    ${line}`)
      }
    }
  }
  const variables = value.variables !== undefined && typeof value.variables === 'object' ? Object.entries(value.variables) : []
  if (variables.length > 0) {
    lines.push('', `variables: ${variables.map(([key, entry]) => `${key}=${String(entry)}`).join(', ')}`)
  }
  if (Array.isArray(value.logs) && value.logs.length > 0) {
    lines.push('', 'logs:')
    for (const entry of value.logs.slice(-20)) lines.push(`  ${entry}`)
  }
  return boundText(lines.join('\n'))
}

/**
 * @param {{ scripts?: any }} plugin plugin state.
 * @returns {any} the script store.
 */
function requireScripts(plugin) {
  if (plugin.scripts === undefined) throw new Error('the script store is not ready yet')
  return plugin.scripts
}

/**
 * Resolve batch targets: explicit ids win, otherwise the session named by the
 * first step, otherwise the only open session. The registry is owner-scoped, so
 * `get()` rejects another DSH session's id with `SESSION_NOT_FOUND`.
 * @param {any} registry owner-scoped registry view.
 * @param {unknown} explicit explicit target list.
 * @param {Array<Record<string, any>>} steps validated steps.
 * @returns {string[]} target session ids.
 */
function resolveTargets(registry, explicit, steps) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    const ids = explicit.filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) throw new Error('targets must contain at least one session id')
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
  if (open.length === 0) throw new Error('no open session to run against; connect one first or pass targets')
  throw new Error(`several sessions are open (${open.map((session) => session.id).join(', ')}); pass targets explicitly`)
}

/**
 * Render a batch result as compact text.
 * @param {Record<string, any>} value batch result.
 * @returns {string} transcript text.
 */
function renderBatch(value) {
  if (!Array.isArray(value.runs) || value.runs.length === 0) return 'The batch produced no runs.'
  const lines = []
  if (value.label !== undefined) lines.push(`Batch ${value.label}${value.timedOut ? ' (timed out)' : value.ok ? ' (ok)' : ' (failed)'}`)
  for (const run of value.runs) {
    lines.push(`${run.sessionId}: ${run.ok ? 'ok' : 'failed'}${run.stoppedAt === undefined ? '' : `, stopped at step ${run.stoppedAt}`}`)
    for (const step of run.steps) {
      const status = step.ok ? '✓' : '✗'
      lines.push(`  #${step.index} ${status}${step.error === undefined ? '' : ` ${step.error}`}`)
      if (typeof step.text === 'string' && step.text.length > 0) {
        for (const line of boundText(step.text).split('\n')) lines.push(`      ${line}`)
      }
    }
  }
  return boundText(lines.join('\n'))
}
