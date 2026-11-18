/**
 * Task 2 — original registrations plus the discovery entry.
 *
 * Most tests drive `registerTools` / `registerPrompt` with a small isolated
 * boundary double for the Cordis context and the DSH `tools` service. The
 * double mirrors the runtime semantics this task depends on:
 *
 * - registrations are global and ordered;
 * - another Agent's restriction is applied to the effective view *before*
 *   `when` is evaluated, so a disclosure condition can never widen one;
 * - every conditional registration is resolved into one immutable per-step
 *   snapshot, so a tool expanded after preparation is only callable next step.
 *
 * A final test uses the real `@deepseek-ai/dsh-tools` runtime when the
 * installation is resolvable (read-only import, no install mutation), because
 * the double is deliberately not the shipped implementation.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { DISCLOSURE_GROUPS } from '../lib/host/disclosure.js'
import { PROGRESSIVE_PROMPT_TEXT, PROMPT_TEXT, registerPrompt } from '../lib/host/prompt.js'
import { registerTools } from '../lib/host/tools.js'

const DISCOVER = 'aiterm_discover'
const GROUP_ORDER = Object.keys(DISCLOSURE_GROUPS)
const ORIGINAL_TOOLS = GROUP_ORDER.flatMap((group) => DISCLOSURE_GROUPS[group])

const agentA = { id: 'agent-a' }
const agentB = { id: 'agent-b' }
const unknownAgent = { id: 'agent-unknown' }
const modelSelection = Object.freeze({ provider: 'test-provider', model: 'test-model' })

/**
 * Isolated Cordis/tools boundary double.
 *
 * `restrictions` maps an Agent to tool names that another (independent)
 * restriction hides from it; `get(name, agent)` returns `undefined` for those,
 * exactly like the real scope-local restriction. `get(name)` is the global
 * view used for definition-identity comparison by the disclosure controller.
 *
 * @param {{ mode?: string, restrictions?: Map<object, Set<string>> }} [options]
 * @returns {any} harness with the fake context, plugin state and captured data.
 */
function makeHarness({ mode = 'progressive', restrictions = new Map() } = {}) {
  /** @type {Array<{ definition: any, options: Record<string, any>, dispose: () => void }>} */
  const registrations = []
  const byName = new Map()
  const listeners = new Map()
  const effects = []

  const tools = {
    register(definition, options = {}) {
      const entry = { definition, options, dispose: () => {} }
      entry.dispose = () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
        if (byName.get(definition.name) === definition) byName.delete(definition.name)
      }
      registrations.push(entry)
      byName.set(definition.name, definition)
      return entry.dispose
    },
    get(name, agent) {
      const definition = byName.get(name)
      if (definition === undefined) return undefined
      if (agent === undefined) return definition
      if (restrictions.get(agent)?.has(name) === true) return undefined
      return definition
    },
  }

  const ctx = {
    tools,
    logger: { info() {}, warn() {}, error() {} },
    effect(run, label) {
      const cleanup = run()
      effects.push({ label, cleanup })
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    on(event, listener) {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return () => {
        const index = entries.indexOf(listener)
        if (index >= 0) entries.splice(index, 1)
      }
    },
  }

  return {
    ctx,
    tools,
    registrations,
    effects,
    listeners,
    restrictions,
    plugin: { config: { toolDisclosure: mode }, logger: ctx.logger },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    disposeEffect(label) {
      const record = effects.find((entry) => entry.label === label)
      assert.ok(record, `no effect labelled ${label}`)
      return record.cleanup
    },
  }
}

/**
 * Simulate the real per-step resolution (`ToolsService#resolve`): restrictions
 * first, then every `when`, producing one immutable admitted set.
 * @param {any} harness harness from {@link makeHarness}.
 * @param {object} agent preparing Agent.
 * @returns {Promise<{ names: string[], has(name: string): boolean, call(name: string, args?: object): Promise<any> }>} step snapshot.
 */
async function prepare(harness, agent) {
  const admitted = new Map()
  const signal = new AbortController().signal
  for (const { definition, options } of harness.registrations) {
    if (harness.restrictions.get(agent)?.has(definition.name) === true) continue
    if (options.when !== undefined) {
      const enabled = await options.when({ agent, modelSelection, signal })
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
      return definition.execute(args, { agent, modelSelection, signal })
    },
  }
}

/** @param {any} harness harness. @param {string} name tool name. @returns {any} registration entry. */
function registration(harness, name) {
  const entry = harness.registrations.find(({ definition }) => definition.name === name)
  assert.ok(entry, `tool ${name} was not registered`)
  return entry
}

test('full mode keeps 21 unconditional registrations and registers no discovery entry', async () => {
  const harness = makeHarness({ mode: 'full' })
  registerTools(harness.ctx, harness.plugin)

  assert.equal(harness.registrations.length, 21)
  assert.deepEqual(
    harness.registrations.map(({ definition }) => definition.name).sort(),
    [...ORIGINAL_TOOLS].sort(),
  )
  for (const { definition, options } of harness.registrations) {
    assert.equal(Object.hasOwn(options, 'when'), false, `${definition.name} must stay unconditional`)
  }
  assert.equal(harness.tools.get(DISCOVER), undefined)

  const step = await prepare(harness, agentA)
  assert.deepEqual(step.names.sort(), [...ORIGINAL_TOOLS].sort())
  // No condition means a direct (non-step) dispatch is still possible, which is
  // the historical behaviour that must not regress.
  for (const { options } of harness.registrations) assert.equal(options.when, undefined)
})

test('progressive mode registers a resident discovery entry and conditionals for the original tools', async () => {
  const harness = makeHarness({ mode: 'progressive' })
  registerTools(harness.ctx, harness.plugin)

  assert.equal(harness.registrations.length, 22)
  const discovery = harness.registrations.filter(({ definition }) => definition.name === DISCOVER)
  assert.equal(discovery.length, 1)
  // The entry is never part of a business group and is registered without a
  // condition, so it stays resident from the first step.
  assert.equal(ORIGINAL_TOOLS.includes(DISCOVER), false)
  assert.equal(Object.hasOwn(discovery[0].options, 'when'), false)
  assert.equal(typeof discovery[0].definition.parameters, 'object')
  assert.equal(typeof discovery[0].definition.output.render, 'function')

  const original = harness.registrations.filter(({ definition }) => definition.name !== DISCOVER)
  assert.equal(original.length, 21)
  for (const { definition, options } of original) {
    assert.equal(typeof options.when, 'function', `${definition.name} needs a step condition`)
  }

  const first = await prepare(harness, agentA)
  assert.deepEqual(first.names, [DISCOVER])
})

test('an expansion is per-Agent and only the next step snapshot sees the tools', async () => {
  const harness = makeHarness({ mode: 'progressive' })
  registerTools(harness.ctx, harness.plugin)

  const first = await prepare(harness, agentA)
  const summary = await first.call(DISCOVER)
  assert.equal(summary.ok, true)
  assert.equal(summary.mode, 'progressive')
  assert.deepEqual(summary.expanded, [])
  assert.deepEqual(summary.groups.map(({ group }) => group), GROUP_ORDER)
  assert.equal(typeof summary.nextStep, 'string')

  const opened = await first.call(DISCOVER, { group: 'session' })
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.expanded, ['session'])
  assert.deepEqual(opened.visible, DISCLOSURE_GROUPS.session)

  // Same step: the prepared admission set is immutable, so a tool expanded a
  // moment ago is still not callable there.
  assert.equal(first.has('aiterm_list'), false)
  await assert.rejects(first.call('aiterm_list'), /UNKNOWN_TOOL/)

  // Next step: exactly the selected group (plus the resident discovery entry).
  const second = await prepare(harness, agentA)
  assert.deepEqual(second.names.sort(), [DISCOVER, ...DISCLOSURE_GROUPS.session].sort())
  for (const name of [...DISCLOSURE_GROUPS.history, ...DISCLOSURE_GROUPS.automation, ...DISCLOSURE_GROUPS.management]) {
    assert.equal(second.has(name), false, name)
  }
  assert.equal(second.has('aiterm_list'), true)

  // The step-time condition answers for the preparing Agent only.
  const listWhen = registration(harness, 'aiterm_list').options.when
  const signal = new AbortController().signal
  const context = (agent) => ({ agent, modelSelection, signal })
  assert.equal(await listWhen(context(agentA)), true)
  assert.equal(await listWhen(context(agentB)), false)
  assert.equal(await listWhen(context(unknownAgent)), false)
  assert.equal(await listWhen(context(undefined)), false)
  assert.equal(await listWhen({}), false)
  assert.equal(await listWhen(null), false)

  // B expands history independently; A's session expansion is unaffected.
  const bFirst = await prepare(harness, agentB)
  assert.deepEqual(bFirst.names, [DISCOVER])
  const bOpened = await bFirst.call(DISCOVER, { group: 'history' })
  assert.equal(bOpened.ok, true)
  const bSecond = await prepare(harness, agentB)
  assert.deepEqual(bSecond.names.sort(), [DISCOVER, ...DISCLOSURE_GROUPS.history].sort())
  assert.equal(bSecond.has('aiterm_history'), true)
  assert.equal(bSecond.has('aiterm_list'), false)

  const aAgain = await prepare(harness, agentA)
  assert.deepEqual(aAgain.names.sort(), [DISCOVER, ...DISCLOSURE_GROUPS.session].sort())

  // Repeated expansion is idempotent.
  const again = await aAgain.call(DISCOVER, { group: 'session' })
  assert.deepEqual(again.expanded, ['session'])
})

test('the step-time condition fails closed for hostile Agent identities instead of throwing', async () => {
  const harness = makeHarness({ mode: 'progressive' })
  registerTools(harness.ctx, harness.plugin)

  const when = registration(harness, 'aiterm_list').options.when
  const throwingId = Object.defineProperties({}, {
    id: {
      get() {
        throw new Error('agent.id exploded')
      },
    },
  })
  const throwingProxy = new Proxy({}, {
    get() {
      throw new Error('agent proxy exploded')
    },
  })
  const throwingContextAgent = {
    get agent() {
      throw new Error('context.agent exploded')
    },
  }

  for (const [label, agent] of [
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['empty id', { id: '' }],
    ['blank id', { id: '   ' }],
    ['non-string id', { id: 42 }],
    ['throwing id getter', throwingId],
    ['throwing proxy', throwingProxy],
    ['function', function agent() {}],
  ]) {
    let result
    assert.doesNotThrow(() => {
      result = when({ agent, modelSelection, signal: new AbortController().signal })
    }, label)
    assert.equal(result, false, label)
  }
  assert.equal(when(undefined), false)
  assert.equal(when(null), false)
  assert.equal(when({}), false)
  assert.equal(when(throwingContextAgent), false)
})

test('expanding a group never widens another independent restriction', async () => {
  const restrictions = new Map([[agentA, new Set(['aiterm_send', 'aiterm_close'])]])
  const harness = makeHarness({ mode: 'progressive', restrictions })
  registerTools(harness.ctx, harness.plugin)

  const first = await prepare(harness, agentA)
  const summary = await first.call(DISCOVER)
  assert.equal(summary.ok, true)
  const sessionGroup = summary.groups.find(({ group }) => group === 'session')
  assert.equal(sessionGroup.tools.includes('aiterm_send'), false)
  const managementGroup = summary.groups.find(({ group }) => group === 'management')
  assert.equal(managementGroup.tools.includes('aiterm_close'), false)

  const opened = await first.call(DISCOVER, { group: 'session' })
  assert.equal(opened.ok, true)
  assert.equal(opened.visible.includes('aiterm_send'), false)

  // The disclosure gate itself is about expansion only, and it answers true for
  // the hidden tool; the runtime restriction must still remove it before `when`
  // is consulted, which is what the simulated step proves.
  const sendWhen = registration(harness, 'aiterm_send').options.when
  assert.equal(await sendWhen({ agent: agentA, modelSelection, signal: new AbortController().signal }), true)

  const next = await prepare(harness, agentA)
  assert.equal(next.has('aiterm_list'), true)
  assert.equal(next.has('aiterm_send'), false)
  await assert.rejects(next.call('aiterm_send', { sessionId: 's', data: 'x' }), /UNKNOWN_TOOL/)

  // The same expansion for an unrestricted Agent does make the tool available.
  const bFirst = await prepare(harness, agentB)
  await bFirst.call(DISCOVER, { group: 'session' })
  const bNext = await prepare(harness, agentB)
  assert.equal(bNext.has('aiterm_send'), true)
})

test('agent disposal forgets that Agent and plugin disposal clears the controller', async () => {
  const harness = makeHarness({ mode: 'progressive' })
  registerTools(harness.ctx, harness.plugin)

  assert.equal(harness.listeners.get('agent/disposed')?.length, 1)

  const first = await prepare(harness, agentA)
  await first.call(DISCOVER, { group: 'session' })
  assert.equal((await prepare(harness, agentA)).has('aiterm_list'), true)

  harness.emit('agent/disposed', { agent: agentA })
  const afterDisposal = await prepare(harness, agentA)
  assert.deepEqual(afterDisposal.names, [DISCOVER])
  const forgotten = await afterDisposal.call(DISCOVER)
  assert.deepEqual(forgotten.expanded, [])

  // B was never involved and keeps its own state.
  const bFirst = await prepare(harness, agentB)
  await bFirst.call(DISCOVER, { group: 'history' })
  assert.equal((await prepare(harness, agentB)).has('aiterm_history'), true)

  const dispose = harness.disposeEffect('aiterm: tool disclosure')
  dispose()
  dispose()

  const discoverEntry = registration(harness, DISCOVER)
  const refused = await discoverEntry.definition.execute({ group: 'session' }, { agent: agentB })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'disposed')
  assert.deepEqual(refused.expanded, [])

  const listWhen = registration(harness, 'aiterm_list').options.when
  assert.equal(await listWhen({ agent: agentB, modelSelection, signal: new AbortController().signal }), false)
})

test('the prompt follows the configured mode and progressive text names only the discovery entry', () => {
  /**
   * @param {string} mode disclosure mode.
   * @returns {{ sections: any[] }} captured prompt section.
   */
  function capture(mode) {
    const sections = []
    const ctx = {
      inject(services, callback) {
        assert.deepEqual(services, ['systemPrompt'])
        callback({
          effect(run) {
            run()
          },
          systemPrompt: {
            section(options) {
              sections.push(options)
              return () => {}
            },
            getSectionOrder() {
              return 42
            },
          },
        })
      },
    }
    registerPrompt(ctx, mode)
    assert.equal(sections.length, 1)
    return { sections }
  }

  const full = capture('full')
  assert.equal(full.sections[0].text, PROMPT_TEXT)
  assert.equal(full.sections[0].text.includes(DISCOVER), false)

  const progressive = capture('progressive')
  assert.equal(progressive.sections[0].text, PROGRESSIVE_PROMPT_TEXT)
  assert.match(progressive.sections[0].text, /aiterm_discover/)
  assert.match(progressive.sections[0].text, /next model step/i)
  assert.match(progressive.sections[0].text, /permission/i)
  assert.match(progressive.sections[0].text, /release/i)
  // Only the always-resident entry may be named statically: every other tool
  // name could be hidden from this Agent by another restriction.
  for (const name of ORIGINAL_TOOLS) {
    assert.equal(progressive.sections[0].text.includes(name), false, `prompt leaks ${name}`)
  }

  // Unknown modes fall back to the historical prompt.
  assert.equal(capture(undefined).sections[0].text, PROMPT_TEXT)
  assert.equal(capture('FULL').sections[0].text, PROMPT_TEXT)
})

/**
 * Resolve the real DSH tools runtime when it is installed.
 *
 * This imports the shipped Cordis/ToolsService modules read-only; it never
 * installs, reloads or mutates the running profile. The test is skipped when
 * DSH is not resolvable from this package (for example a plain CI checkout).
 * @returns {Promise<{ Context: any, ToolsService: any, createScope: any, origin: string } | null>} runtime.
 */
async function loadRealRuntime() {
  /** @type {Array<() => Promise<any>>} */
  const loaders = [
    async () => {
      const cordis = await import('@deepseek-ai/cordis')
      const tools = await import('@deepseek-ai/dsh-tools')
      const scope = await import('@deepseek-ai/dsh-scope')
      return {
        Context: cordis.Context,
        ToolsService: tools.ToolsService,
        createScope: scope.createScope,
        validateJsonSchemaValue: tools.validateJsonSchemaValue,
        origin: 'package resolution',
      }
    },
  ]
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install.length > 0) {
    loaders.push(async () => {
      const require = createRequire(join(install, 'package.json'))
      const load = async (specifier) => import(pathToFileURL(require.resolve(specifier)).href)
      const cordis = await load('@deepseek-ai/cordis')
      const tools = await load('@deepseek-ai/dsh-tools')
      const scope = await load('@deepseek-ai/dsh-scope')
      return {
        Context: cordis.Context,
        ToolsService: tools.ToolsService,
        createScope: scope.createScope,
        validateJsonSchemaValue: tools.validateJsonSchemaValue,
        origin: install,
      }
    })
  }
  for (const load of loaders) {
    try {
      return await load()
    } catch {
      // Try the next candidate; the test skips when none resolve.
    }
  }
  return null
}

const realRuntime = await loadRealRuntime()

test(
  'characterization: the real DSH tools runtime enforces the same admission',
  { skip: realRuntime === null ? 'real @deepseek-ai/dsh-tools is not resolvable from this checkout' : false },
  async () => {
    const { Context, ToolsService, createScope, validateJsonSchemaValue } = realRuntime
    const root = new Context()
    root.provide('systemPrompt')
    root.set('systemPrompt', { tools() {} })
    new ToolsService(root)

    registerTools(root, {
      config: { toolDisclosure: 'progressive' },
      logger: root.logger ?? { info() {}, warn() {}, error() {} },
    })

    const signal = new AbortController().signal
    const resolve = (agent) => root.tools.resolve({ agent, modelSelection, signal })
    const keys = (step, agent) => [...step.view(agent).keys()].sort()

    // Registration itself is characterized by the real service: it validated
    // every output schema and accepted every condition.
    const discoverDefinition = root.tools.get(DISCOVER, agentA)
    assert.equal(discoverDefinition?.name, DISCOVER)
    assert.equal(root.tools.get('aiterm_list', agentA)?.name, 'aiterm_list')

    const first = await resolve(agentA)
    assert.deepEqual(keys(first, agentA), [DISCOVER])
    assert.equal(first.view(agentA).get('aiterm_list'), undefined)
    // Conditional tools are unavailable to a direct (non-step) dispatch.
    assert.equal(root.tools.executable('aiterm_list', agentA), undefined)
    assert.equal(root.tools.executable('aiterm_list', agentA, first), undefined)

    const discovered = first.view(agentA).get(DISCOVER)
    const summary = await discovered.execute({}, { agent: agentA })
    assert.equal(summary.ok, true)
    assert.equal(summary.mode, 'progressive')
    assert.deepEqual(summary.expanded, [])
    assert.deepEqual(validateJsonSchemaValue(discovered.output.schema, summary), [])
    const opened = await discovered.execute({ group: 'session' }, { agent: agentA })
    assert.equal(opened.ok, true)
    assert.deepEqual(validateJsonSchemaValue(discovered.output.schema, opened), [])
    const refused = await discovered.execute({ group: 'session' }, { agent: {} })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'missing-agent')
    assert.deepEqual(validateJsonSchemaValue(discovered.output.schema, refused), [])
    // The same snapshot remains immutable after the expansion.
    assert.equal(first.view(agentA).get('aiterm_list'), undefined)

    const second = await resolve(agentA)
    assert.deepEqual(keys(second, agentA), [DISCOVER, ...DISCLOSURE_GROUPS.session].sort())
    assert.equal(root.tools.executable('aiterm_list', agentA, second)?.name, 'aiterm_list')
    assert.equal(second.view(agentA).get('aiterm_history'), undefined)

    const bFirst = await resolve(agentB)
    assert.deepEqual(keys(bFirst, agentB), [DISCOVER])

    // A real agent-scoped restriction is applied to the effective view before
    // the disclosure condition, so expansion cannot widen it and the catalogue
    // cannot advertise the hidden name.
    const scope = createScope(root, agentA)
    try {
      scope.ctx.tools.restrict({ deny: ['aiterm_send'] })
      const restricted = await resolve(agentA)
      assert.equal(restricted.view(agentA).has('aiterm_send'), false)
      const restrictedDiscover = restricted.view(agentA).get(DISCOVER)
      const catalogue = await restrictedDiscover.execute({}, { agent: agentA })
      const sessionGroup = catalogue.groups.find(({ group }) => group === 'session')
      assert.equal(sessionGroup.tools.includes('aiterm_send'), false)
      const expanded = await restrictedDiscover.execute({ group: 'session' }, { agent: agentA })
      assert.equal(expanded.visible.includes('aiterm_send'), false)
    } finally {
      await scope.dispose()
    }

    // The production `agent/disposed` wiring is the real event bus here.
    root.emit('agent/disposed', { agent: agentA })
    const afterDisposal = await resolve(agentA)
    assert.deepEqual(keys(afterDisposal, agentA), [DISCOVER])
    const forgotten = await afterDisposal.view(agentA).get(DISCOVER).execute({}, { agent: agentA })
    assert.deepEqual(forgotten.expanded, [])

    first.dispose()
    second.dispose()
    bFirst.dispose()
    afterDisposal.dispose()
  },
)

/**
 * Mount the plugin's progressive-mode tools on a fresh real DSH ToolsService.
 *
 * Two allow-list scenarios below are characterization tests for production
 * behavior that this change deliberately does not alter: an existing scope
 * restriction is authoritative, including when its allow-list predates
 * `aiterm_discover`. They never install, reload or mutate the live profile.
 * @returns {any} a fresh real Context with the real tools service mounted.
 */
function makeRealProgressiveRoot() {
  const { Context, ToolsService } = realRuntime
  const root = new Context()
  root.provide('systemPrompt')
  root.set('systemPrompt', { tools() {} })
  new ToolsService(root)
  registerTools(root, {
    config: { toolDisclosure: 'progressive' },
    logger: root.logger ?? { info() {}, warn() {}, error() {} },
  })
  return root
}

test(
  'characterization: an allow-list holding the 21 existing tools but not aiterm_discover leaves progressive mode with zero tools',
  { skip: realRuntime === null ? 'real @deepseek-ai/dsh-tools is not resolvable from this checkout' : false },
  async () => {
    const { createScope } = realRuntime
    const root = makeRealProgressiveRoot()
    const agent = { id: 'agent-allowlist-legacy' }
    const scope = createScope(root, agent)
    try {
      // The deployment's pre-existing allow-list: exactly the tool names that
      // existed before progressive disclosure. `aiterm_discover` is a new name,
      // so it is absent from the list.
      scope.ctx.tools.restrict({ allow: ORIGINAL_TOOLS })
      assert.equal(ORIGINAL_TOOLS.includes(DISCOVER), false)

      const step = await root.tools.resolve({ agent, modelSelection, signal: new AbortController().signal })
      // The restriction removes the only always-resident entry...
      assert.equal(root.tools.get(DISCOVER, agent), undefined)
      // ...and every original tool still fails its unexpanded step condition,
      // so this Agent's snapshot is empty. Progressive mode cannot fall back to
      // full mode from inside the restricted Agent: adding the new name to the
      // allow-list is the only migration that does not weaken the restriction.
      const names = [...step.view(agent).keys()]
      assert.deepEqual(names, [])
      assert.equal(step.view(agent).size, 0)
    } finally {
      await scope.dispose()
    }
  },
)

test(
  'characterization: adding aiterm_discover to an allow-list restores progressive mode without widening it',
  { skip: realRuntime === null ? 'real @deepseek-ai/dsh-tools is not resolvable from this checkout' : false },
  async () => {
    const { createScope } = realRuntime
    const root = makeRealProgressiveRoot()
    const agent = { id: 'agent-allowlist-with-discover' }
    const scope = createScope(root, agent)
    try {
      // Same allow-list plus the new resident entry; one session tool and the
      // whole automation group stay outside the list so the test can prove the
      // restriction still wins.
      const blocked = new Set(['aiterm_send', ...DISCLOSURE_GROUPS.automation])
      const allowed = [DISCOVER, ...ORIGINAL_TOOLS.filter((name) => !blocked.has(name))]
      scope.ctx.tools.restrict({ allow: allowed })
      const resolve = () => root.tools.resolve({ agent, modelSelection, signal: new AbortController().signal })

      const first = await resolve()
      assert.deepEqual([...first.view(agent).keys()], [DISCOVER])
      const discover = first.view(agent).get(DISCOVER)

      // Expansion reports only names that this Agent's restriction leaves
      // visible, so the hidden tool never leaks through the catalogue.
      const opened = await discover.execute({ group: 'session' }, { agent })
      assert.equal(opened.ok, true)
      assert.equal(opened.visible.includes('aiterm_send'), false)
      // A group with no allowed member cannot be expanded.
      const automation = await discover.execute({ group: 'automation' }, { agent })
      assert.equal(automation.ok, false)
      assert.equal(automation.error, 'no-visible-tools')

      const second = await resolve()
      assert.deepEqual(
        [...second.view(agent).keys()].sort(),
        [DISCOVER, ...DISCLOSURE_GROUPS.session.filter((name) => name !== 'aiterm_send')].sort(),
      )
      // Including the discovery entry never widens the allow-list: the missing
      // tools are still absent after a group expansion.
      assert.equal(root.tools.get('aiterm_send', agent), undefined)
      assert.equal(root.tools.get('aiterm_batch', agent), undefined)
      assert.equal(second.view(agent).has('aiterm_send'), false)
      assert.equal(second.view(agent).has('aiterm_batch'), false)
    } finally {
      await scope.dispose()
    }
  },
)
