/**
 * Task 1 — per-Agent progressive disclosure state and grouping.
 *
 * These tests derive every expectation by hand from the task brief:
 * the 21 registered `aiterm_*` tools, their four groups, and the rule that a
 * group expansion is owned by one live Agent object and is only ever exposed
 * through the effective `tools.get(name, agent)` view.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/host/config.js'
import { createDisclosure } from '../lib/host/disclosure.js'

/** The 21 tools that exist in `lib/host/tools.js`, grouped by the brief. */
const GROUPS = {
  session: [
    'aiterm_list',
    'aiterm_status',
    'aiterm_read',
    'aiterm_screen',
    'aiterm_screenshot',
    'aiterm_wait',
    'aiterm_send',
    'aiterm_release_control',
  ],
  history: ['aiterm_history', 'aiterm_audit', 'aiterm_export'],
  automation: ['aiterm_batch', 'aiterm_script_list', 'aiterm_script_save', 'aiterm_script_run'],
  management: ['aiterm_connect', 'aiterm_disconnect', 'aiterm_reconnect', 'aiterm_resize', 'aiterm_close', 'aiterm_autolog'],
}

const GROUP_ORDER = ['session', 'history', 'automation', 'management']
const ALL_TOOLS = GROUP_ORDER.flatMap((group) => GROUPS[group])

/** Distinct Agent doubles: object identity is the disclosure identity. */
const agentA = { id: 'agent-a' }
const agentB = { id: 'agent-b' }
const agentAChild = { id: 'agent-a-child', session: { header: { origin: 'subagent', parentSession: 'agent-a' } } }
const agentAReplacement = { id: 'agent-a' }

/**
 * A boundary double for the DSH `tools` service.
 *
 * It mirrors the real contract used by disclosure:
 * - `get(name)` is the global view;
 * - `get(name, agent)` is that Agent's effective view, which returns the same
 *   global definition unless a restriction hides it (`undefined`) or a
 *   scope-local registration shadows it (a different object).
 * @param {{ hidden?: Map<object, Set<string>>, impostors?: Map<object, Set<string>>, throwForAgent?: boolean }} [options] scenario.
 * @returns {{ get(name: string, agent?: object): object | undefined }} fake service.
 */
function makeTools({ hidden = new Map(), impostors = new Map(), throwForAgent = false } = {}) {
  const definitions = new Map(ALL_TOOLS.map((name) => [name, Object.freeze({ name })]))
  return {
    get(name, agent) {
      if (agent === undefined) return definitions.get(name)
      if (throwForAgent) throw new Error('tool view unavailable')
      if (hidden.get(agent)?.has(name) === true) return undefined
      if (impostors.get(agent)?.has(name) === true) return { name, execute: 'scope-local impostor' }
      return definitions.get(name)
    },
  }
}

/**
 * @param {string} mode disclosure mode.
 * @param {...any} tools explicit tools service double (omitted = complete fake).
 * @returns {ReturnType<typeof createDisclosure>} controller.
 */
function disclose(mode, ...tools) {
  return createDisclosure({ mode, tools: tools.length === 0 ? makeTools() : tools[0] })
}

/** @param {object} result discover/expand result. @returns {Record<string, string[]>} group -> tools. */
function groupMap(result) {
  return Object.fromEntries(result.groups.map(({ group, tools }) => [group, tools]))
}

test('configuration defaults to full disclosure and rejects unknown values', () => {
  assert.equal(DEFAULT_CONFIG.toolDisclosure, 'full')
  assert.equal(resolveConfig({}).toolDisclosure, 'full')
  assert.equal(resolveConfig({ toolDisclosure: 'progressive' }).toolDisclosure, 'progressive')
  for (const invalid of ['FULL', 'Progressive', 'progressive ', 'on', '', null, 0, 1, {}, ['progressive']]) {
    assert.equal(resolveConfig({ toolDisclosure: invalid }).toolDisclosure, 'full', `invalid value ${String(invalid)}`)
  }
})

test('missing or invalid mode falls back to full disclosure for every Agent', () => {
  for (const mode of [undefined, 'FULL', 'progressive ', null, 1, {}]) {
    const disclosure = disclose(mode)
    const found = disclosure.discover(agentA)
    assert.equal(found.mode, 'full', `mode ${String(mode)}`)
    assert.deepEqual(found.expanded, GROUP_ORDER)
    assert.deepEqual(found.visible, ALL_TOOLS)
    for (const name of ALL_TOOLS) {
      assert.equal(disclosure.isVisible(agentA, name), true, name)
      assert.equal(disclosure.isVisible(undefined, name), true, `full mode is unconditional: ${name}`)
    }
    assert.equal(disclosure.isVisible(agentA, 'aiterm_discover'), false)
    disclosure.dispose()
  }
})

test('the 21 tools each belong to exactly one group and no other names are advertised', () => {
  const disclosure = disclose('progressive')
  const found = disclosure.discover(agentA)
  assert.equal(found.ok, true)
  assert.equal(found.mode, 'progressive')
  assert.deepEqual(
    found.groups.map(({ group }) => group),
    GROUP_ORDER,
  )
  assert.deepEqual(groupMap(found), GROUPS)

  const seen = new Map()
  for (const { group, tools } of found.groups) {
    assert.equal(new Set(tools).size, tools.length, `no duplicate in ${group}`)
    for (const name of tools) {
      assert.equal(seen.has(name), false, `${name} appears in ${seen.get(name)} and ${group}`)
      seen.set(name, group)
    }
  }
  assert.equal(seen.size, 21)
  assert.deepEqual([...seen.keys()].sort(), [...ALL_TOOLS].sort())
  assert.equal(seen.has('aiterm_discover'), false)

  for (const [group, expected] of Object.entries(GROUPS)) {
    const fresh = disclose('progressive')
    const expanded = fresh.expand(agentA, group)
    assert.equal(expanded.ok, true, group)
    assert.deepEqual(expanded.expanded, [group])
    assert.deepEqual(expanded.visible, expected, `${group} exposes exactly its members`)
    for (const name of ALL_TOOLS) {
      assert.equal(fresh.isVisible(agentA, name), expected.includes(name), `${group}: ${name}`)
    }
  }
})

test('expansion is owned by the Agent object: B, children, and same-id replacements stay collapsed', () => {
  const disclosure = disclose('progressive')
  const opened = disclosure.expand(agentA, 'session')
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.expanded, ['session'])
  assert.deepEqual(opened.visible, GROUPS.session)

  for (const other of [agentB, agentAChild, agentAReplacement]) {
    assert.deepEqual(disclosure.discover(other).expanded, [])
    for (const name of GROUPS.session) {
      assert.equal(disclosure.isVisible(other, name), false, `${other.id}:${name}`)
    }
  }
  for (const group of ['history', 'automation', 'management']) {
    for (const name of GROUPS[group]) assert.equal(disclosure.isVisible(agentA, name), false, name)
  }

  const openedB = disclosure.expand(agentB, 'history')
  assert.deepEqual(openedB.expanded, ['history'])
  assert.deepEqual(disclosure.discover(agentA).expanded, ['session'])
  assert.deepEqual(disclosure.discover(agentB).expanded, ['history'])
  assert.deepEqual(disclosure.discover(agentAChild).expanded, [])
})

test('repeated and interleaved expansion is idempotent and order-stable', () => {
  const disclosure = disclose('progressive')
  disclosure.expand(agentA, 'session')
  const twice = disclosure.expand(agentA, 'session')
  assert.deepEqual(twice.expanded, ['session'])
  assert.deepEqual(twice.visible, GROUPS.session)

  disclosure.expand(agentA, 'history')
  disclosure.expand(agentA, 'session')
  disclosure.expand(agentA, 'history')
  for (let index = 0; index < 50; index += 1) disclosure.expand(agentA, 'automation')
  assert.deepEqual(disclosure.discover(agentA).expanded, ['session', 'history', 'automation'])

  disclosure.expand(agentB, 'management')
  disclosure.expand(agentB, 'management')
  assert.deepEqual(disclosure.discover(agentB).expanded, ['management'])
  assert.deepEqual(disclosure.discover(agentA).expanded, ['session', 'history', 'automation'])
  assert.equal(disclosure.isVisible(agentB, 'aiterm_history'), false)
  assert.equal(disclosure.isVisible(agentB, 'aiterm_close'), true)
})

test('missing Agent identity and unknown groups are refused without changing state', () => {
  const disclosure = disclose('progressive')
  for (const invalidAgent of [undefined, null, 'agent-a', 42, true]) {
    const expanded = disclosure.expand(invalidAgent, 'session')
    assert.equal(expanded.ok, false, String(invalidAgent))
    assert.equal(expanded.error, 'missing-agent')
    assert.deepEqual(expanded.expanded, [])
    assert.deepEqual(expanded.visible, [])
    assert.equal(disclosure.isVisible(invalidAgent, 'aiterm_list'), false)

    const found = disclosure.discover(invalidAgent)
    assert.equal(found.ok, false)
    assert.equal(found.error, 'missing-agent')
    assert.deepEqual(found.groups, [])
    assert.deepEqual(found.visible, [])
  }
  for (const invalidGroup of ['SESSION', 'list', 'aiterm_list', '', null, 42]) {
    const expanded = disclosure.expand(agentA, invalidGroup)
    assert.equal(expanded.ok, false, String(invalidGroup))
    assert.equal(expanded.error, 'unknown-group')
    assert.deepEqual(expanded.expanded, [])
  }
  assert.deepEqual(disclosure.discover(agentA).expanded, [])
})

test('forget collapses that Agent only, and a later expansion starts clean', () => {
  const disclosure = disclose('progressive')
  disclosure.expand(agentA, 'session')
  disclosure.expand(agentB, 'history')
  assert.equal(disclosure.isVisible(agentA, 'aiterm_list'), true)

  disclosure.forget(agentA)
  assert.equal(disclosure.isVisible(agentA, 'aiterm_list'), false)
  assert.deepEqual(disclosure.discover(agentA).expanded, [])
  assert.deepEqual(disclosure.discover(agentB).expanded, ['history'])

  const again = disclosure.expand(agentA, 'session')
  assert.equal(again.ok, true)
  assert.equal(disclosure.isVisible(agentA, 'aiterm_list'), true)

  disclosure.forget(agentB)
  assert.deepEqual(disclosure.discover(agentB).expanded, [])
  disclosure.forget(undefined)
  disclosure.forget(null)
  disclosure.forget('agent-a')
})

test('names hidden by the effective Agent tool view are never advertised', () => {
  const hidden = new Map([[agentA, new Set(['aiterm_read', 'aiterm_history', 'aiterm_batch'])]])
  const disclosure = disclose('progressive', makeTools({ hidden }))

  const found = disclosure.discover(agentA)
  assert.equal(found.ok, true)
  assert.deepEqual(found.groups.find(({ group }) => group === 'session').tools, [
    'aiterm_list',
    'aiterm_status',
    'aiterm_screen',
    'aiterm_screenshot',
    'aiterm_wait',
    'aiterm_send',
    'aiterm_release_control',
  ])
  assert.deepEqual(found.groups.find(({ group }) => group === 'history').tools, ['aiterm_audit', 'aiterm_export'])
  assert.deepEqual(found.groups.find(({ group }) => group === 'automation').tools, [
    'aiterm_script_list',
    'aiterm_script_save',
    'aiterm_script_run',
  ])
  assert.equal(found.visible.includes('aiterm_read'), false)
  assert.equal(found.visible.includes('aiterm_history'), false)
  assert.equal(found.visible.includes('aiterm_batch'), false)

  const expanded = disclosure.expand(agentA, 'session')
  assert.deepEqual(expanded.visible, found.groups.find(({ group }) => group === 'session').tools)
  assert.equal(expanded.visible.includes('aiterm_read'), false)

  assert.deepEqual(groupMap(disclosure.discover(agentB)), GROUPS)
})

test('scope-local impostors shadowing an aiterm name are not advertised', () => {
  const impostors = new Map([[agentA, new Set(['aiterm_list', 'aiterm_send'])]])
  const disclosure = disclose('progressive', makeTools({ impostors }))

  const found = disclosure.discover(agentA)
  assert.deepEqual(found.groups.find(({ group }) => group === 'session').tools, [
    'aiterm_status',
    'aiterm_read',
    'aiterm_screen',
    'aiterm_screenshot',
    'aiterm_wait',
    'aiterm_release_control',
  ])
  assert.equal(found.visible.includes('aiterm_list'), false)
  assert.equal(found.visible.includes('aiterm_send'), false)

  const expanded = disclosure.expand(agentA, 'session')
  assert.equal(expanded.visible.includes('aiterm_list'), false)
  assert.equal(expanded.visible.includes('aiterm_send'), false)

  assert.deepEqual(groupMap(disclosure.discover(agentB)), GROUPS)
})

test('a missing or throwing tools.get fails closed with no advertised names', () => {
  const alwaysThrows = {
    get() {
      throw new Error('tool view unavailable')
    },
  }
  const throwsForAgent = {
    get(name, agent) {
      if (agent !== undefined) throw new Error('tool view unavailable')
      return { name }
    },
  }
  for (const tools of [undefined, {}, { get: undefined }, { get: null }, alwaysThrows, throwsForAgent]) {
    const disclosure = disclose('progressive', tools)
    const found = disclosure.discover(agentA)
    assert.equal(found.ok, true, String(tools))
    assert.equal(found.catalogUnavailable, true, String(tools))
    for (const { tools: names } of found.groups) assert.deepEqual(names, [])
    assert.deepEqual(found.visible, [])

    const expanded = disclosure.expand(agentA, 'session')
    assert.equal(expanded.ok, true)
    assert.equal(expanded.catalogUnavailable, true)
    for (const { tools: names } of expanded.groups) assert.deepEqual(names, [])
    assert.deepEqual(expanded.visible, [])
  }
})

test('discovery records cross-group prerequisites and permission hints', () => {
  const disclosure = disclose('progressive')
  const found = disclosure.discover(agentA)

  assert.deepEqual(
    Object.fromEntries(found.dependencies.map(({ group, requires }) => [group, requires])),
    { session: [], history: ['session'], automation: ['session'], management: ['session'] },
  )
  for (const { group, requires, hint } of found.dependencies) {
    assert.equal(typeof hint, 'string')
    assert.ok(hint.length > 0, group)
    if (requires.length > 0) assert.match(hint, /session/i, group)
  }
  assert.equal(typeof found.nextStep, 'string')
  assert.match(found.nextStep, /next model step/i)
  assert.ok(Array.isArray(found.hints))
  const hints = [...found.hints, ...found.dependencies.map(({ hint }) => hint)].join('\n')
  assert.match(hints, /permission/i)
  assert.match(hints, /read-only|write-only|control/i)
})

test('dispose clears every Agent and stops disclosure', () => {
  const disclosure = disclose('progressive')
  disclosure.expand(agentA, 'session')

  disclosure.dispose()
  assert.equal(disclosure.isVisible(agentA, 'aiterm_list'), false)
  assert.equal(disclosure.isVisible(agentB, 'aiterm_list'), false)

  const expanded = disclosure.expand(agentA, 'session')
  assert.equal(expanded.ok, false)
  assert.equal(expanded.error, 'disposed')
  assert.deepEqual(expanded.expanded, [])

  const found = disclosure.discover(agentA)
  assert.equal(found.ok, false)
  assert.equal(found.error, 'disposed')
  assert.deepEqual(found.groups, [])

  disclosure.dispose()
  disclosure.forget(agentA)
})
