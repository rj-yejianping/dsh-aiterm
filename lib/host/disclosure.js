/**
 * Per-Agent progressive disclosure state and grouping.
 *
 * The {@link createDisclosure} controller owns the "which groups has this Agent
 * expanded" state plus the static grouping of every registered `aiterm_*` tool.
 * It deliberately knows nothing about registration: the tool layer asks
 * {@link Disclosure#isVisible} from the step-time `when` condition (progressive
 * mode only) and exposes {@link Disclosure#discover} / {@link Disclosure#expand}
 * through the always-resident discovery entry.
 *
 * Identity is the live DSH `Agent` object, never a session id: a child, a fork,
 * or a freshly restored session that happens to reuse an id is a different
 * object and therefore starts collapsed. A valid Agent must expose a non-empty
 * string `id` (the installed DSH `Agent` contract); plugin contexts, context-like
 * objects, and bare functions are refused. There is no parent-chain lookup here —
 * the terminal owner rule stays in `registry.js` and is deliberately independent
 * from what an Agent may see.
 *
 * Discovery never grants permission. It only decides which schemas are offered;
 * every existing AI read/write mode, human takeover, and guard still applies at
 * execution time.
 */

/**
 * Group name -> ordered member tool names.
 *
 * Every registered model-facing tool appears in exactly one group, in the order
 * the discovery result should present it.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DISCLOSURE_GROUPS = Object.freeze({
  session: Object.freeze([
    'aiterm_list',
    'aiterm_status',
    'aiterm_read',
    'aiterm_screen',
    'aiterm_screenshot',
    'aiterm_wait',
    'aiterm_send',
    'aiterm_release_control',
  ]),
  history: Object.freeze(['aiterm_history', 'aiterm_audit', 'aiterm_export']),
  automation: Object.freeze(['aiterm_batch', 'aiterm_script_list', 'aiterm_script_save', 'aiterm_script_run']),
  management: Object.freeze([
    'aiterm_connect',
    'aiterm_disconnect',
    'aiterm_reconnect',
    'aiterm_resize',
    'aiterm_close',
    'aiterm_autolog',
  ]),
})

/** Stable presentation order of the groups. */
const GROUP_ORDER = Object.freeze(Object.keys(DISCLOSURE_GROUPS))

/** Tool name -> owning group. */
const GROUP_BY_TOOL = new Map()
for (const group of GROUP_ORDER) {
  for (const name of DISCLOSURE_GROUPS[group]) GROUP_BY_TOOL.set(name, group)
}

/** Every discoverable tool name. */
const ALL_TOOLS = Object.freeze(GROUP_ORDER.flatMap((group) => DISCLOSURE_GROUPS[group]))

/**
 * Cross-group prerequisites, surfaced in the discovery result.
 *
 * They are hints, not access control: a model may still expand any group, but
 * history/automation/management calls need a session id that only the session
 * group can provide. Hints never spell out tool names, because a name hidden
 * from the Agent by another restriction must not leak through prose.
 */
const DEPENDENCIES = Object.freeze([
  Object.freeze({
    group: 'session',
    requires: Object.freeze([]),
    hint: 'Start here: the session group lists sessions and returns the ids every other group needs. AI read-only/write-only modes and human control still refuse calls.',
  }),
  Object.freeze({
    group: 'history',
    requires: Object.freeze(['session']),
    hint: 'Expand session first and list sessions: history, audit, and export need an existing session id.',
  }),
  Object.freeze({
    group: 'automation',
    requires: Object.freeze(['session']),
    hint: 'Expand session first and list sessions: batch and scripts run against existing session ids.',
  }),
  Object.freeze({
    group: 'management',
    requires: Object.freeze(['session']),
    hint: 'Expand session first: disconnect, reconnect, resize, and close need an existing session id; connect creates one and autolog is deployment-wide.',
  }),
])

/** Fixed reminders attached to every discovery result. */
const HINTS = Object.freeze([
  'Expansion reveals tool schemas only; it never grants permission. Existing read-only/write-only AI modes and human control still refuse tool calls.',
  'Expansion applies to the next model step; a tool expanded in this step is not callable until the next step.',
  'List sessions from the session group before history, automation, or management operations that use a session id.',
])

const NEXT_STEP = 'Expansion takes effect on the next model step.'
const FULL_MODE_STEP = 'Full mode: every aiterm tool is registered unconditionally for every Agent.'

/**
 * A live DSH Agent exposes `id` as a branded non-empty string (`SessionId`).
 * A plugin context, a context-like object, an array, or a bare function is not
 * an Agent, even if it is an object.
 * @param {unknown} value candidate Agent.
 * @returns {boolean} whether the value is a live Agent handle.
 */
function isAgent(value) {
  if (value === null || typeof value !== 'object') return false
  const id = value.id
  return typeof id === 'string' && id.trim().length > 0
}

/**
 * @param {unknown} mode configured mode.
 * @returns {'full' | 'progressive'} the effective mode; anything else is full.
 */
function normalizeMode(mode) {
  return mode === 'progressive' ? 'progressive' : 'full'
}

/**
 * @returns {Array<{ group: string, requires: string[], hint: string }>} fresh dependency copies.
 */
function dependencyList() {
  return DEPENDENCIES.map(({ group, requires, hint }) => ({ group, requires: [...requires], hint }))
}

/**
 * @param {'full' | 'progressive'} mode effective mode.
 * @param {string} error machine-readable refusal.
 * @param {string[]} [expanded] expansion state to report truthfully.
 * @param {Record<string, unknown>} [extra] additional fields.
 * @returns {Record<string, any>} a fail-closed result.
 */
function refusal(mode, error, expanded = [], extra = {}) {
  return {
    ok: false,
    error,
    mode,
    groups: [],
    expanded: [...expanded],
    visible: [],
    dependencies: dependencyList(),
    hints: [...HINTS],
    nextStep: mode === 'full' ? FULL_MODE_STEP : NEXT_STEP,
    ...extra,
  }
}

/**
 * @param {Set<string>} expandedGroups expanded group names.
 * @returns {string[]} those names in presentation order.
 */
function orderExpanded(expandedGroups) {
  return GROUP_ORDER.filter((group) => expandedGroups.has(group))
}

/**
 * @param {Array<{ group: string, tools: string[] }>} groups catalogue.
 * @param {string[]} expanded expanded group names.
 * @returns {string[]} effective names currently offered.
 */
function visibleNames(groups, expanded) {
  const byGroup = new Map(groups.map(({ group, tools }) => [group, tools]))
  return expanded.flatMap((group) => byGroup.get(group) ?? [])
}

/**
 * Create the per-Agent disclosure controller.
 *
 * @param {{ mode?: unknown, tools?: { get(name: string, agent?: object): object | undefined } }} options
 *   `mode` is the configured `toolDisclosure` value (`full` unless exactly
 *   `progressive`); `tools` is the DSH tool registry (only `get` is used).
 * @returns {{
 *   isVisible(agent: unknown, name: string): boolean,
 *   discover(agent: unknown): Record<string, any>,
 *   expand(agent: unknown, group: unknown): Record<string, any>,
 *   forget(agent: unknown): void,
 *   dispose(): void,
 * }} controller.
 */
export function createDisclosure({ mode, tools } = {}) {
  const disclosureMode = normalizeMode(mode)
  /** @type {WeakMap<object, Set<string>>} */
  let expandedByAgent = new WeakMap()
  let disposed = false

  /**
   * Resolve the intersection of the static catalogue and the effective Agent view.
   * @param {object} agent valid Agent object.
   * @returns {{ groups: Array<{ group: string, tools: string[] }>, available: boolean }} catalogue.
   */
  function catalogue(agent) {
    const get = tools?.get
    if (typeof get !== 'function') {
      return { groups: GROUP_ORDER.map((group) => ({ group, tools: [] })), available: false }
    }
    /** @type {Set<string> | null} */
    let effective = null
    try {
      const resolved = new Set()
      for (const name of ALL_TOOLS) {
        const scoped = get.call(tools, name, agent)
        if (scoped === undefined || scoped === null) continue
        const global = get.call(tools, name)
        if (global === undefined || global === null) continue
        if (scoped !== global) continue
        resolved.add(name)
      }
      effective = resolved
    } catch {
      // Reading the effective view must never throw into a step-time condition
      // or the discovery tool: treat the whole view as unavailable.
      effective = null
    }
    return {
      groups: GROUP_ORDER.map((group) => ({
        group,
        tools: effective === null ? [] : DISCLOSURE_GROUPS[group].filter((name) => effective.has(name)),
      })),
      available: effective !== null,
    }
  }

  /**
   * @param {object} agent valid Agent object.
   * @returns {string[]} expanded groups (all groups in full mode).
   */
  function expandedGroups(agent) {
    if (disclosureMode === 'full') return [...GROUP_ORDER]
    const groups = expandedByAgent.get(agent)
    return groups === undefined ? [] : orderExpanded(groups)
  }

  /**
   * Shape one successful result from an already verified catalogue.
   * @param {{ groups: Array<{ group: string, tools: string[] }> }} catalogue resolved catalogue.
   * @param {object} agent valid Agent object.
   * @param {Record<string, unknown>} [extra] extra result fields.
   * @returns {Record<string, any>} discover/expand payload.
   */
  function describeFrom({ groups }, agent, extra = {}) {
    const expanded = expandedGroups(agent)
    return {
      ok: true,
      mode: disclosureMode,
      groups,
      expanded,
      visible: visibleNames(groups, expanded),
      dependencies: dependencyList(),
      hints: [...HINTS],
      nextStep: disclosureMode === 'full' ? FULL_MODE_STEP : NEXT_STEP,
      ...extra,
    }
  }

  return {
    /**
     * Whether this tool should be registered as visible for this Agent.
     *
     * Step-time condition: synchronous, side-effect free, and it never throws.
     * It only inspects the Agent's own expansion state; DSH's own restrictions
     * still apply on top, so a true result never widens the effective view.
     * @param {unknown} agent calling Agent.
     * @param {string} name tool name.
     * @returns {boolean} visible for this Agent.
     */
    isVisible(agent, name) {
      if (disposed) return false
      const group = GROUP_BY_TOOL.get(name)
      if (group === undefined) return false
      if (!isAgent(agent)) return false
      if (disclosureMode === 'full') return true
      const groups = expandedByAgent.get(agent)
      return groups !== undefined && groups.has(group)
    },

    /**
     * Describe the discoverable groups and what this Agent has expanded.
     *
     * If the effective Agent view cannot be read, the result is a refusal
     * (`catalog-unavailable`) rather than an empty success, so the discovery
     * entry never claims that nothing is available when it simply could not
     * verify.
     * @param {unknown} agent calling Agent.
     * @returns {Record<string, any>} discovery result.
     */
    discover(agent) {
      if (disposed) return refusal(disclosureMode, 'disposed')
      if (!isAgent(agent)) return refusal(disclosureMode, 'missing-agent')
      const resolved = catalogue(agent)
      if (!resolved.available) return refusal(disclosureMode, 'catalog-unavailable', expandedGroups(agent))
      return describeFrom(resolved, agent)
    },

    /**
     * Expand one group for this Agent. Repeated calls are idempotent.
     *
     * The catalogue is verified before any state changes: an unreadable view
     * or a group whose members are all hidden from this Agent is refused and
     * leaves the Agent's expansion state untouched.
     * @param {unknown} agent calling Agent.
     * @param {unknown} group group name.
     * @returns {Record<string, any>} expansion result.
     */
    expand(agent, group) {
      if (disposed) return refusal(disclosureMode, 'disposed')
      if (!isAgent(agent)) return refusal(disclosureMode, 'missing-agent')
      if (typeof group !== 'string' || !Object.hasOwn(DISCLOSURE_GROUPS, group)) {
        return refusal(disclosureMode, 'unknown-group', expandedGroups(agent))
      }
      const resolved = catalogue(agent)
      if (!resolved.available) {
        return refusal(disclosureMode, 'catalog-unavailable', expandedGroups(agent), { group })
      }
      const members = resolved.groups.find((entry) => entry.group === group)?.tools ?? []
      if (members.length === 0) {
        return refusal(disclosureMode, 'no-visible-tools', expandedGroups(agent), { group })
      }
      if (disclosureMode === 'progressive') {
        let groups = expandedByAgent.get(agent)
        if (groups === undefined) {
          groups = new Set()
          expandedByAgent.set(agent, groups)
        }
        groups.add(group)
      }
      return describeFrom(resolved, agent, { group })
    },

    /**
     * Drop every expansion for one Agent. Non-Agent values are a no-op.
     * @param {unknown} agent Agent whose state should be cleared.
     * @returns {void}
     */
    forget(agent) {
      if (!isAgent(agent)) return
      expandedByAgent.delete(agent)
    },

    /**
     * Drop all state and stop disclosing. Idempotent.
     * @returns {void}
     */
    dispose() {
      disposed = true
      expandedByAgent = new WeakMap()
    },
  }
}
