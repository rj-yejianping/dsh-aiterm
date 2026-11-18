/**
 * Task 3 — permission regression against the real session registry.
 *
 * Progressive disclosure only decides which tool schemas a model step is
 * offered. It must never change what a call is *allowed* to do, so every case
 * here drives the shipped `SessionRegistry` (and its `ownerScopedRegistry`
 * facade) through the real `aiterm_*` tool definitions and the real permission
 * functions in `lib/host/permission.js`. Nothing in this file replaces the
 * permission mechanism: the only test double is the Cordis registration
 * boundary and the transport connection (an in-memory write sink), because the
 * task forbids any SSH/Telnet network connection.
 *
 * Full and progressive mode are compared for the same scenarios:
 * read-only refuses writes, write-only refuses reads, a human takeover refuses
 * AI writes until released, and releasing hands control back. The terminal
 * owner (a DSH session id) and the disclosure identity (a live Agent object)
 * are deliberately independent: two Agent objects sharing one id share their
 * terminal but not their expansion state.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { resolveConfig } from '../lib/host/config.js'
import { DISCLOSURE_GROUPS } from '../lib/host/disclosure.js'
import { createPermission } from '../lib/host/permission.js'
import { SessionRegistry, ownerScopedRegistry } from '../lib/host/registry.js'
import { OutputLog } from '../lib/host/outputlog.js'
import { Screen } from '../lib/host/screen.js'
import { registerTools } from '../lib/host/tools.js'
import { ByteRing } from '../lib/host/util.js'

const DISCOVER = 'aiterm_discover'
const SESSION_TOOLS = DISCLOSURE_GROUPS.session
const MODEL_SELECTION = Object.freeze({ provider: 'test-provider', model: 'test-model' })

/**
 * A no-op automatic logger: the permission scenarios never write log files.
 * @returns {Record<string, Function>} AutoLog-compatible stub.
 */
function noopAutolog() {
  return {
    init: async () => {},
    open() {},
    append() {},
    close: async () => {},
    dispose: async () => {},
    get: () => ({ enabled: false, dir: '' }),
    set: () => ({ enabled: false, dir: '' }),
  }
}

/**
 * Create a real {@link SessionRegistry} with no disk or network side effects.
 * @param {Record<string, unknown>} [overrides] resolved-config overrides.
 * @returns {SessionRegistry} the real registry.
 */
function makeRegistry(overrides = {}) {
  const config = resolveConfig({
    aiAccessDefault: 'rw',
    aiAutoLock: true,
    aiLockIdleMs: 60_000,
    blockHumanWhileAi: true,
    humanCanPreempt: true,
    maxSessions: 16,
    ...overrides,
  })
  return new SessionRegistry({
    config,
    profiles: {},
    dataDir: join(tmpdir(), 'aiterm-permissions-test'),
    log: () => {},
    autolog: noopAutolog(),
  })
}

/**
 * Attach one open session record to a real registry.
 *
 * The record has the same shape `SessionRegistry#create` builds (real
 * `Screen`, `OutputLog`, `ByteRing`, and `createPermission`), but its transport
 * is an in-memory write sink, so no SSH/Telnet connection is opened and the
 * user's real sessions are never touched.
 * @param {SessionRegistry} registry real registry.
 * @param {{ id?: string, owner?: string | null, aiAccess?: 'ro' | 'wo' | 'rw' }} [options] record options.
 * @returns {{ record: any, writes: string[], connection: any }} attached session.
 */
function attachControlledSession(registry, { id = 'st-1', owner = 'owner-1', aiAccess = 'rw' } = {}) {
  const now = Date.now()
  const writes = []
  const connection = {
    write(data) {
      writes.push(data)
    },
    resize() {},
    close: async () => {},
  }
  const record = {
    id,
    title: `test ${id}`,
    transport: 'telnet',
    host: '127.0.0.1',
    port: 23,
    username: 'tester',
    profileId: undefined,
    owner,
    state: 'open',
    error: undefined,
    cols: 100,
    rows: 30,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    bytesIn: 0,
    bytesOut: 0,
    permission: createPermission(registry.config),
    screen: new Screen({ cols: 100, rows: 30, scrollback: 1000 }),
    ring: new ByteRing(65_536),
    output: new OutputLog({ maxBytes: 65_536, maxAgeMs: 600_000 }),
    cursors: new Map(),
    screens: new Map(),
    waiters: new Set(),
    lastOutputAt: now,
    connection,
    auth: { type: 'none' },
    targetTransport: 'telnet',
    generation: 1,
    disconnectedAt: undefined,
    closeReason: undefined,
    reconnecting: false,
    readyPromise: Promise.resolve(),
    lockTimer: undefined,
    audit: [],
    hostKeyFingerprint: undefined,
  }
  registry.sessions.set(id, record)
  registry.owners.set(id, owner)
  if (aiAccess !== registry.config.aiAccessDefault) registry.setAiAccess(id, aiAccess, 'human', owner)
  return { record, writes, connection }
}

/**
 * Isolated Cordis/tools registration boundary.
 *
 * `tools.register` captures definitions exactly like the real service;
 * `tools.get(name, agent)` returns the same definition for every Agent unless
 * no definition exists. The step resolver below applies `when` before building
 * one immutable per-step admission set, mirroring the shipped semantics that
 * Task 2 characterized against the real `ToolsService`.
 * @param {{ mode?: 'full' | 'progressive', registry: SessionRegistry }} options harness options.
 * @returns {any} harness.
 */
function makeHarness({ mode = 'progressive', registry }) {
  const registrations = []
  const effects = []
  const listeners = new Map()
  const tools = {
    register(definition, options = {}) {
      const entry = { definition, options }
      registrations.push(entry)
      return () => {}
    },
    get(name) {
      return registrations.find(({ definition }) => definition.name === name)?.definition
    },
  }
  const ctx = {
    tools,
    effect(run) {
      const cleanup = run()
      effects.push({ cleanup })
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    on(event, listener) {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return () => {}
    },
  }
  registerTools(ctx, { config: { toolDisclosure: mode }, registry })
  return {
    registrations,
    effects,
    listeners,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
}

/**
 * Resolve one immutable model step: apply every `when` condition.
 * @param {any} harness harness from {@link makeHarness}.
 * @param {object} agent step Agent.
 * @returns {Promise<{ names: string[], has(name: string): boolean, call(name: string, args?: object): Promise<any> }>} step.
 */
async function prepare(harness, agent) {
  const admitted = new Map()
  const signal = new AbortController().signal
  for (const { definition, options } of harness.registrations) {
    if (options.when !== undefined) {
      const enabled = await options.when({ agent, modelSelection: MODEL_SELECTION, signal })
      if (!enabled) continue
    }
    admitted.set(definition.name, definition)
  }
  return {
    names: [...admitted.keys()],
    has(name) {
      return admitted.has(name)
    },
    async call(name, args = {}) {
      const definition = admitted.get(name)
      if (definition === undefined) {
        const error = new Error(`UNKNOWN_TOOL: "${name}" was not admitted into this model step`)
        error.code = 'UNKNOWN_TOOL'
        throw error
      }
      return definition.execute(args, { agent, modelSelection: MODEL_SELECTION, signal })
    },
  }
}

/**
 * Expand the session group for one Agent and return the next model step.
 * @param {any} harness harness.
 * @param {object} agent caller.
 * @returns {Promise<any>} next step.
 */
async function expandSession(harness, agent) {
  const first = await prepare(harness, agent)
  assert.deepEqual(first.names, [DISCOVER], 'the first step must expose only the discovery entry')
  const result = await first.call(DISCOVER, { group: 'session' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.visible, SESSION_TOOLS)
  return await prepare(harness, agent)
}

/**
 * Assert a tool call rejects with a registry permission code.
 * @param {() => Promise<any>} operation call.
 * @param {string} code expected stable code.
 * @returns {Promise<Error>} the rejection.
 */
async function rejectWithCode(operation, code) {
  let caught
  await assert.rejects(
    async () => {
      try {
        await operation()
      } catch (error) {
        caught = error
        throw error
      }
    },
    (error) => {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
      return true
    },
  )
  return caught
}

/**
 * Drive one mode through the shared permission matrix and collect stable outcomes.
 * @param {'full' | 'progressive'} mode disclosure mode.
 * @returns {Promise<Record<string, any>>} observed outcomes.
 */
async function permissionMatrix(mode) {
  const registry = makeRegistry()
  const agent = { id: `owner-${mode}` }
  const { record, writes } = attachControlledSession(registry, { owner: agent.id })
  const harness = makeHarness({ mode, registry })
  let step = await prepare(harness, agent)
  if (mode === 'progressive') step = await expandSession(harness, agent)
  else assert.equal(step.names.length, 21)

  /** @type {Record<string, any>} */
  const outcomes = { mode }

  // 1) read-only (只读): AI may read, may never write.
  registry.setAiAccess(record.id, 'ro', 'human', agent.id)
  const readRo = await step.call('aiterm_read', { sessionId: record.id, mode: 'delta' })
  outcomes.readOnlyReadOk = typeof readRo.text === 'string'
  const writesBefore = writes.length
  const roError = await rejectWithCode(() => step.call('aiterm_send', { sessionId: record.id, data: 'id\n' }), 'AI_WRITE_DENIED')
  outcomes.readOnlyWrite = { code: roError.code, message: roError.message, wroteBytes: writes.length - writesBefore }
  outcomes.readOnlyAuditCode = record.audit.at(-1)?.code

  // 2) write-only (只写): AI may write, may never read.
  registry.setAiAccess(record.id, 'wo', 'human', agent.id)
  const readError = await rejectWithCode(() => step.call('aiterm_read', { sessionId: record.id, mode: 'delta' }), 'AI_READ_DENIED')
  const screenError = await rejectWithCode(() => step.call('aiterm_screen', { sessionId: record.id }), 'AI_READ_DENIED')
  const screenshotError = await rejectWithCode(() => step.call('aiterm_screenshot', { sessionId: record.id }), 'AI_READ_DENIED')
  const carriedWaitError = await rejectWithCode(
    () => step.call('aiterm_wait', { sessionId: record.id, until: 'idle', timeoutMs: 100, idleMs: 50 }),
    'AI_READ_DENIED',
  )
  outcomes.writeOnly = {
    read: readError.code,
    screen: screenError.code,
    screenshot: screenshotError.code,
    wait: carriedWaitError.code,
  }
  outcomes.writeOnlyAuditCode = record.audit.at(-1)?.code
  const sent = await step.call('aiterm_send', { sessionId: record.id, data: 'whoami' })
  outcomes.writeOnlySend = { sentBytes: sent.sentBytes, wrote: writes.at(-1) }
  outcomes.lockAfterAiWrite = sent.permission.lockOwner

  // 3) Artificial human takeover (人工接管): AI writes are refused until release.
  registry.setAiAccess(record.id, 'rw', 'human', agent.id)
  registry.takeOver(record.id, 'human', agent.id)
  const takeoverWrites = writes.length
  const takeoverError = await rejectWithCode(
    () => step.call('aiterm_send', { sessionId: record.id, data: 'whoami\n' }),
    'AI_WRITE_DENIED',
  )
  outcomes.takeover = {
    code: takeoverError.code,
    message: takeoverError.message,
    wroteBytes: writes.length - takeoverWrites,
    lockOwner: registry.info(record).permission.lockOwner,
  }
  // The human is still allowed to type while they hold control.
  await registry.write(record.id, 'human\n', 'human', agent.id)
  outcomes.humanWriteDuringTakeover = writes.at(-1)
  // The AI cannot release a human takeover: "release control" only loosens its own hold.
  const refusedRelease = await step.call('aiterm_release_control', { sessionId: record.id })
  outcomes.releaseUnderTakeover = { released: refusedRelease.released, lockOwner: refusedRelease.permission.lockOwner }

  // 4) The human releases control; the AI writes again and then releases its own hold.
  registry.release(record.id, 'human', agent.id)
  const afterRelease = await step.call('aiterm_send', { sessionId: record.id, data: 'uname -a', enter: true })
  outcomes.afterHumanRelease = { wrote: writes.at(-1), lockOwner: afterRelease.permission.lockOwner }
  const aiRelease = await step.call('aiterm_release_control', { sessionId: record.id })
  outcomes.aiRelease = { released: aiRelease.released, lockOwner: aiRelease.permission.lockOwner }
  // A human may type again immediately after the AI hands control back.
  await registry.write(record.id, 'echo human\n', 'human', agent.id)
  outcomes.humanWriteAfterAiRelease = writes.at(-1)

  // The same session, still the same owner, was never restarted or replaced.
  outcomes.sessionIntact = {
    state: record.state,
    generation: record.generation,
    sameObject: registry.sessions.get(record.id) === record,
    auditActions: record.audit.map((entry) => `${entry.source}:${entry.action}:${entry.code ?? ''}`),
  }
  await registry.dispose()
  return outcomes
}

test('full and progressive mode enforce the same real permission matrix', async () => {
  const full = await permissionMatrix('full')
  const progressive = await permissionMatrix('progressive')

  assert.equal(full.readOnlyReadOk, true)
  assert.equal(progressive.readOnlyReadOk, true)
  assert.equal(full.readOnlyWrite.wroteBytes, 0)
  assert.equal(progressive.readOnlyWrite.wroteBytes, 0)
  assert.deepEqual(full.readOnlyWrite.code, 'AI_WRITE_DENIED')
  assert.deepEqual(full.readOnlyWrite.code, progressive.readOnlyWrite.code)
  assert.deepEqual(full.readOnlyWrite.message, progressive.readOnlyWrite.message)
  assert.deepEqual(full.readOnlyAuditCode, 'AI_WRITE_DENIED')
  assert.deepEqual(progressive.readOnlyAuditCode, 'AI_WRITE_DENIED')
  assert.deepEqual(full.writeOnly, progressive.writeOnly)
  assert.deepEqual(full.writeOnlyAuditCode, 'AI_READ_DENIED')
  assert.deepEqual(progressive.writeOnlyAuditCode, 'AI_READ_DENIED')
  assert.deepEqual(full.writeOnly, {
    read: 'AI_READ_DENIED',
    screen: 'AI_READ_DENIED',
    screenshot: 'AI_READ_DENIED',
    wait: 'AI_READ_DENIED',
  })
  assert.equal(full.writeOnlySend.wrote, 'whoami')
  assert.equal(progressive.writeOnlySend.wrote, 'whoami')
  assert.equal(full.lockAfterAiWrite, 'ai')
  assert.equal(progressive.lockAfterAiWrite, 'ai')

  assert.equal(full.takeover.code, 'AI_WRITE_DENIED')
  assert.equal(progressive.takeover.code, 'AI_WRITE_DENIED')
  assert.equal(full.takeover.wroteBytes, 0)
  assert.equal(progressive.takeover.wroteBytes, 0)
  assert.equal(full.takeover.lockOwner, 'human')
  assert.equal(progressive.takeover.lockOwner, 'human')
  assert.match(full.takeover.message, /human took over|人工接管/i)
  assert.match(progressive.takeover.message, /human took over|人工接管/i)
  assert.equal(full.takeover.message, progressive.takeover.message)
  assert.equal(full.humanWriteDuringTakeover, 'human\n')
  assert.equal(progressive.humanWriteDuringTakeover, 'human\n')
  // release_control never overrides a human takeover.
  assert.deepEqual(full.releaseUnderTakeover, { released: false, lockOwner: 'human' })
  assert.deepEqual(progressive.releaseUnderTakeover, { released: false, lockOwner: 'human' })

  // After the human releases, the AI may write and may hand its own control back.
  assert.deepEqual(full.afterHumanRelease, { wrote: 'uname -a\r', lockOwner: 'ai' })
  assert.deepEqual(progressive.afterHumanRelease, { wrote: 'uname -a\r', lockOwner: 'ai' })
  assert.deepEqual(full.aiRelease, { released: true, lockOwner: null })
  assert.deepEqual(progressive.aiRelease, { released: true, lockOwner: null })
  assert.equal(full.humanWriteAfterAiRelease, 'echo human\n')
  assert.equal(progressive.humanWriteAfterAiRelease, 'echo human\n')

  // Both modes left the one real session untouched.
  assert.deepEqual(full.sessionIntact.state, 'open')
  assert.deepEqual(progressive.sessionIntact.state, 'open')
  assert.deepEqual(full.sessionIntact.generation, 1)
  assert.deepEqual(progressive.sessionIntact.generation, 1)
  assert.equal(full.sessionIntact.sameObject, true)
  assert.equal(progressive.sessionIntact.sameObject, true)
})

test('terminal owner (session id) and disclosure identity (Agent object) are independent', async () => {
  const registry = makeRegistry()
  const ownerId = 'owner-shared'
  const { record } = attachControlledSession(registry, { id: 'st-shared', owner: ownerId })
  const agentA = { id: ownerId }
  const agentSameId = { id: ownerId }
  const agentOther = { id: 'owner-other' }
  const harness = makeHarness({ mode: 'progressive', registry })

  // A expands; its step sees the session tools.
  const aStep = await expandSession(harness, agentA)
  assert.equal(aStep.has('aiterm_list'), true)
  assert.equal(aStep.has('aiterm_history'), false)

  // A second Agent object with the SAME id shares the terminal owner but has
  // its own disclosure state: no session tool is admitted before it expands.
  const sameIdFirst = await prepare(harness, agentSameId)
  assert.deepEqual(sameIdFirst.names, [DISCOVER])
  await assert.rejects(sameIdFirst.call('aiterm_list'), /UNKNOWN_TOOL/)

  const sameIdStep = await expandSession(harness, agentSameId)
  const aList = await aStep.call('aiterm_list')
  const sameIdList = await sameIdStep.call('aiterm_list')
  assert.deepEqual(aList.sessions.map((session) => session.id), [record.id])
  assert.deepEqual(sameIdList.sessions.map((session) => session.id), [record.id])
  assert.equal(aList.sessions[0].permission.aiAccess, 'rw')

  // Expanding different groups is independent per Agent object.
  const openedHistory = await aStep.call(DISCOVER, { group: 'history' })
  assert.equal(openedHistory.ok, true)
  const sameIdAfter = await prepare(harness, agentSameId)
  assert.equal(sameIdAfter.has('aiterm_history'), false)
  assert.equal(sameIdAfter.has('aiterm_list'), true)

  // A different owner id is denied exactly like a missing session; expansion
  // does not grant cross-owner access.
  const otherStep = await expandSession(harness, agentOther)
  const otherList = await otherStep.call('aiterm_list')
  assert.deepEqual(otherList.sessions, [])
  await rejectWithCode(() => otherStep.call('aiterm_status', { sessionId: record.id }), 'SESSION_NOT_FOUND')
  await rejectWithCode(() => otherStep.call('aiterm_read', { sessionId: record.id, mode: 'delta' }), 'SESSION_NOT_FOUND')

  // Disposal of one Agent forgets only its expansion state; the terminal and
  // the other Agent (same id) are untouched.
  harness.emit('agent/disposed', { agent: agentA })
  assert.deepEqual((await prepare(harness, agentA)).names, [DISCOVER])
  assert.equal((await prepare(harness, agentSameId)).has('aiterm_list'), true)
  assert.equal(registry.sessions.get(record.id), record)
  assert.equal(record.state, 'open')
  assert.equal(record.generation, 1)
  await registry.dispose()
})

test('discovery does not interrupt a running tool call and never restarts the registry', async () => {
  const registry = makeRegistry({ aiAutoLock: false })
  const ownerId = 'owner-wait'
  const { record } = attachControlledSession(registry, { id: 'st-wait', owner: ownerId })
  const agent = { id: ownerId }
  const other = { id: 'owner-other' }
  const harness = makeHarness({ mode: 'progressive', registry })
  const step = await expandSession(harness, agent)
  const otherStep = await expandSession(harness, other)

  const sessionsBefore = new Map(registry.sessions)
  const auditBefore = record.audit.length
  const waiting = step.call('aiterm_wait', {
    sessionId: record.id,
    until: 'pattern',
    pattern: 'READY',
    timeoutMs: 4000,
  })
  // Let the wait register its waiter before discovery and output run.
  await Promise.resolve()

  // Discovery from the same Agent and from another Agent runs concurrently
  // with the pending wait; expansion changes the next step only.
  const inspector = await step.call(DISCOVER)
  assert.equal(inspector.ok, true)
  const expanded = await step.call(DISCOVER, { group: 'history' })
  assert.equal(expanded.ok, true)
  const otherInspector = await otherStep.call(DISCOVER)
  assert.equal(otherInspector.ok, true)

  // The registry did not restart, close or replace the session for discovery.
  assert.deepEqual([...registry.sessions], [...sessionsBefore])
  assert.equal(registry.sessions.get(record.id), record)
  assert.equal(record.state, 'open')
  assert.equal(record.generation, 1)
  assert.equal(record.audit.length, auditBefore)
  assert.equal((await prepare(harness, agent)).has('aiterm_history'), true)

  // Output still reaches the pending call and satisfies it.
  registry.handleData(record, 'booting\nREADY\n')
  const result = await waiting
  assert.equal(result.matched, true)
  assert.equal(result.reason, 'pattern')
  assert.match(result.text, /READY/)
  assert.equal(result.session.id, record.id)
  assert.equal(record.state, 'open')
  assert.equal(registry.sessions.get(record.id), record)
  await registry.dispose()
})

test('ownerScopedRegistry keeps the permission gates for every real registry entry point', async () => {
  const registry = makeRegistry()
  const owner = 'owner-scoped'
  const { record, writes } = attachControlledSession(registry, { id: 'st-scoped', owner, aiAccess: 'ro' })
  const scoped = ownerScopedRegistry(registry, owner)
  const foreign = ownerScopedRegistry(registry, 'owner-foreign')

  await rejectWithCode(() => scoped.write(record.id, 'id\n', 'ai'), 'AI_WRITE_DENIED')
  assert.equal(writes.length, 0)
  await rejectWithCode(() => foreign.write(record.id, 'id\n', 'ai'), 'SESSION_NOT_FOUND')
  await rejectWithCode(() => foreign.read(record.id, { actor: 'ai' }), 'SESSION_NOT_FOUND')

  // Writing as the human is still allowed in read-only mode, and a successful
  // AI write is impossible until the human changes the mode.
  await scoped.write(record.id, 'id\n', 'human')
  assert.equal(writes.at(-1), 'id\n')
  scoped.setAiAccess(record.id, 'rw', 'human')
  await scoped.write(record.id, 'id\n', 'ai')
  assert.equal(writes.at(-1), 'id\n')
  assert.equal(scoped.info(scoped.get(record.id)).permission.lockOwner, 'ai')
  const released = scoped.relinquish(record.id, 'ai')
  assert.equal(released.released, true)
  await registry.dispose()
})

/**
 * Resolve the real DSH runtime when the installation is available.
 *
 * Only the shipped modules are imported; nothing is installed, reloaded or
 * written, and the live profile is never touched.
 * @returns {Promise<any | null>} runtime or null.
 */
async function loadRealRuntime() {
  const loaders = []
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install.length > 0) {
    loaders.push(async () => {
      const require = createRequire(join(install, 'package.json'))
      return async (specifier) => import(pathToFileURL(require.resolve(specifier)).href)
    })
  }
  loaders.push(async () => (specifier) => import(specifier))
  for (const makeLoader of loaders) {
    try {
      const load = await makeLoader()
      const cordis = await load('@deepseek-ai/cordis')
      const tools = await load('@deepseek-ai/dsh-tools')
      const scope = await load('@deepseek-ai/dsh-scope')
      return { Context: cordis.Context, ToolsService: tools.ToolsService, createScope: scope.createScope }
    } catch {
      // Try the next candidate; the characterization skips when none resolve.
    }
  }
  return null
}

const realRuntime = await loadRealRuntime()

test(
  'characterization: a real Agent-scoped restriction is enforced before disclosure',
  { skip: realRuntime === null ? 'the installed DSH tools runtime is not resolvable from this checkout' : false },
  async () => {
    const { Context, ToolsService, createScope } = realRuntime
    const registry = makeRegistry()
    const ownerId = 'owner-real-runtime'
    attachControlledSession(registry, { id: 'st-real', owner: ownerId })
    const root = new Context()
    root.provide('systemPrompt')
    root.set('systemPrompt', { tools() {} })
    new ToolsService(root)
    registerTools(root, { config: { toolDisclosure: 'progressive' }, registry })
    const agent = { id: ownerId }
    const scope = createScope(root, agent)
    try {
      scope.ctx.tools.restrict({ deny: ['aiterm_send'] })
      const first = await root.tools.resolve({ agent, modelSelection: MODEL_SELECTION, signal: new AbortController().signal })
      const discovered = first.view(agent).get(DISCOVER)
      await discovered.execute({ group: 'session' }, { agent })
      const second = await root.tools.resolve({ agent, modelSelection: MODEL_SELECTION, signal: new AbortController().signal })
      // The restriction wins: the disclosure condition would allow it, but the
      // real effective view still removes the tool before `when` is consulted.
      assert.equal(second.view(agent).has('aiterm_send'), false)
      assert.equal(second.view(agent).has('aiterm_list'), true)
      assert.equal(root.tools.get('aiterm_send', agent), undefined)
      // The unrestricted registry still offers it, so the real gate is the
      // scope restriction, not the disclosure catalogue.
      assert.equal(root.tools.get('aiterm_send')?.name, 'aiterm_send')
    } finally {
      await scope.dispose()
      await registry.dispose()
    }
  },
)
