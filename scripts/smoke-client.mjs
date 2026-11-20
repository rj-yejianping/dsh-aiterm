#!/usr/bin/env node
/**
 * VM smoke test for the built browser half (`lib/client.js`).
 *
 * There is no browser in this environment, so this harness renders the real
 * bundle inside `node:vm` with a tiny React-compatible hook runtime, a stubbed
 * `window.__ModuleLoader__`, RPC `fetch`, `EventSource` and clipboard. It then
 * drives the panel exactly like a user would (clicking the control bar, typing
 * filters, saving/running/deleting scripts) and asserts that:
 *
 * - `apply()` registers the locale dictionaries, the tab type and every slot
 *   body (zh and en carry identical key sets);
 * - the panel and both v2 overlays render in the empty / loading / error /
 *   populated states without throwing;
 * - the history RPC payloads match CONTRACTS.md §12.3 and the invalid-time path
 *   never reaches the Host;
 * - script save surfaces the Host error message verbatim, and run progress
 *   comes from the global `batch` SSE frame (append, truncate, re-enable);
 * - `read.screen` copy never sends terminal input;
 * - malformed SSE frames are ignored;
 * - v4 session lifecycle (§15–§18): `disconnected` stays in the rail with a
 *   hollow amber dot and a dimmed title, 中断 sends `{ id }`, 重连 sends
 *   `{ id, cols, rows }` from the fitted terminal and disables while pending,
 *   the `reset` frame clears the terminal exactly once with the localized notice
 *   (generation bumps do the same when the reset frame was missed) and a failed
 *   reconnect shows the Host error verbatim;
 * - v6 script master-detail: the two dialect paths never keep a permanent
 *   primary highlight, the left list and right editor are visible together,
 *   ▲/▼ persist a local display order (localStorage), 复制 saves <name>-copy
 *   with the real steps, 重命名分组 rewrites every affected script, and the run
 *   log lives in a floating OverlayWindow (no inline log, no reserved blank
 *   block in the panel).
 *
 * Usage: `node scripts/smoke-client.mjs` (after `npm run build`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(root, 'lib/client.js')
const code = readFileSync(bundlePath, 'utf8')

/* ------------------------------------------------------------------ *
 * Minimal React runtime: hooks with real state, effects with deps and a
 * remount (hooks reset) when a component leaves the tree between passes.
 * ------------------------------------------------------------------ */

const instances = new Map()
let currentInstance = null
let passDirty = false
let renderedThisPass = new Set()

function instanceFor(fn) {
  let instance = instances.get(fn)
  if (!instance) {
    instance = { hooks: [], index: 0, dirty: false, unmounted: false, pendingEffects: [] }
    instances.set(fn, instance)
  }
  return instance
}

function withRender(fn, props) {
  const instance = instanceFor(fn)
  if (instance.unmounted) {
    instance.unmounted = false
    instance.hooks = []
    instance.index = 0
    instance.dirty = false
    instance.pendingEffects = []
  }
  const previous = currentInstance
  currentInstance = instance
  instance.index = 0
  renderedThisPass.add(instance)
  let output
  try {
    output = fn(props)
  } finally {
    currentInstance = previous
  }
  instance.dirty = false
  return output
}

function useState(initial) {
  const instance = currentInstance
  const index = instance.index++
  if (!(index in instance.hooks)) {
    instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
  }
  const slot = instance.hooks[index]
  const set = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next
    if (Object.is(value, slot.value)) return
    slot.value = value
    instance.dirty = true
    passDirty = true
  }
  return [slot.value, set]
}

function useRef(initial) {
  const instance = currentInstance
  const index = instance.index++
  if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
  return instance.hooks[index]
}

function useEffect(fn, deps) {
  const instance = currentInstance
  const index = instance.index++
  const slot = instance.hooks[index] || (instance.hooks[index] = { deps: undefined, cleanup: undefined, queued: false })
  const changed = !deps || !slot.deps || deps.length !== slot.deps.length || deps.some((value, i) => !Object.is(value, slot.deps[i]))
  if (changed && !slot.queued) {
    slot.queued = true
    instance.pendingEffects.push({ slot, fn, deps })
  }
}

function useMemo(fn) {
  const instance = currentInstance
  instance.index += 1
  return fn()
}

function useCallback(fn) {
  const instance = currentInstance
  instance.index += 1
  return fn
}

function useSyncExternalStore(subscribe, getSnapshot) {
  const [, setVersion] = useState(0)
  useEffect(() => subscribe(() => setVersion((value) => value + 1)), [subscribe])
  return getSnapshot()
}

const React = {
  useState,
  useEffect,
  useLayoutEffect: useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  }),
  Fragment: 'fragment',
}

const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
  jsxDEV: (type, props) => ({ type, props: props || {} }),
  Fragment: 'fragment',
}

/* ------------------------------------------------------------------ *
 * Tree expansion (function components -> host nodes) and effects.
 * ------------------------------------------------------------------ */

function childrenOf(props) {
  if (!props || props.children === undefined) return []
  return Array.isArray(props.children) ? props.children : [props.children]
}

function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    return { type: '#array', children: node.map(expand).filter(Boolean) }
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') {
      return expand(withRender(node.type, node.props || {}))
    }
    if (node.type === 'fragment' || node.type === jsxRuntime.Fragment || node.type === React.Fragment) {
      return { type: '#fragment', children: childrenOf(node.props).map(expand).filter(Boolean) }
    }
    return {
      type: node.type,
      props: node.props || {},
      children: childrenOf(node.props).map(expand).filter(Boolean),
    }
  }
  return null
}

function flushEffects() {
  const queue = []
  for (const instance of instances.values()) {
    if (instance.pendingEffects.length === 0) continue
    if (!renderedThisPass.has(instance)) {
      instance.pendingEffects = []
      continue
    }
    queue.push(...instance.pendingEffects)
    instance.pendingEffects = []
  }
  for (const item of queue) {
    item.slot.queued = false
    if (typeof item.slot.cleanup === 'function') {
      try {
        item.slot.cleanup()
      } catch (error) {
        throw new Error(`effect cleanup threw: ${error && error.message}`)
      }
    }
    let cleanup
    try {
      cleanup = item.fn()
    } catch (error) {
      throw new Error(`effect threw: ${error && (error.stack || error.message)}`)
    }
    item.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    item.slot.deps = item.deps
  }
}

function hasPending() {
  if (passDirty) return true
  for (const instance of instances.values()) if (instance.dirty) return true
  return false
}

let rootType = null
let rootProps = {}
let lastTree = null

function renderPass() {
  passDirty = false
  renderedThisPass = new Set()
  lastTree = expand({ type: rootType, props: rootProps })
  flushEffects()
  for (const instance of instances.values()) {
    if (!renderedThisPass.has(instance)) {
      instance.unmounted = true
      instance.dirty = false
      instance.pendingEffects = []
    }
  }
  return lastTree
}

const tick = () => new Promise((done) => setTimeout(done, 1))

async function settle(label) {
  for (let round = 0; round < 60; round += 1) {
    renderPass()
    await tick()
    if (!hasPending()) {
      renderPass()
      await tick()
      if (!hasPending()) return lastTree
    }
  }
  throw new Error(`render did not stabilize: ${label}`)
}

function renderOnce() {
  passDirty = false
  renderedThisPass = new Set()
  lastTree = expand({ type: rootType, props: rootProps })
  return lastTree
}

/* ------------------------------------------------------------------ *
 * Tree queries.
 * ------------------------------------------------------------------ */

function walk(node, visit) {
  if (!node) return
  visit(node)
  if (node.children) for (const child of node.children) walk(child, visit)
}

function collect(node, predicate) {
  const out = []
  walk(node, (entry) => {
    if (predicate(entry)) out.push(entry)
  })
  return out
}

function textOf(node) {
  let out = ''
  walk(node, (entry) => {
    if (entry.text !== undefined) out += entry.text
  })
  return out
}

function nodeTexts(node) {
  const out = []
  walk(node, (entry) => {
    if (entry.text !== undefined) out.push(entry.text)
  })
  return out
}

function flatText(node = lastTree) {
  return nodeTexts(node).join('\n')
}

function findButtonByText(text) {
  return collect(lastTree, (node) => node.type === 'button' && textOf(node).includes(text))[0] || null
}

function findButtonByTitle(title) {
  return collect(lastTree, (node) => {
    if (node.type !== 'button') return false
    const props = node.props || {}
    return props.title === title || props['aria-label'] === title
  })[0] || null
}

function findNode(predicate) {
  return collect(lastTree, predicate)[0] || null
}

function findDialog() {
  return findNode((node) => Boolean(node.props) && node.props.role === 'dialog' && node.type === 'div')
}

async function clickNode(node, label = 'control') {
  assert.ok(node, `${label} not found`)
  const props = node.props || {}
  assert.notEqual(props.disabled, true, `${label} is disabled`)
  assert.equal(typeof props.onClick, 'function', `${label} has no click handler`)
  props.onClick({ preventDefault() {}, stopPropagation() {}, target: node })
  await settle(`click ${label}`)
}

function findInput(predicate) {
  return findNode((node) => node.type === 'input' && predicate(node.props || {}))
}

async function setInput(node, value, label = 'input') {
  assert.ok(node, `${label} not found`)
  assert.equal(typeof node.props.onChange, 'function', `${label} has no change handler`)
  node.props.onChange({ target: { value } })
  await settle(`type ${label}`)
}

async function toggleCheckbox(node, checked, label = 'checkbox') {
  assert.ok(node, `${label} not found`)
  assert.equal(typeof node.props.onChange, 'function', `${label} has no change handler`)
  node.props.onChange({ target: { checked } })
  await settle(`toggle ${label}`)
}

/* ------------------------------------------------------------------ *
 * Sandbox: loader, DOM-ish globals, RPC fetch, SSE, clipboard.
 * ------------------------------------------------------------------ */

const streams = []
const clipboard = []
const uncaught = []

class EventSourceStub {
  constructor(url) {
    this.url = url
    this.onmessage = null
    this.onopen = null
    this.onerror = null
    this.closed = false
    streams.push(this)
  }

  close() {
    this.closed = true
  }

  emit(frame) {
    if (this.closed) return
    if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(frame) })
  }

  emitRaw(data) {
    if (this.closed) return
    if (typeof this.onmessage === 'function') this.onmessage({ data })
  }
}

/**
 * Strip the per-AI-session `owner` from RPC params before comparing them.
 *
 * Every session-scoped call carries the DSH session id (that is the feature),
 * so exact-shape assertions compare the rest of the payload.
 *
 * @param params - recorded RPC params.
 * @returns params without `owner`.
 */
function withoutOwner(params) {
  if (!params || typeof params !== 'object') return params
  const { owner, ...rest } = params
  return rest
}

function globalStream() {
  // The global stream may carry ?owner=<dsh session id>; match either shape.
  return streams.find((stream) => stream.url.startsWith('/aiterm/events') && !stream.url.includes('sessionId') && !stream.closed) || null
}

const scene = {
  sessions: [],
  handlers: new Map(),
  rpcCalls: [],
}

function rpcResponse(result) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, result }) }
}

async function fetchStub(url, init) {
  assert.ok(String(url).endsWith('/aiterm/rpc'), `unexpected fetch: ${url}`)
  const body = JSON.parse(init.body)
  scene.rpcCalls.push(body)
  const handler = scene.handlers.get(body.method)
  if (!handler) {
    // Mirror the Host: the list is scoped to the calling AI session, so a
    // conversation never sees another one's terminals.
    if (body.method === 'sessions.list') {
      const owner = body.params && body.params.owner
      const sessions = (scene.sessions || []).filter((entry) => (entry.owner || undefined) === (owner || undefined))
      return rpcResponse({ sessions })
    }
    return rpcResponse({})
  }
  const result = await handler(body.params)
  if (result && result.__hostError) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: false, error: result.__hostError }) }
  }
  if (result && result.__networkError) throw new Error(result.__networkError)
  return rpcResponse(result)
}

const safeTimeout = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

const domElement = () => ({
  style: {},
  value: '',
  setAttribute() {},
  appendChild() {},
  removeChild() {},
  focus() {},
  select() {},
  parentNode: null,
})

const sandbox = {
  console: {
    log() {},
    error() {},
    warn() {},
    info() {},
    debug() {},
  },
  process: { env: { NODE_ENV: 'production' } },
  setTimeout: safeTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  queueMicrotask,
  atob: (value) => Buffer.from(String(value), 'base64').toString('latin1'),
  btoa: (value) => Buffer.from(String(value), 'latin1').toString('base64'),
  Uint8Array,
  TextEncoder,
  TextDecoder,
  performance: { now: () => Date.now() },
  navigator: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    language: 'zh-CN',
    languages: ['zh-CN'],
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    clipboard: {
      writeText: async (text) => {
        clipboard.push(text)
      },
    },
  },
  matchMedia: (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  PointerEvent: class {},
  KeyboardEvent: class {},
  WheelEvent: class {},
  Node: class {},
  requestAnimationFrame: (callback) => {
    callback(0)
    return 1
  },
  cancelAnimationFrame: () => {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  EventSource: EventSourceStub,
  fetch: fetchStub,
  document: {
    documentElement: {},
    body: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => domElement(),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: () => ({ appendChild() {} }),
    querySelector: () => null,
    queryCommandSupported: () => false,
    hasFocus: () => true,
    execCommand: () => true,
  },
  scrollX: 0,
  scrollY: 0,
  origin: 'http://localhost',
  devicePixelRatio: 1,
  unhandledRejection: null,
}
// In-memory localStorage: scriptDialect.js and scriptOrder.js persist here.
{
  const storage = new Map()
  sandbox.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => { storage.set(String(key), String(value)) },
    removeItem: (key) => { storage.delete(String(key)) },
    clear: () => { storage.clear() },
    key: (index) => [...storage.keys()][index] === undefined ? null : [...storage.keys()][index],
    get length() { return storage.size },
  }
}
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.globalThis = sandbox
sandbox.Error = Error

let loaded = null
sandbox.__ModuleLoader__ = {
  load(entry) {
    loaded = entry
  },
}
sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__

vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: bundlePath })

assert.ok(loaded, 'the bundle did not call __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-aiterm')
assert.equal(typeof loaded.factory, 'function')

const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1])
  .filter((specifier) => specifier !== 'react' && specifier !== 'react-dom' && specifier !== 'react-dom/client' && specifier !== 'react/jsx-runtime' && specifier !== 'react/jsx-dev-runtime')
assert.deepEqual([...new Set(requires)], [], 'the bundle requires a module outside the React family')

const exported = loaded.factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === 'react/jsx-dev-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${name}`)
})

/* ------------------------------------------------------------------ *
 * apply() with a faked client Context.
 * ------------------------------------------------------------------ */

const calls = { tabs: [], slots: [], registrations: [], effects: [], locale: [] }
let dictZh = {}
let dictEn = {}

const ctx = {
  locale: {
    bind: (namespace) => (key) => (Object.prototype.hasOwnProperty.call(dictZh, key) ? dictZh[key] : key),
    register: (namespace, dictionaries) => {
      dictZh = dictionaries.zh || {}
      dictEn = dictionaries.en || {}
      calls.locale.push({ namespace, zh: Object.keys(dictZh).length, en: Object.keys(dictEn).length })
      return () => undefined
    },
  },
  sidebarRightTabs: {
    register: (definition) => {
      calls.tabs.push(definition)
      return () => undefined
    },
  },
  slots: {
    inject: (name, register) => {
      calls.slots.push(name)
      return register()
    },
    register: (options, component) => {
      calls.registrations.push({ options, component })
      return () => undefined
    },
  },
  effect: (fn, label) => {
    calls.effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => undefined
  },
}

assert.equal(typeof exported.apply, 'function', 'apply() missing')
assert.ok(Array.isArray(exported.inject) && exported.inject.includes('slots'), 'inject must include slots')
exported.apply(ctx)

/* --- static registration assertions ------------------------------- */

assert.equal(calls.tabs.length, 1, 'exactly one tab type must be registered')
const tab = calls.tabs[0]
assert.equal(tab.id, 'dsh-aiterm')
assert.equal(tab.kind, 'aiterm')
assert.equal(tab.multiple, false)
assert.equal(tab.priority, 'extension')
assert.equal(typeof tab.title, 'function')
assert.ok(tab.title().length > 0)
assert.equal(tab.guide.length, 1)

assert.equal(calls.locale.length, 1, 'locale must be registered once')
assert.equal(calls.locale[0].namespace, 'aiterm')
assert.ok(Object.keys(dictZh).length > 100, 'zh dictionary is unexpectedly small')
assert.deepEqual(Object.keys(dictEn).sort(), Object.keys(dictZh).sort(), 'zh and en must have identical key sets')

const paneKeys = calls.registrations
  .filter((entry) => entry.options.name === 'sidebar.right.pane.tab')
  .map((entry) => entry.options.key)
  .sort()
assert.deepEqual(paneKeys, ['dsh-aiterm', 'aiterm'].sort())
const titleKeys = calls.registrations
  .filter((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
  .map((entry) => entry.options.key)
  .sort()
assert.deepEqual(titleKeys, ['dsh-aiterm', 'aiterm'].sort())
assert.ok(calls.effects.length >= 6, 'apply() must register effects')

const panelEntry = calls.registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-aiterm')
const titleEntry = calls.registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title' && entry.options.key === 'dsh-aiterm')
assert.ok(panelEntry && typeof panelEntry.component === 'function')
assert.ok(titleEntry && typeof titleEntry.component === 'function')

/* ------------------------------------------------------------------ *
 * Helpers for the panel.
 * ------------------------------------------------------------------ */

function dict(key) {
  assert.ok(Object.prototype.hasOwnProperty.call(dictZh, key), `missing locale key: ${key}`)
  return dictZh[key]
}

function fmtLike(key, vars) {
  let text = dict(key)
  for (const [name, value] of Object.entries(vars || {})) text = text.split(`{${name}}`).join(String(value))
  return text
}

const scriptEditor = () => findNode((node) => node.type === 'textarea')
const nameField = () => findInput((props) => props['aria-label'] === dict('scriptsName'))

const now = Date.now()

function sessionRecord(overrides = {}) {
  return {
    id: 'st-1',
    title: 'root@10.0.0.5',
    transport: 'ssh',
    host: '10.0.0.5',
    port: 22,
    username: 'root',
    state: 'open',
    cols: 100,
    rows: 30,
    createdAt: now - 60_000,
    updatedAt: now,
    lastActivityAt: now,
    bytesIn: 100,
    bytesOut: 200,
    permission: { aiAccess: 'rw', lockOwner: null, lockExpiresAt: null, humanWriteBlocked: false, aiWriteBlocked: false },
    ...overrides,
  }
}

async function setSessions(sessions) {
  scene.sessions = sessions
  const stream = globalStream()
  assert.ok(stream, 'the global SSE stream was not opened')
  stream.emit({ type: 'sessions', sessions })
  await settle('sessions frame')
}

async function closePanelViaBar() {
  const dialog = findDialog()
  if (!dialog) return
  const label = (dialog.props && dialog.props['aria-label']) || ''
  const name = label === dictZh.historyTitle
    ? 'history'
    : label === dictZh.scriptsTitle
      ? 'scripts'
      : label === dictZh.profilesTitle
        ? 'profiles'
        : null
  assert.ok(name, `unknown dialog: ${label}`)
  await clickNode(findButtonByTitle(dictZh[name]), `${name} toggle`)
  assert.equal(findDialog(), null, `${name} panel should be closed`)
}

/**
 * Create a new script draft of one dialect.
 *
 * The two dialects are chosen in the 新建类型 selector; the 新建 button in the
 * left column then creates whatever is selected. Steps the assertion side the
 * same way a user would.
 *
 * @param dialect - 'macro' or 'json'.
 * @returns {Promise<void>} resolves once the draft editor is open.
 */
async function createScript(dialect) {
  // Idempotent: only open the chooser when it is closed (clicking the opener
  // again would toggle it shut and the option lookup would fail).
  let menu = findNode((node) => node.props && node.props.role === 'menu')
  if (!menu) {
    const create = findButtonByText('+ ' + dict('scriptsNewAction'))
    assert.ok(create, 'the left column must offer 新建')
    await clickNode(create, 'open the new-script chooser')
    menu = findNode((node) => node.props && node.props.role === 'menu')
  }
  // Search INSIDE the popup: script rows also contain the dialect label text, so
  // a page-wide text match would click a list row instead of the menu option.
  assert.ok(menu, 'the dialect chooser must open')
  const label = dialect === 'json' ? dict('scriptsModeJson') : dict('scriptsModeMacro')
  const option = collect(menu, (node) => node.type === 'button' && textOf(node).includes(label))[0]
  assert.ok(option, 'the chooser must offer ' + dialect)
  await clickNode(option, 'create a ' + dialect + ' script')
}

async function openPanelViaBar(name) {
  await closePanelViaBar()
  await clickNode(findButtonByTitle(dictZh[name]), `${name} toggle`)
  const dialog = findDialog()
  assert.ok(dialog, `${name} panel should be open`)
  return dialog
}

function hhmmssmmm(at) {
  const date = new Date(at)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

async function emitBatch(frame) {
  const stream = globalStream()
  assert.ok(stream, 'global stream missing')
  stream.emit(frame)
  await settle('batch frame')
}

/* ------------------------------------------------------------------ *
 * Scenario 1 — initial loading state, then empty session list.
 * ------------------------------------------------------------------ */

rootType = panelEntry.component
rootProps = { sessionId: 'session-smoke', t: (key) => dict(key) }

renderOnce()
assert.ok(textOf(lastTree).includes(dict('loading')), 'the initial render must show the loading state')

await settle('initial mount')
assert.ok(globalStream(), 'mounting the panel must open the global SSE stream')
// UX: with no session the connection library is the home view, not a blank
// new-connection form; 新建连接 is offered from there.
assert.ok(
  textOf(lastTree).includes(dict('profilesTitle')),
  'an empty session list must open the connection library (配置管理)',
)
assert.ok(
  textOf(lastTree).includes(dict('profilesNewConnection')),
  'the library must offer a 新建连接 action',
)
// The connection library is rendered as the home screen, so its sheet exists.
assert.notEqual(findDialog(), null, 'the connection library sheet must be mounted as the home view')

/* ------------------------------------------------------------------ *
 * Scenario 2 — one open session: control bar + v2 controls.
 * ------------------------------------------------------------------ */

await setSessions([sessionRecord()])
{
  const text = textOf(lastTree)
  assert.ok(text.includes('root@10.0.0.5'), 'session rail must list the session')
  assert.ok(text.includes(dict('permRw')), 'AI permission control must render')
  assert.ok(text.includes(dict('takeOver')), 'take-over button must render')
  for (const key of ['audit', 'history', 'profiles', 'scripts', 'copyScreen']) {
    assert.ok(findButtonByTitle(dict(key)), `control bar is missing the ${key} control`)
  }

  // Comfortable click targets (user feedback: "按钮有点小").
  const takeOverBtn = findButtonByText(dict('takeOver'))
  assert.ok(takeOverBtn.props.style.height >= 30, 'text buttons must be at least 30 px tall')
  assert.ok(takeOverBtn.props.style.fontSize >= 12, 'text buttons must be at least 12 px')
  const historyBtn = findButtonByTitle(dict('history'))
  assert.ok(historyBtn.props.style.width >= 30 && historyBtn.props.style.height >= 30, 'icon buttons must be at least 30x30 px')
  const segmentButton = findButtonByText(dict('permRo'))
  assert.ok(segmentButton.props.style.minWidth >= 42, 'permission segments must be at least 42 px wide')
  assert.ok(segmentButton.props.style.fontSize >= 12, 'permission segments must be at least 12 px')
  const segmented = findNode((node) => node.props && node.props.role === 'group' && node.props['aria-label'] === dict('permission'))
  assert.ok(segmented.props.style.height >= 30, 'the segmented control must be at least 30 px tall')
  const railChip = findNode((node) => node.props && node.props.role === 'presentation')
  assert.ok(railChip.props.style.height >= 32, 'rail chips must be at least 32 px tall')
}

/* ------------------------------------------------------------------ *
 * Scenario 2b — session rail: the active marker must follow the session
 * the body renders, and identical titles must stay distinguishable.
 *
 * Regression (user report): with two sessions both titled `PC`, the only
 * "selected" cue was a hairline border, and the marker could disagree with the
 * terminal below it — nothing looked selected while a terminal was displayed.
 * ------------------------------------------------------------------ */

await setSessions([
  sessionRecord({ id: 'st-a', title: 'PC', host: '10.104.12.52' }),
  sessionRecord({ id: 'st-b', title: 'PC', host: '10.104.12.53' }),
])
{
  const chips = collect(lastTree, (node) => node.props && node.props.role === 'presentation')
  assert.equal(chips.length, 2, 'both sessions must render a rail chip')

  const tabs = () => collect(lastTree, (node) => node.props && node.props.role === 'tab')
  const selectedTabs = () => tabs().filter((tab) => tab.props['aria-selected'] === true)
  assert.equal(selectedTabs().length, 1, 'exactly one rail tab may be selected')
  assert.equal(tabs()[0].props['aria-selected'], true, 'the first session starts selected')

  // Active styling must be unmistakable: accent border + accent bar, not a wash.
  const activeStyle = chips[0].props.style
  assert.ok(String(activeStyle.borderColor).includes('brand'), 'selected chip must use the accent border')
  assert.ok(String(activeStyle.boxShadow).includes('inset'), 'selected chip must paint the accent bar')

  // Duplicate titles get a #n suffix in the rail (both read "PC" otherwise).
  const railText = textOf(chips[0]) + ' ' + textOf(chips[1])
  assert.ok(railText.includes('PC #1') && railText.includes('PC #2'), `duplicate titles must be disambiguated, got ${railText}`)

  // Selecting the second tab moves the marker AND the body.
  await clickNode(tabs()[1], 'second session tab')
  const afterTabs = tabs()
  assert.equal(afterTabs[0].props['aria-selected'], false, 'the old tab must lose the selected state')
  assert.equal(afterTabs[1].props['aria-selected'], true, 'the clicked tab must become selected')
  const afterChips = collect(lastTree, (node) => node.props && node.props.role === 'presentation')
  assert.ok(
    String(afterChips[1].props.style.borderColor || '').includes('brand'),
    'the accent border must move to the clicked chip',
  )
  // Regression (user report): the deselected chip kept a text-coloured 1px box.
  // The chip overrode `borderColor` while selected, and React deletes a longhand
  // the next style object no longer lists — with the `border` shorthand the
  // deleted colour fell back to `currentColor`. The base style must therefore
  // always carry an explicit `borderColor` (and longhand width/style).
  assert.equal(
    afterChips[0].props.style.borderColor,
    'transparent',
    'the deselected chip must keep an explicit transparent border colour',
  )
  assert.equal(afterChips[0].props.style.borderWidth, '0.5px', 'the rail chip must set borderWidth as a longhand')
  assert.equal(afterChips[0].props.style.borderStyle, 'solid', 'the rail chip must set borderStyle as a longhand')
  assert.ok(
    !String(afterChips[0].props.style.borderColor || '').includes('brand'),
    'the previously selected chip must drop the accent border',
  )
}

/* ------------------------------------------------------------------ *
 * Scenario 2c — keyboard focus ring: keyboard only, never a pointer, and
 * never at the cost of the selected chip's accent bar.
 *
 * Regression (user report): after switching tabs the tab selected before kept
 * a white box. The chip paints the ring on its wrapper, which no pointer
 * modality suppression reaches, so the ring decision also requires the Host's
 * `data-input-modality` to not be `pointer`, and any pointer press clears it.
 * ------------------------------------------------------------------ */

{
  const ringNodes = () => collect(lastTree, (node) => node.props
    && node.props['aria-hidden'] === 'true'
    && node.props.style
    && node.props.style.pointerEvents === 'none'
    && node.props.style.borderRadius === 'inherit'
    && String(node.props.style.border || '').includes('1px solid'))
  const tabsNow = () => collect(lastTree, (node) => node.props && node.props.role === 'tab')
  const chipsNow = () => collect(lastTree, (node) => node.props && node.props.role === 'presentation')

  sandbox.document.documentElement.dataset = { inputModality: 'keyboard' }
  tabsNow()[1].props.onFocus({ currentTarget: { matches: (selector) => selector === ':focus-visible' } })
  await settle('keyboard focus on the second tab')
  // The VM hook runtime keys instances by component function, so all chips share
  // one focus hook here; the real tree has one hook per chip. Only presence is
  // meaningful in this harness.
  assert.ok(ringNodes().length >= 1, 'a keyboard focus must paint the ring')
  assert.ok(
    String(chipsNow()[1].props.style.boxShadow || '').includes('inset 3px'),
    'the selected chip must keep its accent bar while the ring is shown',
  )

  // A pointer press on the chip drops its ring.
  tabsNow()[1].props.onPointerDown()
  await settle('pointer down on the focused tab')
  assert.equal(ringNodes().length, 0, 'a pointer press must drop the ring')

  // Even when the browser reports :focus-visible, pointer modality wins.
  sandbox.document.documentElement.dataset = { inputModality: 'pointer' }
  tabsNow()[0].props.onFocus({ currentTarget: { matches: () => true } })
  await settle('focus under pointer modality')
  assert.equal(ringNodes().length, 0, 'pointer modality must never paint the focus ring')
  sandbox.document.documentElement.dataset = {}
}

// Restore the single-session scene for the scenarios that follow.
await setSessions([sessionRecord()])

/* ------------------------------------------------------------------ *
 * Scenario 3 — history: empty catalog, then list/query failures.
 * ------------------------------------------------------------------ */

scene.handlers.set('history.sessions', async () => ({ sessions: [] }))
await openPanelViaBar('history')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('historyTitle')), 'history sheet title must render')
  assert.ok(text.includes(dict('historySessionsEmpty')), 'empty catalog must say so')
  assert.ok(findButtonByTitle(dict('historyPanelClose')), 'history sheet must have a close control')
}
await closePanelViaBar()

scene.handlers.set('history.sessions', async () => ({
  sessions: [
    { id: 'st-1', title: 'root@10.0.0.5', transport: 'ssh', host: '10.0.0.5', port: 22, username: 'root', createdAt: now - 60_000, bytes: 2048, lastTs: now },
    { id: 'st-0', title: 'old@10.0.0.9', transport: 'telnet', host: '10.0.0.9', port: 23, username: '', createdAt: now - 7_200_000, closedAt: now - 3_600_000, bytes: 4096, lastTs: now - 3_600_000 },
  ],
}))
scene.handlers.set('history.query', async () => ({ __hostError: { code: 'HISTORY_FAILED', message: 'history unavailable' } }))
await openPanelViaBar('history')
{
  const text = textOf(lastTree)
  assert.ok(text.includes('root@10.0.0.5'), 'history catalog must show the active session')
  assert.ok(text.includes('old@10.0.0.9'), 'history catalog must include closed sessions')
  assert.ok(text.includes('10.0.0.9'), 'history catalog rows must show the host')
  assert.ok(text.includes(dict('historyOngoing')), 'active sessions must show the ongoing marker')
  assert.ok(text.includes(fmtLike('historyQueryFailed', { message: 'history unavailable' })), 'query errors must render inline')
}
await closePanelViaBar()

// A failing catalog RPC must render inline and keep the filters usable.
scene.handlers.set('history.sessions', async () => ({ __networkError: 'catalog unavailable' }))
await openPanelViaBar('history')
assert.ok(
  textOf(lastTree).includes(fmtLike('historySessionsFailed', { message: 'catalog unavailable' })),
  'a failing history.sessions RPC must render inline',
)
assert.ok(findInput((props) => props.placeholder === '10m'), 'filters must stay usable after a catalog failure')
await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 4 — history: matches, highlighting, footer, time validation,
 * payload shape and copy.
 * ------------------------------------------------------------------ */

const base = new Date(2026, 0, 2, 3, 4, 5, 123).getTime()
const catalog = [
  { id: 'st-1', title: 'root@10.0.0.5', transport: 'ssh', host: '10.0.0.5', port: 22, username: 'root', createdAt: now - 60_000, bytes: 2048, lastTs: now },
  { id: 'st-0', title: 'old@10.0.0.9', transport: 'telnet', host: '10.0.0.9', port: 23, username: '', createdAt: now - 7_200_000, closedAt: now - 3_600_000, bytes: 4096, lastTs: now - 3_600_000 },
]
const matches = [
  { at: base, line: 'ERROR disk full', before: ['context before'], after: ['context after'] },
  { at: base + 5000, line: 'another ERROR here', before: [], after: [] },
]

scene.handlers.set('history.sessions', async () => ({ sessions: catalog }))
scene.handlers.set('history.query', async () => ({ matches, truncated: true, scannedBytes: 4096 }))
await openPanelViaBar('history')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(hhmmssmmm(matches[0].at)), 'matches must render HH:MM:SS.mmm')
  assert.ok(text.includes('ERROR disk full'), 'match lines must render')
  assert.ok(text.includes('context before') && text.includes('context after'), 'context lines must render')
  assert.ok(text.includes(dict('historyTruncated')), 'the truncated hint must render')
  assert.ok(text.includes(fmtLike('historyFooter', { size: '4.0K', count: 2 })), 'footer must show scanned bytes and match count')
}

// A keyword re-query highlights every occurrence on the match lines.
await setInput(findInput((props) => props.placeholder === 'error|timeout'), 'ERROR', 'search')
await clickNode(findButtonByText(dict('historyQuery')), 'history query')
{
  const hits = collect(lastTree, (node) => {
    const style = node.props && node.props.style
    return node.type === 'span' && style && style.fontWeight === 600 && textOf(node) === 'ERROR'
  })
  assert.ok(hits.length >= 2, 'the keyword must be highlighted on every match line')
}

// Invalid time input must be reported locally and must not reach the Host.
const requestedBefore = scene.rpcCalls.filter((call) => call.method === 'history.query').length
await setInput(findInput((props) => props.placeholder === '10m'), 'not-a-time', 'since')
await clickNode(findButtonByText(dict('historyQuery')), 'history query')
assert.ok(textOf(lastTree).includes('时间格式无效') || textOf(lastTree).includes(dict('historyTimeInvalid').split('{')[0]), 'invalid time must be reported inline')
assert.equal(
  scene.rpcCalls.filter((call) => call.method === 'history.query').length,
  requestedBefore,
  'an invalid time must not reach the Host',
)

// Valid filters reach history.query with parsed epoch bounds.
await setInput(findInput((props) => props.placeholder === '10m'), '10m', 'since')
await setInput(findInput((props) => props.placeholder === 'error|timeout'), 'error', 'search')
await setInput(findNode((node) => node.type === 'select'), '2', 'context')
await clickNode(findButtonByText(dict('historyQuery')), 'history query')
{
  const callsForQuery = scene.rpcCalls.filter((call) => call.method === 'history.query')
  const last = callsForQuery[callsForQuery.length - 1]
  assert.ok(last, 'history.query must be called')
  assert.equal(last.params.sessionId, 'st-1')
  assert.equal(last.params.search, 'error')
  assert.equal(last.params.context, 2)
  assert.equal(last.params.maxMatches, 200)
  assert.equal(typeof last.params.since, 'number')
  assert.ok(Math.abs(last.params.since - (Date.now() - 600_000)) < 10_000, 'relative since must be parsed to epoch ms')
  assert.equal(last.params.until, undefined)
}

// Copy results into the clipboard (no manual fallback needed here).
clipboard.length = 0
await clickNode(findButtonByText(dict('historyCopy')), 'copy results')
assert.equal(clipboard.length, 1, 'copying results must use the clipboard API')
assert.ok(clipboard[0].includes(hhmmssmmm(matches[0].at)), 'copied text must carry timestamps')
assert.ok(clipboard[0].includes('ERROR disk full'), 'copied text must carry the match lines')
assert.ok(textOf(lastTree).includes(dict('copied')), 'copying must show a toast')

await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 5 — history: live-session raw fragment, then empty result.
 * ------------------------------------------------------------------ */

// A live session without a keyword answers with a text slice instead of matches.
scene.handlers.set('history.query', async () => ({ text: 'first line\nsecond line', scannedBytes: 2048, truncated: false, entry: catalog[0] }))
await openPanelViaBar('history')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('historyFragment')), 'a raw text slice must be labelled')
  assert.ok(text.includes('first line') && text.includes('second line'), 'the raw slice lines must render')
  assert.ok(text.includes(fmtLike('historyFooter', { size: '2.0K', count: 2 })), 'the fragment footer must count its lines')
}
clipboard.length = 0
await clickNode(findButtonByText(dict('historyCopy')), 'copy fragment')
assert.equal(clipboard[0], 'first line\nsecond line', 'copying a fragment must copy the raw text')
await closePanelViaBar()

scene.handlers.set('history.query', async () => ({ matches: [], truncated: false, scannedBytes: 100 }))
await openPanelViaBar('history')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('historyNoMatches')), 'an empty result must say so')
  assert.ok(text.includes(fmtLike('historyFooter', { size: '100', count: 0 })), 'empty footer must render')
}
await closePanelViaBar()

// The master-detail editor loads the selected script with scripts.get; a
// default handler keeps every scenario that does not care about the definition
// working (specific scenarios override it).
scene.handlers.set('scripts.get', async (params) => ({
  script: { name: params.name, description: '', folder: '', params: {}, steps: [{ send: params.name }] },
}))

/* ------------------------------------------------------------------ *
 * Scenario 6 — scripts: list failure, empty list, editor, JSON/Host errors.
 * ------------------------------------------------------------------ */

scene.handlers.set('scripts.list', async () => ({ __networkError: 'scripts unavailable' }))
await openPanelViaBar('scripts')
assert.ok(
  textOf(lastTree).includes(fmtLike('scriptsListFailed', { message: 'scripts unavailable' })),
  'a failing scripts.list RPC must render inline',
)
await closePanelViaBar()

scene.handlers.set('scripts.list', async () => ({ scripts: [] }))
await openPanelViaBar('scripts')
assert.ok(textOf(lastTree).includes(dict('scriptsEmpty')), 'empty script list must say so')
assert.ok(findButtonByTitle(dict('scriptsPanelClose')), 'scripts sheet must have a close control')

// Both dialects are separate creation paths; the JSON switch is gone.
assert.equal(findNode((n) => n.props && n.props.role === 'menu'), null, 'the dialect chooser must start closed')
assert.ok(findButtonByText(dict('scriptsNewAction')), '新建 must exist')

// ── 逐行命令 path ───────────────────────────────────────────────────────
await createScript('macro')
assert.ok(textOf(lastTree).includes(dict('scriptsMacroHelp')), 'the per-line editor must render')
assert.ok(findNode((node) => node.type === 'textarea'), 'the command editor needs a textarea')

// A name is required: the payload is built from the metadata fields.
{
  const before = scene.rpcCalls.length
  await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save without a name')
  assert.ok(textOf(lastTree).includes(dict('scriptsNameRequired')), 'a missing name must be reported locally')
  assert.equal(scene.rpcCalls.slice(before).filter((c) => c.method === 'scripts.save').length, 0)
}

// Name it, type a bad directive, and check the line-numbered error.
await setInput(nameField(), 'demo', 'script name')
await setInput(findNode((node) => node.type === 'textarea'), '@nope 1', 'macro text')
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save invalid macro')
{
  const shown = textOf(lastTree)
  assert.ok(shown.includes(dict('scriptsMacroParseError').split('{')[0]), 'a bad directive must be reported locally')
  assert.ok(shown.includes('unknown directive'), 'the parse error must name the problem')
}

// A plain line compiles to a send step; 等命令跑完 bakes in the waitFor.
const saveMark = scene.rpcCalls.length
scene.handlers.set('scripts.save', async () => ({ script: { name: 'demo', stepCount: 1 } }))
await setInput(findNode((node) => node.type === 'textarea'), 'uptime', 'macro text')
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save macro')
{
  const saveCall = scene.rpcCalls.slice(saveMark).filter((call) => call.method === 'scripts.save').pop()
  assert.ok(saveCall, 'saving a macro must call scripts.save')
  const script = saveCall.params.script
  assert.equal(script.name, 'demo', 'the name field must reach the payload')
  assert.equal(script.folder, '', 'the folder field must reach the payload')
  assert.deepEqual(script.params, {}, 'params must survive (they used to be dropped)')
  assert.equal(script.steps.length, 1, 'one line must compile to one step')
  assert.equal(script.steps[0].send, 'uptime')
  assert.equal(script.steps[0].waitFor, undefined, 'commands are sent as typed: no implicit waitFor')
}

await settle('macro saved')

// ── 高级脚本 path ───────────────────────────────────────────────────────
scene.handlers.set('scripts.save', async () => ({ __hostError: { code: 'BAD_SCRIPT', message: 'script contains a password field' } }))
await createScript('json')
{
  const editor = findNode((node) => node.type === 'textarea')
  assert.ok(String(editor.props.value).trim().startsWith('{'), 'the advanced editor must start from JSON')
  await setInput(editor, '{oops', 'script JSON')
}
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save invalid JSON')
assert.ok(textOf(lastTree).includes(dict('scriptsJsonInvalid').split('{')[0]), 'invalid JSON must be reported locally')

// Give it a name + folder, then save and check the Host error is verbatim.
{
  const fields = collect(lastTree, (node) => node.type === 'input' && node.props && typeof node.props.value === 'string')
  await setInput(fields[0], 'demo', 'script name')
  await setInput(findNode((node) => node.type === 'textarea'), JSON.stringify({ name: 'demo', description: 'demo script', params: {}, steps: [{ send: 'uptime' }] }), 'script JSON')
}
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save advanced script')
assert.ok(textOf(lastTree).includes('script contains a password field'), 'the Host error message must render verbatim')

const savedSummary = {
  name: 'demo',
  description: 'demo script',
  params: { target: { default: 'eth0', description: 'interface' } },
  stepCount: 1,
  updatedAt: now,
}
scene.handlers.set('scripts.save', async () => ({ script: savedSummary }))
scene.handlers.set('scripts.list', async () => ({ scripts: [savedSummary] }))
// Re-open as 高级脚本 (params live in JSON) and save the final program.
await createScript('json')
{
  const fields = collect(lastTree, (node) => node.type === 'input' && node.props && typeof node.props.value === 'string')
  await setInput(fields[0], 'demo', 'script name')
  await setInput(findNode((node) => node.type === 'textarea'), JSON.stringify({ name: 'demo', description: 'demo script', params: { target: { default: 'eth0' } }, steps: [{ send: 'ip a' }] }), 'script JSON')
}
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save script')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('scriptsSaved')), 'saving must toast')
  assert.ok(text.includes('demo'), 'the reloaded list must show the saved script')
  // Master-detail: the saved script stays selected and its editor stays open on
  // the right (it no longer disappears after saving).
  assert.ok(findNode((node) => node.type === 'textarea'), 'the saved script must stay open in the editor')
  assert.equal(
    findInput((props) => props['aria-label'] === dict('scriptsName')).props.value,
    'demo',
    'the saved script must stay selected',
  )
}

/* ------------------------------------------------------------------ *
 * Scenario 7 — scripts: parameter defaults, live batch progress, done.
 * ------------------------------------------------------------------ */

{
  const paramInput = findInput((props) => props.value === 'eth0')
  assert.ok(paramInput, 'the selected script parameter must show its default value')
}

let resolveRun = null
scene.handlers.set('scripts.run', () => new Promise((resolve) => {
  resolveRun = resolve
}))
await clickNode(findButtonByText(dict('scriptsRun')), 'run script')
assert.ok(textOf(lastTree).includes(dict('scriptsRunning')), 'running state must be visible')
{
  const runCalls = scene.rpcCalls.filter((call) => call.method === 'scripts.run')
  const last = runCalls[runCalls.length - 1]
  assert.equal(last.params.name, 'demo')
  assert.deepEqual(last.params.params, { target: 'eth0' })
  assert.equal(last.params.sessionId, 'st-1')
  assert.equal(last.params.targets, undefined)
}

const batchId = 'batch-1'
await emitBatch({ type: 'batch', batchId, label: 'script:demo', state: 'step', sessionId: 'st-1', stepIndex: 0, ok: true, text: 'eth0: flags=4163<UP>' })
await emitBatch({ type: 'batch', batchId, label: 'script:demo', state: 'step', sessionId: 'st-1', stepIndex: 1, ok: false, error: 'permission denied' })
await emitBatch({ type: 'batch', batchId, label: 'script:demo', state: 'step', sessionId: 'st-1', stepIndex: 2, ok: true, text: 'x'.repeat(400) })
{
  const text = textOf(lastTree)
  assert.ok(text.includes('#0') && text.includes('#1') && text.includes('#2'), 'one progress line per step must render')
  assert.ok(text.includes('✓') && text.includes('✗'), 'progress must show success and failure glyphs')
  assert.ok(text.includes('permission denied'), 'the step error must render')
  const longLine = collect(lastTree, (node) => node.text !== undefined && node.text.includes('xxx'))
  assert.ok(longLine.length > 0, 'the long step text must render')
  assert.ok(longLine[0].text.length <= 200 && longLine[0].text.endsWith('…'), 'step text must be truncated to 200 characters')
}

resolveRun({ result: { ok: true, timedOut: false, runs: [{ sessionId: 'st-1', ok: true, steps: [{ index: 0, ok: true }, { index: 1, ok: false }] }] } })
await settle('scripts.run resolved')
await emitBatch({ type: 'batch', batchId, label: 'script:demo', state: 'done', sessionId: 'st-1', stepIndex: 2, ok: true })
{
  const text = textOf(lastTree)
  assert.ok(text.includes(fmtLike('scriptsRunSummary', { runs: 1, ok: 1 })), 'the run summary must render')
  assert.ok(!text.includes('#-1'), 'the done frame must not be rendered as a step line')
  const runButton = findButtonByText(dict('scriptsRun'))
  assert.ok(runButton, 'the run button must be re-enabled after done')
  assert.notEqual(runButton.props.disabled, true, 'the run button must not stay disabled')
}

// A different batch id starts a fresh progress record (e.g. an AI batch).
await emitBatch({ type: 'batch', batchId: 'batch-2', label: 'batch', state: 'step', sessionId: 'st-2', stepIndex: 0, ok: true, text: 'fresh' })
{
  const text = textOf(lastTree)
  assert.ok(text.includes('fresh'), 'a new batch must show its own line')
  assert.ok(!text.includes('#1'), 'a new batch must reset previous progress lines')
}
await emitBatch({ type: 'batch', batchId: 'batch-2', label: 'batch', state: 'done', sessionId: 'st-2', stepIndex: 0, ok: true })

/* ------------------------------------------------------------------ *
 * Scenario 7b — scripts: actions on top, and a multi-session run target.
 *
 * Regression (user report): 编辑 / 新建 / 删除 sat in the sheet footer, far from
 * where the user looks, and the run target only offered "this session" or "all".
 * ------------------------------------------------------------------ */

{
  // Two open sessions so 选定会话 has something to tick.
  await setSessions([
    sessionRecord({ id: 'st-1', title: 'PC', host: '10.104.12.52' }),
    sessionRecord({ id: 'st-2', title: 'DB', host: '10.104.12.53' }),
  ])
  await closePanelViaBar()
  await openPanelViaBar('scripts')

  // The type selector sits above the split; 新建 lives with the list, and the
  // selected row is edited directly in the right pane (no separate 编辑 button).
  const newBtn = findButtonByText(dict('scriptsNewAction'))
  assert.ok(newBtn, '新建 must be its own button')
  assert.ok(findButtonByText('+ ' + dict('scriptsNewAction')), '新建 must open the dialect chooser')
  assert.ok(findButtonByText(dict('scriptsDelete')), '删除 must render')
  {
    const flat = []
    walk(lastTree, (node) => flat.push(node))
    const newIndex = flat.indexOf(newBtn)
    const anyListRow = flat.findIndex((node) => node.props && node.props.role === 'option')
    assert.ok(newIndex >= 0, 'the creation row must be reachable in the tree')
    assert.ok(anyListRow >= 0, 'the master list must render')
    assert.ok(newIndex >= 0, 'the 新建 button must be reachable with the list')
    // Master and detail are visible at the same time.
    assert.ok(
      findInput((props) => props['aria-label'] === dict('scriptsName')),
      'the detail editor must render next to the list',
    )
  }

  // 选定会话: tick both sessions and run against exactly those two.
  await clickNode(findButtonByText(dict('scriptsTargetPicked')), 'selected target mode')
  const boxesOf = () => collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
  assert.equal(boxesOf().length, 2, 'one checkbox per open session must render')
  await toggleCheckbox(boxesOf()[0], true, 'tick first session')
  await toggleCheckbox(boxesOf()[1], true, 'tick second session')
  assert.ok(boxesOf().every((box) => box.props.checked === true), 'both ticks must persist')

  // Do not clear rpcCalls: the final report counts distinct methods exercised.
  const callMark = scene.rpcCalls.length
  scene.handlers.set('scripts.run', async () => ({ result: { ok: true, timedOut: false, runs: [] } }))
  await clickNode(findButtonByText(dict('scriptsRun')), 'run on picked sessions')
  const runCall = scene.rpcCalls.slice(callMark).find((call) => call.method === 'scripts.run')
  assert.ok(runCall, 'running on picked sessions must call scripts.run')
  assert.deepEqual(runCall.params.targets, ['st-1', 'st-2'], 'the ticked sessions must be sent as targets')
  assert.equal(runCall.params.sessionId, undefined, 'the single-session field must not be sent in picked mode')

  await closePanelViaBar()
  await setSessions([sessionRecord()])
}


/* ------------------------------------------------------------------ *
 * Scenario 8 — scripts: delete with confirmation.
 * ------------------------------------------------------------------ */

await closePanelViaBar()
await openPanelViaBar('scripts')
await clickNode(findButtonByTitle('demo script'), 'select script')
await clickNode(findButtonByTitle(dict('scriptsDelete')), 'delete script')
assert.ok(textOf(lastTree).includes(dict('scriptsDeleteConfirm')), 'delete must ask for confirmation')

scene.handlers.set('scripts.delete', async () => ({ ok: true }))
scene.handlers.set('scripts.list', async () => ({ scripts: [] }))
await clickNode(findButtonByText(dict('scriptsDeleteConfirm')), 'confirm delete')
{
  const callsForDelete = scene.rpcCalls.filter((call) => call.method === 'scripts.delete')
  assert.equal(callsForDelete.length, 1)
  assert.equal(callsForDelete[0].params.name, 'demo')
  assert.ok(textOf(lastTree).includes(dict('scriptsEmpty')), 'the list must reload after delete')
}
await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 9 — copy the current screen text (read-only).
 * ------------------------------------------------------------------ */

scene.handlers.set('read.screen', async () => ({ text: 'mock screen\nline 2', cursor: '42', atPrompt: true, unchanged: false, changedLines: [] }))
clipboard.length = 0
await clickNode(findButtonByTitle(dict('copyScreen')), 'copy screen')
{
  const callsForRead = scene.rpcCalls.filter((call) => call.method === 'read.screen')
  assert.equal(callsForRead.length, 1)
  assert.equal(callsForRead[0].params.id, 'st-1')
  assert.equal(callsForRead[0].params.changedOnly, false)
  assert.equal(clipboard[0], 'mock screen\nline 2')
  assert.ok(textOf(lastTree).includes(dict('copyScreenDone')), 'copying the screen must toast')
  assert.equal(scene.rpcCalls.filter((call) => call.method === 'sessions.input').length, 0, 'copying must never send input')
}

scene.handlers.set('read.screen', async () => ({ __hostError: { code: 'READ_FAILED', message: 'screen unavailable' } }))
await clickNode(findButtonByTitle(dict('copyScreen')), 'copy screen')
assert.ok(
  textOf(lastTree).includes(fmtLike('copyScreenFailed', { message: 'screen unavailable' })),
  'a read.screen failure must toast inline',
)

/* ------------------------------------------------------------------ *
 * Scenario 10 — profiles panel: error, empty, grouped list and the inline
 * rename / move / delete / new-folder flows (CONTRACTS.md §13).
 * ------------------------------------------------------------------ */

function folderOverviewOf(profiles) {
  const counts = new Map()
  for (const profile of profiles) {
    if (!profile.folder) continue
    counts.set(profile.folder, (counts.get(profile.folder) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

const profilesState = [
  {
    id: 'p-1', name: 'prod-web', transport: 'ssh', host: '10.0.0.5', port: 22, username: 'root',
    authType: 'password', hasPassword: true, hasPrivateKey: false, hasPassphrase: false,
    folder: 'Prod', order: 0, createdAt: now - 3000, updatedAt: now,
  },
  {
    id: 'p-2', name: 'lab', transport: 'telnet', host: '10.0.0.9', port: 23, username: '',
    authType: 'none', hasPassword: false, hasPrivateKey: false, hasPassphrase: false,
    folder: '', order: 1, createdAt: now - 2000, updatedAt: now,
  },
  {
    id: 'p-3', name: 'prod-db', transport: 'ssh', host: '10.0.0.7', port: 2222, username: 'dba',
    authType: 'privateKey', hasPassword: false, hasPrivateKey: true, hasPassphrase: true,
    folder: 'Prod', order: 1, createdAt: now - 1000, updatedAt: now,
  },
]

scene.handlers.set('profiles.list', async () => ({ __hostError: { code: 'PROFILE_FAILED', message: 'profiles unavailable' } }))
await openPanelViaBar('profiles')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(fmtLike('profilesListFailed', { message: 'profiles unavailable' })), 'a failing profiles.list must render inline')
  assert.ok(findButtonByTitle(dict('profilesPanelClose')), 'profiles sheet must expose a close control')
}
await closePanelViaBar()

// Loading state: a pending profiles.list keeps the panel in its loading branch.
{
  let resolveLoad = null
  scene.handlers.set('profiles.list', () => new Promise((resolve) => {
    resolveLoad = resolve
  }))
  await openPanelViaBar('profiles')
  assert.ok(textOf(lastTree).includes(dict('profilesLoading')), 'the profiles panel must show a loading state')
  resolveLoad({ profiles: profilesState.map((profile) => ({ ...profile })), folders: folderOverviewOf(profilesState) })
  await settle('profiles loaded')
  assert.ok(textOf(lastTree).includes('prod-web'), 'the populated list must replace the loading state')
  await closePanelViaBar()
}

scene.handlers.set('profiles.list', async () => ({ profiles: [], folders: [] }))
await openPanelViaBar('profiles')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('profilesEmpty')), 'an empty profile list must say so')
  assert.ok(text.includes(dict('profilesEmptyHint')), 'the empty state must explain how profiles are created')
  const cta = findButtonByText(dict('profilesNewConnection'))
  assert.ok(cta, 'the empty library must offer a 新建连接 CTA')
  assert.ok(String(cta.props.style.background || '').includes('button-primary-fill'), 'the empty-state CTA must be the primary button')
}
await closePanelViaBar()

scene.handlers.set('profiles.list', async () => ({
  profiles: profilesState.map((profile) => ({ ...profile })),
  folders: folderOverviewOf(profilesState),
}))
await openPanelViaBar('profiles')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('profilesTitle')), 'the profiles sheet title must render')
  for (const name of ['prod-web', 'lab', 'prod-db']) assert.ok(text.includes(name), `row ${name} must render`)
  assert.ok(text.includes('ssh root@10.0.0.5:22'), 'a row must show transport user@host:port')
  assert.ok(text.includes('telnet 10.0.0.9:23'), 'telnet rows must omit the empty username')
  assert.ok(text.includes('ssh dba@10.0.0.7:2222'), 'non-default ports must render')
  for (const key of ['profilesBadgePassword', 'profilesBadgePrivateKey', 'profilesBadgePassphrase']) {
    assert.ok(text.includes(dict(key)), `credential badges must render (${key})`)
  }
  // Always-visible row actions: all five are rendered without hovering.
  for (const key of ['profilesConnect', 'profilesEdit', 'profilesRename', 'profilesMove', 'profilesDelete']) {
    assert.ok(findButtonByTitle(`${dict(key)} prod-web`), `profile rows must always show the ${key} action`)
  }
  const newConnection = findButtonByText(dict('profilesNewConnection'))
  assert.ok(newConnection, 'the library header must always offer 新建连接')
  assert.ok(String(newConnection.props.style.background || '').includes('button-primary-fill'), '新建连接 must be the primary action')
  const folderIndex = text.indexOf('Prod')
  const ungroupedIndex = text.indexOf(dict('profilesUngrouped'))
  assert.ok(folderIndex >= 0, 'named folder sections must render')
  assert.ok(ungroupedIndex > folderIndex, 'the ungrouped section must come last')
}

// A folder created in the panel is offered by the move picker right away.
{
  const folderInput = findInput((props) => props['aria-label'] === dict('profilesNewFolderPlaceholder'))
  assert.ok(folderInput, 'the new-folder input must render')
  await setInput(folderInput, 'Team', 'new folder')
  await clickNode(findButtonByTitle(dict('profilesCreateFolder')), 'create folder')
  assert.ok(textOf(lastTree).includes(fmtLike('profilesFolderAdded', { name: 'Team' })), 'creating a folder must toast')
  await clickNode(findButtonByTitle(`${dict('profilesMove')} prod-web`), 'move profile')
  const option = findNode((node) => node.type === 'option' && textOf(node) === 'Team')
  assert.ok(option, 'a folder created in the panel must appear in the move picker')
  await clickNode(findButtonByTitle(`${dict('profilesRenameCancel')} prod-web`), 'cancel move')
}

// 重命名 → profiles.rename { id, name }
scene.handlers.set('profiles.rename', async (params) => {
  const index = profilesState.findIndex((profile) => profile.id === params.id)
  if (index >= 0) profilesState[index] = { ...profilesState[index], name: params.name }
  return { profile: profilesState[index] }
})
await clickNode(findButtonByTitle(`${dict('profilesRename')} prod-web`), 'rename profile')
{
  const input = findInput((props) => props.value === 'prod-web')
  assert.ok(input, 'the rename input must be prefilled with the current name')
  await setInput(input, 'prod-web-2', 'rename input')
}
await clickNode(findButtonByTitle(`${dict('profilesRenameSave')} prod-web`), 'save rename')
{
  const callsForRename = scene.rpcCalls.filter((call) => call.method === 'profiles.rename')
  const last = callsForRename[callsForRename.length - 1]
  assert.ok(last, 'profiles.rename must be called')
  assert.deepEqual(last.params, { id: 'p-1', name: 'prod-web-2' })
  const text = textOf(lastTree)
  assert.ok(text.includes('prod-web-2'), 'the list must reload with the new name')
  assert.ok(text.includes(dict('profilesRenamed')), 'renaming must toast')
}

// A Host failure is shown verbatim and the panel keeps the last good list.
scene.handlers.set('profiles.rename', async () => ({
  __hostError: { code: 'BAD_NAME', message: 'a profile name must not be empty' },
}))
await clickNode(findButtonByTitle(`${dict('profilesRename')} prod-web-2`), 'rename profile that fails')
await setInput(findInput((props) => props.value === 'prod-web-2'), 'still-prod', 'rename input')
await clickNode(findButtonByTitle(`${dict('profilesRenameSave')} prod-web-2`), 'save failing rename')
{
  const text = textOf(lastTree)
  assert.ok(text.includes('a profile name must not be empty'), 'Host error text must be shown verbatim')
  assert.ok(text.includes('prod-web-2'), 'the last good list must survive a failed rename')
}

// 移动到分组 → profiles.setFolder { id, folder } (existing folder, ungrouped, new folder)
scene.handlers.set('profiles.setFolder', async (params) => {
  const index = profilesState.findIndex((profile) => profile.id === params.id)
  if (index >= 0) profilesState[index] = { ...profilesState[index], folder: params.folder }
  return { profile: profilesState[index] }
})
async function moveProfile(name, choice, typedFolder) {
  await clickNode(findButtonByTitle(`${dict('profilesMove')} ${name}`), 'move profile')
  const picker = findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === `${dict('profilesMove')} ${name}`)
  assert.ok(picker, 'the move picker must render')
  await setInput(picker, choice, 'move folder')
  if (choice === '__new__') {
    const input = findInput((props) => props['aria-label'] === `${dict('folderName')} ${name}`)
    assert.ok(input, 'the move picker must offer a folder-name input')
    await setInput(input, typedFolder, 'move folder name')
  }
  await clickNode(findButtonByTitle(`${dict('profilesRenameSave')} ${name}`), 'confirm move')
  const callsForMove = scene.rpcCalls.filter((call) => call.method === 'profiles.setFolder')
  return callsForMove[callsForMove.length - 1]
}

{
  const call = await moveProfile('prod-web-2', 'Prod', '')
  assert.deepEqual(call.params, { id: 'p-1', folder: 'Prod' }, 'moving to an existing folder')

  const ungroup = await moveProfile('prod-web-2', '', '')
  assert.deepEqual(ungroup.params, { id: 'p-1', folder: '' }, 'ungrouping sends an empty folder')

  const created = await moveProfile('prod-web-2', '__new__', 'Ops')
  assert.deepEqual(created.params, { id: 'p-1', folder: 'Ops' }, 'moving into a new folder')
  assert.ok(textOf(lastTree).includes('Ops'), 'the new folder section must render')
  assert.ok(textOf(lastTree).includes(dict('profilesMoved')), 'moving must toast')
}

// 删除 → profiles.delete { id }, guarded by a second confirmation click.
scene.handlers.set('profiles.delete', async (params) => {
  const index = profilesState.findIndex((profile) => profile.id === params.id)
  if (index >= 0) profilesState.splice(index, 1)
  return { ok: true }
})
{
  const deletesBefore = scene.rpcCalls.filter((call) => call.method === 'profiles.delete').length
  await clickNode(findButtonByTitle(`${dict('profilesDelete')} prod-web-2`), 'delete profile')
  // Inline confirmation bar, not a timed second click.
  assert.ok(
    textOf(lastTree).includes(fmtLike('profilesDeletePrompt', { name: 'prod-web-2' })),
    'delete must ask with an inline confirmation',
  )
  assert.ok(findNode((node) => node.props && node.props.role === 'alertdialog'), 'the confirmation must be an alertdialog')
  assert.equal(
    scene.rpcCalls.filter((call) => call.method === 'profiles.delete').length,
    deletesBefore,
    'the first click must not delete',
  )
  // Cancel keeps the row and removes the question.
  await clickNode(findButtonByText(dict('cancel')), 'cancel delete')
  assert.ok(!textOf(lastTree).includes(fmtLike('profilesDeletePrompt', { name: 'prod-web-2' })), 'cancel must close the confirmation')
  assert.ok(textOf(lastTree).includes('prod-web-2'), 'cancel must keep the profile')
  // Confirm in place.
  await clickNode(findButtonByTitle(`${dict('profilesDelete')} prod-web-2`), 'delete profile again')
  await clickNode(findButtonByText(dict('profilesDeleteConfirm')), 'confirm delete')
  const callsForDelete = scene.rpcCalls.filter((call) => call.method === 'profiles.delete')
  assert.equal(callsForDelete.length, 1)
  assert.deepEqual(callsForDelete[0].params, { id: 'p-1' })
  assert.ok(textOf(lastTree).includes(dict('profilesDeleteDone')), 'deleting must toast')
  assert.ok(!textOf(lastTree).includes('prod-web-2'), 'the deleted profile must disappear')
}
await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 11 — connect form: the 分组 selector travels with profiles.save.
 * ------------------------------------------------------------------ */

scene.handlers.set('profiles.list', async () => ({
  profiles: [{
    id: 'p-9', name: 'saved', transport: 'ssh', host: '10.1.1.1', port: 22, username: 'ops',
    authType: 'password', hasPassword: true, hasPrivateKey: false, hasPassphrase: false,
    folder: 'Prod', order: 0, updatedAt: now,
  }],
  folders: [{ name: 'Prod', count: 1 }],
}))

async function openConnectForm() {
  await clickNode(findButtonByTitle(dict('newSession')), 'new session')
  assert.ok(findNode((node) => node.type === 'form'), 'the connect form must render')
}async function fillTarget(host, username) {
  await setInput(findInput((props) => props.placeholder === '10.0.0.5'), host, 'host')
  await setInput(findInput((props) => props.placeholder === 'root'), username, 'username')
}

async function enableSaveProfile(name) {
  await toggleCheckbox(findInput((props) => props.type === 'checkbox'), true, 'save profile')
  await setInput(findInput((props) => props['aria-label'] === dict('profileName')), name, 'profile name')
}

scene.handlers.set('sessions.create', async () => ({ session: sessionRecord() }))

await openConnectForm()
await fillTarget('10.2.2.2', 'ops')
await enableSaveProfile('folder-new')
await setInput(
  findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('folder')),
  'Prod',
  'profile folder',
)
await clickNode(findButtonByText(dict('connectAction')), 'connect with folder')
{
  const callsForSave = scene.rpcCalls.filter((call) => call.method === 'profiles.save')
  const last = callsForSave[callsForSave.length - 1]
  assert.ok(last, 'saving a profile must call profiles.save')
  assert.equal(last.params.profile.name, 'folder-new')
  assert.equal(last.params.profile.folder, 'Prod', 'the 分组 selector must reach profiles.save')
  assert.equal(last.params.profile.id, undefined, 'a new profile must not carry an id')
  assert.equal(last.params.profile.password, undefined, 'an empty secret field must be omitted')
}

// 新建分组 inside the form.
await openConnectForm()
await fillTarget('10.3.3.3', 'ops')
await enableSaveProfile('folder-ops')
await setInput(
  findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('folder')),
  '__new__',
  'profile folder',
)
await setInput(
  findInput((props) => props['aria-label'] === dict('folderName')),
  'Ops2',
  'new folder name',
)
await clickNode(findButtonByText(dict('connectAction')), 'connect with new folder')
{
  const callsForSave = scene.rpcCalls.filter((call) => call.method === 'profiles.save')
  const last = callsForSave[callsForSave.length - 1]
  assert.equal(last.params.profile.folder, 'Ops2', 'a folder typed in the form must reach profiles.save')
}

/* ------------------------------------------------------------------ *
 * Scenario 12 — editing an existing profile keeps its id and stored secrets.
 * ------------------------------------------------------------------ */

scene.handlers.set('profiles.list', async () => ({
  profiles: profilesState.map((profile) => ({ ...profile })),
  folders: folderOverviewOf(profilesState),
}))
scene.handlers.set('profiles.save', async (params) => ({ profile: { ...params.profile } }))
await openPanelViaBar('profiles')
await clickNode(findButtonByTitle(`${dict('profilesEdit')} prod-db`), 'edit profile')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('profilesEditTitle')), 'editing must open the connect form in edit mode')
  assert.ok(text.includes(dict('profilesEditHint')), 'edit mode must explain blank secrets')
  assert.equal(findDialog(), null, 'the profiles overlay must close when editing')
  assert.ok(findInput((props) => props.value === '10.0.0.7'), 'the host field must be prefilled')
  assert.ok(findNode((node) => node.type === 'select' && node.props && node.props.value === 'privateKey'), 'the auth type must be prefilled')
  assert.ok(findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('folder') && node.props.value === 'Prod'), 'the folder must be prefilled')
  const nameInput = findInput((props) => props['aria-label'] === dict('profileName'))
  assert.equal(nameInput.props.value, 'prod-db', 'the profile name must be prefilled')
  await setInput(nameInput, 'prod-db-2', 'edit profile name')
}
await clickNode(findButtonByText(dict('profilesSaveAction')), 'save profile edit')
{
  const saves = scene.rpcCalls.filter((call) => call.method === 'profiles.save')
  const last = saves[saves.length - 1]
  assert.ok(last, 'saving an edit must call profiles.save')
  assert.equal(last.params.profile.id, 'p-3', 'editing must preserve the profile id')
  assert.equal(last.params.profile.name, 'prod-db-2')
  assert.equal(last.params.profile.folder, 'Prod', 'editing must preserve the folder')
  assert.equal(last.params.profile.password, undefined, 'a blank password means keep the stored one')
  assert.equal(last.params.profile.privateKey, undefined, 'a blank private key means keep the stored one')
  assert.equal(last.params.profile.passphrase, undefined, 'a blank passphrase means keep the stored one')
  assert.ok(textOf(lastTree).includes(dict('profilesSaved')), 'saving an edit must toast')
  const savesBefore = saves.length
  assert.equal(findNode((node) => node.type === 'form'), null, 'saving an edit must leave the form')
  // ← from the editor returns to the library it was opened from, not the terminal.
  assert.ok(findDialog(), 'saving an edit must return to the profile library')
  const stack = sandbox.__DSH_AITERM_CLIENT__.internals.getState().viewStack
  assert.equal(stack[stack.length - 1].kind, 'panel', 'the profile library must be the visible view again')
  const savedRow = findNode((node) => node.props && node.props['data-profile-id'] === 'p-3')
  assert.ok(savedRow, 'the saved profile must be back in the list')
  assert.ok(String(savedRow.props.style.borderColor || '').includes('brand-primary'), 'the saved row must be highlighted')
  // The form closing must not fire another save.
  assert.equal(scene.rpcCalls.filter((call) => call.method === 'profiles.save').length, savesBefore)
}

/* ------------------------------------------------------------------ *
 * Scenario 13 — connecting from the profiles panel uses the profile id.
 * ------------------------------------------------------------------ */

scene.handlers.set('sessions.create', async () => ({
  session: sessionRecord({ id: 'st-2', title: '10.0.0.9:23', transport: 'telnet', host: '10.0.0.9', port: 23, username: '' }),
}))
scene.handlers.set('profiles.list', async () => ({
  profiles: profilesState.map((profile) => ({ ...profile })),
  folders: folderOverviewOf(profilesState),
}))
await openPanelViaBar('profiles')
scene.handlers.set('sessions.create', async () => ({
  __hostError: { code: 'MISSING_SECRET', message: 'this profile has no saved password' },
}))
await clickNode(findButtonByTitle(`${dict('profilesConnect')} lab`), 'failed connect from profiles')
{
  const text = textOf(lastTree)
  assert.ok(text.includes('this profile has no saved password'), 'connect failures must show the Host message verbatim')
  assert.ok(findDialog(), 'a failed connect must keep the profiles panel open')
}
scene.handlers.set('sessions.create', async () => ({
  session: sessionRecord({ id: 'st-2', title: '10.0.0.9:23', transport: 'telnet', host: '10.0.0.9', port: 23, username: '' }),
}))
await clickNode(findButtonByTitle(`${dict('profilesConnect')} lab`), 'connect from profiles')
{
  const creates = scene.rpcCalls.filter((call) => call.method === 'sessions.create')
  const last = creates[creates.length - 1]
  assert.ok(last, 'connecting from the panel must call sessions.create')
  assert.equal(last.params.profileId, 'p-2', 'the saved profile id must be sent')
  assert.equal(last.params.transport, 'telnet')
  assert.equal(last.params.host, '10.0.0.9')
  assert.equal(last.params.password, undefined, 'the panel never sends secrets')
  assert.equal(findDialog(), null, 'connecting must close the profiles panel')
  assert.ok(textOf(lastTree).includes('10.0.0.9:23'), 'the new session must be selected')
}

/* ------------------------------------------------------------------ *
 * Scenario 14 — script editor: templates, structural validation with exact
 * paths, folder grouping and nested run progress.
 * ------------------------------------------------------------------ */

await setSessions([sessionRecord()])
// Loading state, then the empty list the editor starts from.
{
  let resolveList = null
  scene.handlers.set('scripts.list', () => new Promise((resolve) => {
    resolveList = resolve
  }))
  await openPanelViaBar('scripts')
  assert.ok(textOf(lastTree).includes(dict('scriptsLoading')), 'the scripts panel must show a loading state')
  resolveList({ scripts: [] })
  await settle('script list loaded')
  assert.ok(textOf(lastTree).includes(dict('scriptsEmpty')), 'the empty state must replace the loading state')
  await closePanelViaBar()
}
scene.handlers.set('scripts.list', async () => ({ scripts: [] }))
await openPanelViaBar('scripts')
// Step templates are JSON skeletons, so this is the 高级脚本 path.
await createScript('json')
{
  const templateSelect = findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsTemplate'))
  assert.ok(templateSelect, 'the template dropdown must render')
  await setInput(templateSelect, 'if', 'insert if template')
}
{
  const editor = findNode((node) => node.type === 'textarea')
  const parsed = JSON.parse(editor.props.value)
  assert.equal(parsed.steps.length, 1, 'the if template must append one step')
  assert.ok(parsed.steps[0].if, 'the if template must carry a condition')
  assert.ok(Array.isArray(parsed.steps[0].then) && parsed.steps[0].then.length > 0, 'the if template must carry then steps')
  assert.ok(Array.isArray(parsed.steps[0].else) && parsed.steps[0].else.length > 0, 'the if template must carry else steps')
}
await setInput(
  findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsTemplate')),
  'loop',
  'insert loop template',
)
{
  const editor = findNode((node) => node.type === 'textarea')
  const parsed = JSON.parse(editor.props.value)
  assert.equal(parsed.steps.length, 2, 'templates must append, not replace')
  assert.ok(parsed.steps[1].loop && parsed.steps[1].loop.count >= 1, 'the loop template must carry a count')
  assert.ok(Array.isArray(parsed.steps[1].steps) && parsed.steps[1].steps.length > 0, 'the loop template must carry steps')
}

// Every template produces a valid skeleton; the combined program saves as-is.
for (const templateId of ['send', 'delay', 'set', 'expect', 'log']) {
  await setInput(
    findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsTemplate')),
    templateId,
    `insert ${templateId} template`,
  )
}
{
  const editor = findNode((node) => node.type === 'textarea')
  const parsed = JSON.parse(editor.props.value)
  assert.equal(parsed.steps.length, 7, 'all seven templates must append a step')
  const kinds = parsed.steps.map((step) => ['send', 'delay', 'set', 'log', 'expect', 'if', 'loop']
    .find((kind) => step[kind] !== undefined))
  for (const kind of ['send', 'delay', 'set', 'log', 'expect', 'if', 'loop']) {
    assert.ok(kinds.includes(kind), `the ${kind} template must insert a valid skeleton`)
  }
}
scene.handlers.set('scripts.save', async (params) => ({ script: { name: 'templates', description: '', folder: '', params: {}, stepCount: params.script.steps.length, updatedAt: now } }))
// The saved script is listed afterwards (the Host does that); the master-detail
// editor then keeps it selected instead of closing as the old modal editor did.
scene.handlers.set('scripts.list', async () => ({ scripts: [{ name: 'templates', description: '', folder: '', params: {}, stepCount: 7, updatedAt: now }] }))
scene.handlers.set('scripts.get', async (params) => ({
  script: { name: params.name, description: '', folder: '', params: {}, steps: Array.from({ length: 7 }, (_, index) => ({ log: `step-${index}` })) },
}))
await setInput(nameField(), 'templates', 'script name')
const templateSaveMark = scene.rpcCalls.length
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save template program')
{
  const saves = scene.rpcCalls.slice(templateSaveMark).filter((call) => call.method === 'scripts.save')
  const last = saves[saves.length - 1]
  assert.ok(last, 'a program built from templates must save')
  assert.equal(last.params.script.steps.length, 7, 'all seven templates must reach the Host')
  assert.ok(findNode((node) => node.type === 'textarea'), 'the saved program must stay open in the editor')
  assert.equal(
    findInput((props) => props['aria-label'] === dict('scriptsName')).props.value,
    'templates',
    'the saved program must be the selected one',
  )
}
// The structural-validation cases below feed JSON programs: create an
// advanced script so the editor is already in that dialect.
await createScript('json')
assert.ok(findNode((node) => node.type === 'textarea'), 'the editor must reopen')

const saveCalls = () => scene.rpcCalls.filter((call) => call.method === 'scripts.save').length

async function expectValidationError(program, path, key, params) {
  const before = saveCalls()
  await setInput(scriptEditor(), JSON.stringify(program), 'invalid program')
  await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save invalid program')
  const expected = fmtLike('scriptsValidateAt', {
    path,
    message: fmtLike(key, params || {}),
  })
  assert.ok(
    textOf(lastTree).includes(expected),
    `validation must report "${expected}"`,
  )
  assert.equal(saveCalls(), before, 'an invalid program must not reach the Host')
}

await expectValidationError({ name: 'bad', steps: [{ bogus: 1 }] }, 'steps[0]', 'vUnknownKind', { kind: 'bogus' })
await expectValidationError({ name: 'bad', steps: [{ if: { always: true } }] }, 'steps[0]', 'vIfThen')
await expectValidationError(
  { name: 'bad', steps: [{ send: 'a' }, { send: 'b' }, { if: { always: true }, then: [{ nope: 1 }] }] },
  'steps[2].then[0]',
  'vUnknownKind',
  { kind: 'nope' },
)
await expectValidationError(
  { name: 'bad', steps: [{ loop: {}, steps: [{ log: 'x' }] }] },
  'steps[0]',
  'vLoopCond',
)
await expectValidationError(
  { name: 'bad', steps: [{ loop: { count: 0 }, steps: [{ log: 'x' }] }] },
  'steps[0].loop.count',
  'vLoopCount',
  { max: 1000 },
)
await expectValidationError(
  { name: 'bad', steps: [{ expect: { match: '[' } }] },
  'steps[0].expect.match',
  'vConditionRegex',
)

const nestedProgram = {
  name: 'nested',
  description: '',
  folder: 'Ops',
  params: {},
  steps: [
    {
      loop: { count: 2 },
      steps: [
        { send: 'echo hi', enter: true },
        { if: { contains: 'hi' }, then: [{ log: 'saw hi' }] },
      ],
    },
  ],
}
scene.handlers.set('scripts.save', async () => ({
  script: { name: 'nested', description: '', folder: 'Ops', params: {}, stepCount: 4, updatedAt: now },
}))
scene.handlers.set('scripts.list', async () => ({
  scripts: [
    { name: 'nested', description: '', folder: 'Ops', params: {}, stepCount: 4, updatedAt: now },
    { name: 'loose', description: 'loose script', folder: '', params: { iface: { default: 'eth0' } }, stepCount: 1, updatedAt: now },
  ],
}))
await setInput(scriptEditor(), JSON.stringify(nestedProgram), 'nested program')
await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save nested program')
{
  const saves = scene.rpcCalls.filter((call) => call.method === 'scripts.save')
  const last = saves[saves.length - 1]
  assert.equal(last.params.script.name, 'nested')
  assert.equal(last.params.script.folder, 'Ops', 'a script folder must survive the editor')
  assert.equal(last.params.script.steps[0].loop.count, 2)
  assert.ok(Array.isArray(last.params.script.steps[0].steps), 'nested steps must be saved verbatim')
  const text = textOf(lastTree)
  // Master-detail scopes the list to the saved script's folder; other folders
  // stay reachable through the 分组 picker (that is the 未分组 entry below).
  assert.ok(text.includes('Ops'), 'the folder scope must follow the saved script')
  const scopeSelect = findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsFolderScope'))
  assert.ok(scopeSelect, 'the folder scope picker must render')
  assert.equal(scopeSelect.props.value, 'Ops', 'the list must be scoped to the saved folder')
  assert.ok(
    collect(scopeSelect, (node) => node.type === 'option').some((option) => option.props.value === ''),
    'the folder picker must still offer 未分组',
  )
  assert.ok(text.includes(fmtLike('scriptsSteps', { count: 4 })), 'each row must show its step count')
  assert.ok(findNode((node) => node.type === 'textarea'), 'the saved script must stay open in the editor')
}

let resolveNestedRun = null
scene.handlers.set('scripts.run', () => new Promise((resolve) => {
  resolveNestedRun = resolve
}))
await clickNode(findButtonByText(dict('scriptsRun')), 'run nested script')
const nestedBatchId = 'batch-nested'
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'step', sessionId: 'st-1', stepIndex: 0, depth: 0, path: '0', kind: 'loop', ok: true, text: 'loop start' })
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'step', sessionId: 'st-1', stepIndex: 1, depth: 1, path: '0.1', kind: 'send', ok: true, text: 'tick 1' })
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'step', sessionId: 'st-1', stepIndex: 1, depth: 1, path: '0.1', kind: 'send', ok: true, text: 'tick 2' })
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'step', sessionId: 'st-1', stepIndex: 2, depth: 2, path: '0.1.1', kind: 'if', ok: true, text: 'branch' })
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'step', sessionId: 'st-1', stepIndex: 1, depth: 1, path: '0.2', kind: 'expect', ok: false, error: 'expect failed', code: 'EXPECT_FAILED' })
{
  const texts = nodeTexts(lastTree)
  assert.ok(texts.includes('0'), 'the top-level path must render')
  assert.equal(texts.filter((entry) => entry === '  0.1').length, 2, 'loop iterations must visibly repeat, indented by depth')
  assert.ok(texts.includes('    0.1.1'), 'nested steps must be indented by two spaces per depth level')
  const flat = textOf(lastTree)
  for (const key of ['kindLoop', 'kindSend', 'kindIf', 'kindExpect']) {
    assert.ok(flat.includes(dict(key)), `progress rows must label the step kind (${key})`)
  }
  assert.ok(flat.includes('tick 1') && flat.includes('tick 2'), 'each iteration keeps its own text')
  assert.ok(flat.includes('expect failed'), 'a failed nested step must show its error')
  assert.ok(flat.includes('✓') && flat.includes('✗'), 'progress must show success and failure glyphs')
  const first = texts.indexOf('0')
  const child = texts.indexOf('  0.1')
  const grandchild = texts.indexOf('    0.1.1')
  const sibling = texts.indexOf('  0.2')
  assert.ok(first >= 0 && first < child && child < grandchild && grandchild < sibling, 'progress rows must keep execution order')
}
resolveNestedRun({
  result: {
    ok: false,
    timedOut: false,
    runs: [{ sessionId: 'st-1', ok: false, steps: [{ index: 0, depth: 0, path: '0', kind: 'loop', ok: true }] }],
  },
})
await settle('nested run resolved')
await emitBatch({ type: 'batch', batchId: nestedBatchId, label: 'script:nested', state: 'done', sessionId: 'st-1', stepIndex: 0, ok: true })
{
  const text = textOf(lastTree)
  assert.ok(text.includes(fmtLike('scriptsRunSummary', { runs: 1, ok: 0 })), 'the nested run summary must render')
  const runButton = findButtonByText(dict('scriptsRun'))
  assert.ok(runButton, 'the run button must be re-enabled after a nested run')
  assert.notEqual(runButton.props.disabled, true)
}
await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 15 — scripts.get seeds the editor, and clearing the steps of an
 * existing script needs an explicit second confirmation (§14.5).
 * ------------------------------------------------------------------ */

const fullDefinition = {
  name: 'demo-full',
  description: 'full definition',
  folder: 'Ops',
  params: { target: { default: 'eth0', description: 'interface' } },
  steps: [
    { send: 'uptime', enter: true },
    { if: { contains: 'load' }, then: [{ log: 'busy' }], else: [{ log: 'idle' }] },
  ],
}
const fullSummary = {
  name: 'demo-full',
  description: 'full definition',
  folder: 'Ops',
  params: { target: { default: 'eth0', description: 'interface' } },
  stepCount: 4,
  updatedAt: now,
}
const scriptSaveCount = () => scene.rpcCalls.filter((call) => call.method === 'scripts.save').length
const scriptGetCount = () => scene.rpcCalls.filter((call) => call.method === 'scripts.get').length

scene.handlers.set('scripts.list', async () => ({ scripts: [fullSummary] }))
scene.handlers.set('scripts.get', async (params) => {
  assert.equal(params.name, 'demo-full', 'scripts.get must carry the name')
  return { script: fullDefinition }
})
const getsBeforeScenario15 = scriptGetCount()
await openPanelViaBar('scripts')
{
  const text = textOf(lastTree)
  assert.ok(
    text.includes(fmtLike('scriptsSteps', { count: 4 })),
    'the list must label the recursive step count',
  )
  assert.ok(dictZh.scriptsSteps.includes('含嵌套'), 'the zh step label must say the count includes nested steps')
  assert.ok(dictEn.scriptsSteps.includes('incl. nested'), 'the en step label must say the count includes nested steps')
}

{
  // Selecting a script is what opens it now: the panel auto-loads the detail.
  assert.equal(scriptGetCount(), getsBeforeScenario15 + 1, 'selecting a script must call scripts.get for its definition')
  const editor = findNode((node) => node.type === 'textarea')
  assert.ok(editor, 'the editor must open once the definition arrived')
  const parsed = JSON.parse(editor.props.value)
  assert.equal(parsed.name, 'demo-full')
  assert.equal(parsed.description, 'full definition')
  assert.equal(parsed.folder, 'Ops')
  assert.deepEqual(parsed.params, { target: { default: 'eth0', description: 'interface' } })
  assert.equal(parsed.steps.length, 2, 'the editor must be seeded with the real steps')
  assert.equal(parsed.steps[0].send, 'uptime', 'top-level steps must be seeded')
  assert.equal(parsed.steps[1].then[0].log, 'busy', 'nested then steps must be seeded')
  assert.equal(parsed.steps[1].else[0].log, 'idle', 'nested else steps must be seeded')
  assert.equal(parsed.updatedAt, undefined, 'Host-managed fields must not leak into the editor')
}

// Clearing the steps of an existing script warns and waits for a second click.
{
  const savesBefore = scriptSaveCount()
  const editor = findNode((node) => node.type === 'textarea')
  await setInput(
    editor,
    JSON.stringify({ name: 'demo-full', description: 'full definition', folder: 'Ops', params: {}, steps: [] }),
    'clear steps',
  )
  await clickNode(findButtonByText(dict('scriptsSaveAction')), 'save empty program')
  const text = textOf(lastTree)
  assert.ok(
    text.includes(fmtLike('scriptsEmptySaveWarn', { count: 4 })),
    'clearing the steps of a seeded script must warn inline',
  )
  assert.equal(scriptSaveCount(), savesBefore, 'the first click must not save the empty program')
  assert.ok(findButtonByText(dict('scriptsEmptySaveConfirm')), 'an explicit confirm button must appear')
}

scene.handlers.set('scripts.save', async (params) => ({
  script: { ...fullSummary, stepCount: Array.isArray(params.script.steps) ? params.script.steps.length : 0 },
}))
scene.handlers.set('scripts.list', async () => ({ scripts: [{ ...fullSummary, stepCount: 0 }] }))
await clickNode(findButtonByText(dict('scriptsEmptySaveConfirm')), 'confirm empty save')
{
  const saves = scene.rpcCalls.filter((call) => call.method === 'scripts.save')
  const last = saves[saves.length - 1]
  assert.ok(last, 'the confirmed second click must save')
  assert.deepEqual(last.params.script.steps, [], 'the confirmed payload carries the empty program')
  assert.ok(textOf(lastTree).includes(dict('scriptsSaved')), 'the confirmed save must toast')
}

// A failing scripts.get is shown verbatim and never opens the editor.
scene.handlers.set('scripts.get', async () => ({
  __hostError: { code: 'SCRIPT_NOT_FOUND', message: 'script demo-full does not exist' },
}))
{
  const getsBefore = scriptGetCount()
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  assert.equal(scriptGetCount(), getsBefore + 1, 'selecting a script must still call scripts.get')
  assert.ok(
    textOf(lastTree).includes(fmtLike('scriptsGetFailed', { message: 'script demo-full does not exist' })),
    'scripts.get failures must show the Host message verbatim',
  )
  assert.equal(findNode((node) => node.type === 'textarea'), null, 'a failed scripts.get must not open the editor')
}

// 新建 opens a dialect chooser and never calls scripts.get.
scene.handlers.set('scripts.list', async () => ({ scripts: [] }))
await closePanelViaBar()
await openPanelViaBar('scripts')
{
  const getsBefore = scriptGetCount()
  await clickNode(findButtonByText('+ ' + dict('scriptsNewAction')), 'open the chooser')
  assert.ok(findNode((node) => node.props && node.props.role === 'menu'), 'the chooser must open')
  assert.equal(scriptGetCount(), getsBefore, 'creating must not call scripts.get')
  await createScript('macro')
  await settle('command draft opened')
  const editor = findNode((node) => node.type === 'textarea')
  assert.ok(editor, 'the command draft must open an editor')
  assert.ok(String(editor.props.value).startsWith('#'), 'it starts from the per-line starter text')
  assert.ok(String(editor.props.value).includes('uname -a'), 'the starter shows an example command')
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel new script')
}
await closePanelViaBar()

/* ------------------------------------------------------------------ *
 * Scenario 17 — macro dialect and the quick-script bar.
 *
 * Regression (user report): the JSON editor was hard to use, and quick
 * scripts had no place in the terminal view at all.
 * ------------------------------------------------------------------ */

{
  // ── macro → steps, including the Python heredoc sugar ──────────────────
  const { parseMacro, serializeMacro } = await import('../client/macroLang.js')

  const simple = parseMacro('ls -l\n@wait 2s\n@log start\n@set name = box1\n@expect continue ready')
  assert.equal(simple.ok, true, 'a valid macro must compile: ' + JSON.stringify(simple))
  assert.equal(simple.steps.length, 5, 'one step per line')
  assert.deepEqual(simple.steps[0], { send: 'ls -l', enter: true })
  assert.deepEqual(simple.steps[1], { delay: 2000 }, 'a duration suffix must be honoured')
  assert.deepEqual(simple.steps[2], { log: 'start' })
  assert.deepEqual(simple.steps[3], { set: 'name', value: 'box1' })
  assert.deepEqual(simple.steps[4], { expect: { match: 'ready' }, onFail: 'continue' })

  const waiting = parseMacro('uptime', { waitAfterSend: true, idleMs: 300, timeoutMs: 9000 })
  assert.deepEqual(waiting.steps[0], { send: 'uptime', enter: true, waitFor: { idleMs: 300, timeoutMs: 9000 } })

  const python = parseMacro("@python\nprint('hi')\n@end")
  assert.equal(python.ok, true, 'the python block must compile')
  assert.equal(python.steps[0].send, "python3 - <<'PY'", 'python runs on the remote shell, not locally')
  assert.equal(python.steps[1].send, "print('hi')")
  assert.equal(python.steps[2].send, 'PY')

  assert.equal(parseMacro('@nope 1').ok, false, 'an unknown directive must be rejected')
  assert.equal(parseMacro('@wait soon').ok, false, 'a bad duration must be rejected')
  assert.equal(parseMacro('  # only comments  ').ok, false, 'a comment-only script has no steps')

  const roundTrip = serializeMacro(simple.steps)
  assert.equal(roundTrip.ok, true, 'macro steps must serialize back: ' + JSON.stringify(roundTrip))
  assert.ok(roundTrip.text.includes('ls -l') && roundTrip.text.includes('@wait 2000'))
  assert.equal(
    serializeMacro([{ if: { always: true }, then: [{ send: 'x' }] }]).ok,
    false,
    'structured steps are JSON-only, so serialization must refuse them',
  )

  // ── quick-script bar: grouped chips, one click runs ───────────────────
  await setSessions([sessionRecord()])
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  await closePanelViaBar()

  scene.handlers.set('scripts.list', async () => ({
    scripts: [
      { name: 'uptime', description: '', folder: '巡检', params: {}, stepCount: 1, updatedAt: now },
      { name: 'disk', description: '', folder: '', params: {}, stepCount: 2, updatedAt: now },
    ],
  }))
  scene.handlers.set('scripts.run', async () => ({ result: { ok: true, timedOut: false, runs: [{ sessionId: 'st-1', ok: true }] } }))

  await clickNode(findButtonByText(dict('quickScriptsShow')), 'open quick scripts')
  await settle('quick scripts loaded')
  {
    const text = textOf(lastTree)
    assert.ok(text.includes('uptime'), 'quick chips must list saved scripts')
    assert.ok(text.includes('disk'), 'ungrouped scripts must show too')
    assert.ok(text.includes('巡检'), 'the folder name must label its group')
  }

  const runMark = scene.rpcCalls.length
  await clickNode(findButtonByText('uptime'), 'run quick script')
  {
    const runCall = scene.rpcCalls.slice(runMark).find((call) => call.method === 'scripts.run')
    assert.ok(runCall, 'a quick chip must call scripts.run')
    assert.equal(runCall.params.name, 'uptime')
    assert.equal(runCall.params.sessionId, 'st-1', 'a quick chip runs against the current session')
    assert.deepEqual(runCall.params.params, {}, 'defaults apply when a chip is clicked')
  }
  assert.ok(textOf(lastTree).includes(dict('quickScriptsDone').split('{')[0]), 'a successful run must toast')
}

/* ------------------------------------------------------------------ *
 * Scenario 18 — script management affordances.
 *
 * Regression (user report): 「我没看到如何管理目录」「快捷脚本没看到如何管理文件夹的可见性」
 * 「运行结果占用空间有点大」. Covers: 名称/分组 fields, folder rename/delete
 * actions, quick-bar folder visibility, and the collapsible run log.
 * ------------------------------------------------------------------ */

{
  const scriptsFixture = [
    { name: 'uptime', description: '', folder: '巡检', params: {}, stepCount: 1, updatedAt: now },
    { name: 'disk', description: '', folder: '巡检', params: {}, stepCount: 2, updatedAt: now },
    { name: 'loose', description: '', folder: '', params: {}, stepCount: 1, updatedAt: now },
  ]
  scene.handlers.set('scripts.list', async () => ({ scripts: scriptsFixture }))
  scene.handlers.set('scripts.get', async (params) => ({
    script: { name: params.name, description: '', folder: '巡检', params: {}, steps: [{ send: 'uptime' }] },
  }))

  await setSessions([sessionRecord()])
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  await settle('scripts listed')

  // ── 新建 asks for the dialect at click time ────────────────────────────
  assert.equal(findNode((n) => n.props && n.props.role === 'menu'), null, 'the dialect chooser must start closed')
  assert.ok(findButtonByText('+ ' + dict('scriptsNewAction')), '新建 must live with the list')
  await clickNode(findButtonByText('+' + ' ' + dict('scriptsNewAction')), 'open the chooser')
  {
    const menu = findNode((n) => n.props && n.props.role === 'menu')
    assert.ok(menu, 'the chooser must open on click')
    const labels = collect(menu, (node) => node.type === 'button').map((node) => textOf(node))
    assert.ok(labels.some((text) => text.includes(dict('scriptsModeMacro'))), 'the chooser must offer 逐行命令')
    assert.ok(labels.some((text) => text.includes(dict('scriptsModeJson'))), 'the chooser must offer JSON')
  }
  // close it again so the later createScript() helper opens it itself
  await clickNode(findButtonByText('+ ' + dict('scriptsNewAction')), 'close the chooser')

  // ── folder management on the group header ─────────────────────────────
  assert.ok(findButtonByText(dict('scriptsFolderRename')), 'a folder must be renameable')
  assert.ok(findButtonByText(dict('scriptsFolderDelete')), 'a folder must be deletable')

  // ── editor exposes 名称 and 分组 ────────────────────────────────────────
  await createScript('macro')
  assert.ok(findInput((props) => props['aria-label'] === dict('scriptsName')), 'the editor must expose 名称')
  {
    const folderSelect = findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsFolder'))
    assert.ok(folderSelect, 'the editor must expose 分组')
    assert.ok(
      collect(folderSelect, (node) => node.type === 'option').some((option) => option.props.value === '巡检'),
      'the 分组 picker must list existing folders',
    )
  }
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel editor')

  // ── quick bar: per-folder visibility ──────────────────────────────────
  await closePanelViaBar()
  // The bar keeps its open/closed state across scenarios: open it only if needed.
  if (!findButtonByText(dict('quickFolderVisibility'))) {
    const opener = findButtonByText(dict('quickScriptsShow'))
    assert.ok(opener, 'the collapsed quick bar must offer an opener')
    await clickNode(opener, 'open quick scripts')
    await settle('quick bar loaded')
  }
  assert.ok(findButtonByText(dict('quickFolderVisibility')), 'the quick bar must offer folder visibility')
  await clickNode(findButtonByText(dict('quickFolderVisibility')), 'open folder visibility')
  {
    const boxes = collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    assert.ok(boxes.length >= 2, 'one visibility checkbox per folder')
    const before = textOf(lastTree)
    assert.ok(before.includes('巡检'), 'the folder name must be listed in the visibility picker')
    await toggleCheckbox(boxes[0], false, 'hide first folder')
  }

  // ── run log collapses, with a 查看结果 button ──────────────────────────
  scene.handlers.set('scripts.run', () => new Promise((resolve) => {
    setTimeout(() => resolve({ result: { ok: true, timedOut: false, runs: [{ sessionId: 'st-1', ok: true }] } }), 5)
  }))
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  await settle('scripts listed again')
  {
    const runBtn = findButtonByText(dict('scriptsRun'))
    assert.ok(runBtn, 'the run button must render')
    await clickNode(runBtn, 'run script')
    await settle('run started')
  }
  await emitBatch({ type: 'batch', batchId: 'batch-18', label: 'script:uptime', state: 'step', sessionId: 'st-1', stepIndex: 0, ok: true, text: 'ok' })
  await settle('progress line')
  {
    // Live progress opens the floating results window automatically…
    assert.ok(textOf(lastTree).includes('ok'), 'live progress must be visible')
    const windowEl = findNode((node) => node.type === 'div' && node.props && node.props.role === 'dialog' && node.props['aria-label'] === dict('scriptsResultTitle'))
    assert.ok(windowEl, 'the run log must live in a floating results window')
    // …and closing that window removes the log from the panel completely (no
    // reserved blank block is left behind).
    await clickNode(findButtonByTitle(dict('scriptsResultClose')), 'close results window')
    await settle('results closed')
    assert.equal(
      findNode((node) => node.props && node.props.role === 'log'),
      null,
      'the panel must not keep an inline log after closing the window',
    )
    assert.ok(!textOf(lastTree).includes('ok'), 'closing the window must hide the log text')
    const expand = findButtonByText(dict('scriptsViewResult'))
    assert.ok(expand, 'the panel must keep a 查看结果 action')
    await clickNode(expand, 'reopen results window')
    await settle('results reopened')
    assert.ok(textOf(lastTree).includes('ok'), 'the log must return after reopening the window')
  }
  await emitBatch({ type: 'batch', batchId: 'batch-18', label: 'script:uptime', state: 'done', sessionId: 'st-1', stepIndex: 0, ok: true })
  await closePanelViaBar()
}

/* ------------------------------------------------------------------ *
 * Scenario 19 — master-detail editor: dialect highlight, local order,
 * duplicate, folder add and the floating results window.
 * ------------------------------------------------------------------ */

{
  const fixture = [
    { name: 'alpha', description: '', folder: '巡检', params: {}, stepCount: 1, updatedAt: now },
    { name: 'beta', description: '', folder: '巡检', params: {}, stepCount: 1, updatedAt: now },
    { name: 'gamma', description: '', folder: '巡检', params: {}, stepCount: 1, updatedAt: now },
  ]
  scene.handlers.set('scripts.list', async () => ({ scripts: fixture.map((entry) => ({ ...entry })) }))
  scene.handlers.set('scripts.get', async (params) => ({
    script: { name: params.name, description: '', folder: '巡检', params: {}, steps: [{ send: params.name }] },
  }))
  await setSessions([sessionRecord()])
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  await settle('master-detail listed')

  const rows = () => collect(lastTree, (node) => node.type === 'button' && node.props && node.props.role === 'option')
  const rowNames = () => rows().map((node) => node.props['aria-label'])
  assert.equal(rows().length, 3, 'the left column must list the scoped folder')
  assert.ok(findInput((props) => props['aria-label'] === dict('scriptsName')), 'the detail editor must be visible with the list')

  // ① The dialect is a selector now: picking a value and pressing 新建 must
  // create a draft of exactly that dialect.
  await createScript('json')
  assert.ok(String((findNode((n) => n.type === 'textarea') || { props: {} }).props.value || '').trim().startsWith('{'), '高级脚本 must open a JSON draft')
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel the draft')
  await createScript('macro')
  assert.ok(!String((findNode((n) => n.type === 'textarea') || { props: {} }).props.value || '').trim().startsWith('{'), '逐行命令 must open a text draft')
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel the draft')

  // ② ▲/▼ are local display order only (no Host order field): they must
  // reorder the list and persist through scriptOrder.js.
  assert.deepEqual(rowNames(), ['alpha', 'beta', 'gamma'], 'the list starts in Host order')
  await clickNode(findNode((node) => node.type === 'button' && node.props && node.props['aria-label'] === 'beta'), 'select beta')
  await clickNode(findButtonByTitle(dict('scriptsMoveDown')), 'move beta down')
  assert.deepEqual(rowNames(), ['alpha', 'gamma', 'beta'], '▼ must move the selection down locally')
  // The order is persisted by the bundled copy of scriptOrder.js, i.e. in the
  // VM's localStorage (a Node-side import would not see it).
  const storedOrder = JSON.parse(sandbox.localStorage.getItem('dsh.aiterm.scriptOrder') || '{}')
  assert.deepEqual(storedOrder['巡检'], ['alpha', 'gamma', 'beta'], 'the local order must persist in localStorage')
  await clickNode(findButtonByTitle(dict('scriptsMoveUp')), 'move beta up')
  assert.deepEqual(rowNames(), ['alpha', 'beta', 'gamma'], '▲ must move it back')

  // ③ 复制 saves a full copy under <name>-copy via scripts.save.
  scene.handlers.set('scripts.save', async (params) => ({
    script: { name: params.script.name, description: '', folder: params.script.folder, params: {}, stepCount: params.script.steps.length, updatedAt: now },
  }))
  {
    const savesBefore = scene.rpcCalls.filter((call) => call.method === 'scripts.save').length
    await clickNode(findNode((node) => node.type === 'button' && node.props && node.props['aria-label'] === 'alpha'), 'select alpha')
    await clickNode(findButtonByTitle(dict('scriptsCopy')), 'duplicate alpha')
    const saves = scene.rpcCalls.filter((call) => call.method === 'scripts.save')
    const last = saves[saves.length - 1]
    assert.equal(saves.length, savesBefore + 1, '复制 must call scripts.save')
    assert.equal(last.params.script.name, 'alpha-copy', '复制 must save <name>-copy')
    assert.deepEqual(last.params.script.steps, [{ send: 'alpha' }], 'the copy must carry the real steps')
    assert.equal(last.params.script.folder, '巡检', 'the copy must stay in the folder')
    assert.ok(textOf(lastTree).includes(fmtLike('scriptsCopied', { name: 'alpha-copy' })) || textOf(lastTree).includes('alpha-copy'), '复制 must report the new name')
  }

  // ④ 添加分组 is always available and scopes the list to the new (empty) folder.
  await clickNode(findButtonByText(dict('scriptsFolderAdd')), 'add folder')
  await setInput(findInput((props) => props['aria-label'] === dict('scriptsFolderNew')), '新组', 'folder name')
  await clickNode(findButtonByText(dict('scriptsFolderUse')), 'create folder')
  {
    const scopeSelect = findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsFolderScope'))
    assert.equal(scopeSelect.props.value, '新组', 'the new folder must become the scope')
    assert.ok(textOf(lastTree).includes(dict('scriptsFolderEmpty')), 'an empty folder must say it has no scripts')
  }

  // ⑥ 重命名分组 lives in the folder bar now; it must still rewrite the folder
  // field of every script it contains (full definitions, never summaries).
  await closePanelViaBar()
  const renameSaves = []
  scene.handlers.set('scripts.list', async () => ({ scripts: fixture.map((entry) => ({ ...entry })) }))
  scene.handlers.set('scripts.save', async (params) => {
    renameSaves.push(params.script)
    return { script: { name: params.script.name, description: '', folder: params.script.folder, params: {}, stepCount: 1, updatedAt: now } }
  })
  await openPanelViaBar('scripts')
  await settle('scripts listed for a folder rename')
  await clickNode(findButtonByText(dict('scriptsFolderRename')), 'rename folder')
  await setInput(findInput((props) => props['aria-label'] === dict('scriptsFolderRename')), '巡检2', 'new folder name')
  await clickNode(findButtonByText(dict('scriptsFolderUse')), 'apply folder rename')
  {
    assert.equal(renameSaves.length, 3, 'renaming a folder must re-save every script it contains')
    assert.ok(renameSaves.every((entry) => entry.folder === '巡检2'), 'the new folder must reach scripts.save')
    assert.ok(
      renameSaves.every((entry) => Array.isArray(entry.steps) && entry.steps.length > 0),
      'a folder rename must never drop steps',
    )
  }

  // ⑤ The results window is a real floating layer: Esc/× closes it, the panel
  // keeps one summary line, and the full list is inside the window.
  await closePanelViaBar()
  scene.handlers.set('scripts.list', async () => ({ scripts: fixture.map((entry) => ({ ...entry })) }))
  scene.handlers.set('scripts.run', async () => ({ result: { ok: true, timedOut: false, runs: [{ sessionId: 'st-1', ok: true }] } }))
  await openPanelViaBar('scripts')
  await settle('scripts listed for a run')
  await clickNode(findButtonByText(dict('scriptsRun')), 'run script')
  await emitBatch({ type: 'batch', batchId: 'batch-19', label: 'script:alpha', state: 'step', sessionId: 'st-1', stepIndex: 0, ok: true, text: 'step ok' })
  await settle('result frame')
  {
    assert.ok(findNode((node) => node.type === 'div' && node.props && node.props.role === 'dialog' && node.props['aria-label'] === dict('scriptsResultTitle')), 'the results window must be open')
    assert.ok(findNode((node) => node.props && node.props.role === 'log'), 'the full progress list must live in the window')
    assert.ok(textOf(lastTree).includes(fmtLike('scriptsResultDone', { steps: 1 })) || textOf(lastTree).includes(dict('scriptsResultRunning').split('{')[0]), 'the panel must keep a one-line run summary')
    await clickNode(findButtonByTitle(dict('scriptsResultClose')), 'close results window')
    await settle('window closed')
    assert.equal(findNode((node) => node.props && node.props.role === 'log'), null, 'closing the window removes the list')
    assert.ok(findButtonByText(dict('scriptsViewResult')), '查看结果 must stay in the panel')
  }
  await emitBatch({ type: 'batch', batchId: 'batch-19', label: 'script:alpha', state: 'done', sessionId: 'st-1', stepIndex: 0, ok: true })
  await closePanelViaBar()
}

/* ------------------------------------------------------------------ *
 * Scenario 20 — script panel round 2 (user feedback):
 *   · the dialect is a selector above the split, not two create buttons
 *   · the 「等命令跑完」toggle is gone (commands are sent as typed)
 *   · the template list follows the dialect
 *   · the editor owns the remaining height (no fixed-height textarea)
 * ------------------------------------------------------------------ */

{
  scene.handlers.set('scripts.list', async () => ({
    scripts: [{ name: 'uptime', description: '', folder: '', params: {}, stepCount: 1, updatedAt: now }],
  }))
  scene.handlers.set('scripts.get', async (params) => ({
    script: { name: params.name, description: '', folder: '', params: {}, steps: [{ send: 'uptime' }] },
  }))
  await setSessions([sessionRecord()])
  await closePanelViaBar()
  await openPanelViaBar('scripts')
  await settle('scripts listed')

  // ① selector semantics: 逐行命令 draft is text, 高级脚本 draft is JSON
  await createScript('json')
  {
    const text = String((findNode((n) => n.type === 'textarea') || { props: {} }).props.value || '')
    assert.ok(text.trim().startsWith('{'), 'the advanced draft must start from JSON')
  }
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel advanced draft')
  await createScript('macro')
  {
    const text = String((findNode((n) => n.type === 'textarea') || { props: {} }).props.value || '')
    assert.ok(!text.trim().startsWith('{'), 'the command draft must start from macro text')
  }

  // ② no 「等命令跑完」toggle anywhere
  assert.equal(textOf(lastTree).includes(dict('scriptsMacroWait')), false, 'the wait-for-idle toggle must be gone')

  // ③ templates follow the dialect: macro offers @wait, JSON offers if/loop
  const templateSelect = () => findNode((node) => node.type === 'select' && node.props && node.props['aria-label'] === dict('scriptsTemplate'))
  {
    const options = collect(templateSelect(), (node) => node.type === 'option').map((option) => option.props.value)
    assert.ok(options.includes('wait'), 'the command dialect must offer the @wait template, got ' + options.join(','))
    assert.ok(!options.includes('if'), 'the command dialect must not offer JSON if/loop templates')
  }
  await setInput(templateSelect(), 'wait', 'insert @wait template')
  assert.ok(
    String((findNode((n) => n.type === 'textarea') || { props: {} }).props.value || '').includes('@wait'),
    'inserting the @wait template must write macro syntax',
  )
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel command draft')

  await createScript('json')
  {
    const options = collect(templateSelect(), (node) => node.type === 'option').map((option) => option.props.value)
    assert.ok(options.includes('if') && options.includes('loop'), 'the advanced dialect must offer if/loop templates, got ' + options.join(','))
    assert.ok(!options.includes('wait'), 'the advanced dialect must not offer macro templates')
  }

  // ④ the editor body grows instead of being a fixed-height box
  {
    const body = findNode((node) => node.type === 'textarea')
    assert.ok(body, 'the editor must render a textarea')
    const style = body.props.style || {}
    assert.equal(String(style.flex || ''), '1 1 auto', 'the script body must grow with the column, got ' + JSON.stringify(style.flex))
    assert.ok(Number(style.minHeight) >= 120, 'the body keeps a usable minimum height')
  }
  await clickNode(findButtonByText(dict('scriptsCancel')), 'cancel draft')
  await closePanelViaBar()
}

/* ------------------------------------------------------------------ *
 * Scenario 21 — transport identity, log export, auto-log switch.
 *
 * Regression (user request): 「支持不同会话，显示不同的 ssh、telnet」
 * 「支持导出所有的日志」「支持自动写日志文件（默认不开启）」.
 * ------------------------------------------------------------------ */

{
  await setSessions([
    sessionRecord({ id: 'st-ssh', title: 'web-1', host: '10.0.0.5', transport: 'ssh' }),
    sessionRecord({ id: 'st-tel', title: 'switch-1', host: '10.0.0.9', port: 23, transport: 'telnet' }),
  ])
  await closePanelViaBar()
  await settle('two sessions rendered')

  // ── SSH and TELNET are visually distinct in the rail ───────────────────
  {
    const chips = collect(lastTree, (node) => node.props && node.props.role === 'presentation')
    assert.equal(chips.length, 2, 'both sessions must render a rail chip')
    const flat = textOf(lastTree)
    assert.ok(flat.includes('ssh'), 'the SSH session must be labelled ssh')
    assert.ok(flat.includes('telnet'), 'the Telnet session must be labelled telnet')
    // The badge carries a per-transport colour, so the two are not just text.
    const badges = collect(lastTree, (node) => node.props && node.props.style && node.props.style.textTransform === 'uppercase' && node.props.style.fontWeight === 600)
    assert.ok(badges.length >= 2, 'each transport badge must use the badge style')
    const colours = badges.map((node) => String(node.props.style.color || ''))
    assert.ok(new Set(colours).size >= 2, 'the two transports must not share one colour, got ' + colours.join('|'))
  }

  // ── history panel: export (current / all) + auto-log switch ────────────
  let raceResolve = null
  let raceReject = null
  let raceActive = false
  let legacyRaceResolve = null
  let legacyRaceActive = false
  let reloadResolve = null
  let reloadActive = false
  let legacyQueryResolve = null
  let legacyQueryActive = false
  let normalQueryResolve = null
  let normalQueryActive = false
  scene.handlers.set('history.sessions', async (params) => {
    if (reloadActive && (params.offset === undefined || params.offset === 0)) {
      return await new Promise((resolve) => { reloadResolve = resolve })
    }
    if (raceActive && params.offset === 1) {
      return await new Promise((resolve, reject) => { raceResolve = resolve; raceReject = reject })
    }
    if (params.offset === 1 && params.snapshot === 'snap-1') {
      return { sessions: [], total: 2, truncated: true, stale: true, snapshot: 'snap-2' }
    }
    return {
      sessions: [
        { id: 'st-ssh', title: 'web-1', transport: 'ssh', host: '10.0.0.5', port: 22, username: 'root', createdAt: now - 60_000, bytes: 2048, lastTs: now },
      ],
      total: 2,
      truncated: true,
      snapshot: 'snap-1',
    }
  })
  scene.handlers.set('history.query', async () => {
    if (normalQueryActive) return await new Promise((resolve) => { normalQueryResolve = resolve })
    return { matches: [], scannedBytes: 0 }
  })
  scene.handlers.set('history.legacy.sessions', async () => {
    if (legacyRaceActive) {
      return await new Promise((resolve) => { legacyRaceResolve = resolve })
    }
    return {
      sessions: [
        { id: 'st-legacy', title: 'old-unowned', transport: 'ssh', host: 'old.example', port: 22, username: 'old', createdAt: now - 120_000, bytes: 100, lastTs: now - 100_000 },
      ],
      total: 1,
      truncated: false,
      snapshot: 'legacy-snap-1',
    }
  })
  scene.handlers.set('history.legacy.query', async () => {
    if (legacyQueryActive) return await new Promise((resolve) => { legacyQueryResolve = resolve })
    return { matches: [{ at: now, line: 'LEGACY-OUT', before: [], after: [] }], scannedBytes: 50, truncated: false }
  })
  scene.handlers.set('history.legacy.export', async (params) => ({
    dir: '/home/u/.dsh/aiterm/exports',
    files: [{ sessionId: params.sessionId, path: '/home/u/.dsh/aiterm/exports/st-legacy-old-20261023.log', bytes: 64, lines: 2 }],
  }))
  scene.handlers.set('autolog.get', async () => ({ enabled: false, dir: '/home/u/.dsh/aiterm/logs', needsReview: true }))
  scene.handlers.set('autolog.set', async (params) => ({ enabled: params.enabled === true, dir: '/home/u/.dsh/aiterm/logs' }))
  scene.handlers.set('history.export', async (params) => ({
    dir: '/home/u/.dsh/aiterm/exports',
    files: [
      {
        sessionId: params.all === true ? 'st-ssh' : (params.sessionId || 'st-ssh'),
        path: `/home/u/.dsh/aiterm/exports/${params.all === true ? 'st-ssh' : (params.sessionId || 'st-ssh')}-web-1-20261023-101500.log`,
        bytes: 4096,
        lines: 120,
      },
    ],
  }))

  await openPanelViaBar('history')
  await settle('history panel opened')
  {
    const flat = textOf(lastTree)
    assert.ok(flat.includes(dict('historyLogFileTitle').slice(0, 2)), 'the log-file section must render')
    // The auto-log switch starts off (Host default) and says so.
    assert.ok(flat.includes(dict('historyAutoLogOffHint')), 'auto-log must read as off by default')
    const boxes = collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    const switchBox = boxes[boxes.length - 1]
    assert.ok(switchBox, 'the auto-log switch must render')
    assert.equal(switchBox.props.checked, false, 'auto-log starts disabled')
  }

  // Export the current session.
  {
    const mark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyExportOne')), 'export current session')
    const call = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'history.export')
    assert.ok(call, 'exporting must call history.export')
    assert.equal(call.params.all, undefined, 'exporting one session must not ask for all')
    assert.ok(call.params.sessionId, 'exporting one session must name it')
    assert.equal(call.params.owner, 'session-smoke', 'history.export must be scoped to the DSH session')
    const flat = textOf(lastTree)
    assert.ok(flat.includes('-web-1-'), 'the exported file path must be rendered, got: ' + flat.slice(-200))
    assert.ok(flat.includes(dict('historyExportLines').split('{')[0]), 'the exported line count must render')
  }

  // Export everything.
  {
    const mark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyExportAll')), 'export all sessions')
    const call = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'history.export')
    assert.ok(call, 'export-all must call history.export')
    assert.equal(call.params.all, true, 'export-all must pass all: true')
    assert.equal(call.params.owner, 'session-smoke', 'export-all must be scoped to the DSH session')
  }

  // Paging with a stale snapshot must reload rather than silently skip rows.
  {
    const mark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyLoadMore')), 'load more history')
    await settle('history stale page handled')
    const calls = scene.rpcCalls.slice(mark).filter((entry) => entry.method === 'history.sessions')
    assert.ok(calls.some((entry) => entry.params.offset === 1 && entry.params.snapshot === 'snap-1'), 'load more must send the snapshot and raw offset')
    assert.ok(calls.some((entry) => (entry.params.offset === undefined || entry.params.offset === 0)), 'a stale response must reload the first page')
    assert.ok(textOf(lastTree).includes(dict('historyStaleReload').slice(0, 8)), 'the stale reload must be explained')
  }

  // A normal loadMore that fails after switching to a slow legacy load must not
  // paint, error, or leave a clickable old Load more (real bundle async race).
  {
    raceActive = true
    legacyRaceActive = true
    await clickNode(findButtonByText(dict('historyLoadMore')), 'start racing normal page')
    await settle('normal page pending')
    await clickNode(findButtonByText(dict('historyLegacyEntry')), 'switch to legacy while normal page pending')
    await settle('legacy page pending')
    assert.ok(!findButtonByText(dict('historyLoadMore')), 'the old Load more must disappear on source switch')
    assert.ok(
      !collect(lastTree, (node) => node.props && node.props.role === 'option').some((node) => textOf(node).includes('web-1')),
      'the old normal list must be cleared on source switch',
    )
    assert.equal(typeof legacyRaceResolve, 'function')
    assert.equal(typeof raceReject, 'function')
    raceReject(new Error('late normal failure'))
    await settle('late normal failure ignored')
    assert.equal(textOf(lastTree).includes('late normal failure'), false, 'a late normal failure must not paint the legacy page')
    legacyRaceResolve({ sessions: [{ id: 'st-legacy', title: 'old-unowned', transport: 'ssh', host: 'old.example', port: 22, username: 'old', createdAt: now - 120_000, bytes: 100, lastTs: now - 100_000 }], total: 1, truncated: false, snapshot: 'legacy-snap-2' })
    await settle('slow legacy page resolved')
    assert.ok(textOf(lastTree).includes('old-unowned'), 'the legacy page must render after its slow response')
    raceActive = false
    legacyRaceActive = false
    await clickNode(findButtonByText(dict('historyLegacyBack')), 'return from race legacy')
    await settle('returned to normal history')
  }

  // A delayed query from the old source must not paint into the new source.
  {
    await clickNode(findButtonByText(dict('historyLegacyEntry')), 'legacy for delayed query')
    await settle('legacy query baseline')
    legacyQueryActive = true
    await clickNode(findButtonByText('old-unowned'), 'trigger delayed legacy query')
    await settle('legacy query pending')
    await clickNode(findButtonByText(dict('historyLegacyBack')), 'switch to normal while legacy query pending')
    await settle('normal after legacy query')
    assert.equal(typeof legacyQueryResolve, 'function')
    legacyQueryResolve({ matches: [{ at: now, line: 'STALE-LEGACY-QUERY', before: [], after: [] }], scannedBytes: 10, truncated: false })
    await settle('stale legacy query resolved')
    assert.equal(textOf(lastTree).includes('STALE-LEGACY-QUERY'), false, 'a stale legacy query must not paint into normal')

    normalQueryActive = true
    const webOption = collect(lastTree, (node) => node.type === 'button' && node.props && node.props.role === 'option' && textOf(node).includes('web-1'))[0]
    assert.ok(webOption, 'the normal history option must be selectable')
    await clickNode(webOption, 'trigger delayed normal query')
    await settle('normal query pending')
    await clickNode(findButtonByText(dict('historyLegacyEntry')), 'switch to legacy while normal query pending')
    await settle('legacy after normal query')
    assert.equal(typeof normalQueryResolve, 'function')
    normalQueryResolve({ matches: [{ at: now, line: 'STALE-NORMAL-QUERY', before: [], after: [] }], scannedBytes: 10, truncated: false })
    await settle('stale normal query resolved')
    assert.equal(textOf(lastTree).includes('STALE-NORMAL-QUERY'), false, 'a stale normal query must not paint into legacy')
    legacyQueryActive = false
    normalQueryActive = false
    await clickNode(findButtonByText(dict('historyLegacyBack')), 'return after delayed query')
    await settle('returned after delayed query')
  }

  // Explicit human-only legacy view: owner-bound GUI still reaches it.
  {
    const mark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyLegacyEntry')), 'open legacy history')
    await settle('legacy history opened')
    const listCall = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'history.legacy.sessions')
    assert.ok(listCall, 'the legacy button must call history.legacy.sessions')
    assert.equal(listCall.params.owner, undefined, 'the legacy view is an explicit human path, not an owner-scoped call')
    const queryCall = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'history.legacy.query')
    assert.ok(queryCall, 'selecting legacy history must call history.legacy.query')
    assert.equal(queryCall.params.sessionId, 'st-legacy')
    assert.ok(textOf(lastTree).includes(dict('historyLegacyHint').slice(0, 8)), 'the legacy view must explain its boundary')

    const exportMark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyExportOne')), 'export legacy session')
    const exportCall = scene.rpcCalls.slice(exportMark).find((entry) => entry.method === 'history.legacy.export')
    assert.ok(exportCall, 'exporting legacy history must use history.legacy.export')
    assert.equal(exportCall.params.sessionId, 'st-legacy')

    const backMark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyLegacyBack')), 'leave legacy history')
    await settle('legacy history closed')
    assert.ok(
      scene.rpcCalls.slice(backMark).some((entry) => entry.method === 'history.sessions'),
      'leaving the legacy view must restore the normal owner-scoped list',
    )
  }

  // A legacy enabled auto-log setting is paused pending an explicit human choice.
  {
    assert.ok(
      textOf(lastTree).includes(dict('historyAutoLogLegacyReview').slice(0, 10)),
      'the panel must explain the legacy auto-log review',
    )
    assert.ok(textOf(lastTree).includes('/home/u/.dsh/aiterm/logs'), 'the old autolog path must be shown before confirming')
    assert.ok(textOf(lastTree).includes(dict('historyAutoLogLegacyEnable').slice(0, 6)), 'an explicit confirm action must be present')
    const reviewBoxes = collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    assert.equal(reviewBoxes[reviewBoxes.length - 1].props.disabled, true, 'the one-click switch must stay disabled during review')
    const mark = scene.rpcCalls.length
    await clickNode(findButtonByText(dict('historyAutoLogLegacyKeepOff')), 'keep legacy auto-log off')
    const call = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'autolog.set')
    assert.ok(call, 'the keep-off confirmation must call autolog.set')
    assert.equal(call.params.enabled, false, 'keep-off must persist an explicit disabled state')
  }

  // Flip the auto-log switch on.
  {
    const mark = scene.rpcCalls.length
    const boxes = collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    await toggleCheckbox(boxes[boxes.length - 1], true, 'enable auto-log')
    const call = scene.rpcCalls.slice(mark).find((entry) => entry.method === 'autolog.set')
    assert.ok(call, 'flipping the switch must call autolog.set')
    assert.equal(call.params.enabled, true, 'the switch must send enabled: true')
    assert.ok(textOf(lastTree).includes(dict('historyAutoLogOn')), 'the toast must confirm the switch')
    assert.ok(textOf(lastTree).includes(dict('historyAutoLogWhere').split('{')[0]), 'the writing directory must be shown')
  }

  // A delayed initial normal load that resolves after switching to legacy must
  // not overwrite the legacy page either (initial-load race, not just loadMore).
  await closePanelViaBar()
  reloadActive = true
  await openPanelViaBar('history')
  await settle('initial normal load pending')
  await clickNode(findButtonByText(dict('historyLegacyEntry')), 'enter legacy during initial load')
  await settle('legacy during initial load')
  assert.ok(textOf(lastTree).includes('old-unowned'), 'legacy must render before the initial normal response')
  assert.equal(typeof reloadResolve, 'function')
  reloadResolve({
    sessions: [{ id: 'st-ssh-initial', title: 'normal-initial', transport: 'ssh', host: '10.0.0.5', port: 22, username: 'root', createdAt: now - 20_000, bytes: 10, lastTs: now }],
    total: 1,
    truncated: false,
    snapshot: 'initial-snap',
  })
  await settle('late initial normal resolved')
  assert.equal(textOf(lastTree).includes('normal-initial'), false, 'a late initial normal response must not overwrite legacy')
  assert.ok(textOf(lastTree).includes('old-unowned'), 'legacy remains after the late initial response')
  reloadActive = false

  await closePanelViaBar()
  await setSessions([sessionRecord()])
}

/* ------------------------------------------------------------------ *
 * Scenario 22 — an old Host degrades instead of erroring.
 *
 * The client bundle updates on a page refresh but the Host half only on a DSH
 * restart, so a fresh page can meet a process that has no `autolog.get` /
 * `history.export`. That must read as "restart DSH", with the controls disabled,
 * not as a raw UNKNOWN_METHOD error.
 * ------------------------------------------------------------------ */

{
  scene.handlers.set('history.sessions', async () => ({ sessions: [] }))
  scene.handlers.set('autolog.get', async () => ({
    __hostError: { code: 'UNKNOWN_METHOD', message: 'unknown RPC method autolog.get' },
  }))
  scene.handlers.set('history.export', async () => ({
    __hostError: { code: 'UNKNOWN_METHOD', message: 'unknown RPC method history.export' },
  }))

  await closePanelViaBar()
  await openPanelViaBar('history')
  await settle('history panel opened against an old Host')
  {
    const flat = textOf(lastTree)
    assert.ok(flat.includes(dict('historyExportNeedsRestart')), 'an old Host must be explained, got: ' + flat.slice(-160))
    const exportBtn = findButtonByText(dict('historyExportOne'))
    assert.ok(exportBtn, 'the export control still renders')
    assert.equal(exportBtn.props.disabled, true, 'export must be disabled until DSH restarts')

    const boxes = collect(lastTree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    const switchBox = boxes[boxes.length - 1]
    if (switchBox) {
      assert.equal(switchBox.props.disabled, true, 'the auto-log switch must be disabled until DSH restarts')
    }
  }
  await closePanelViaBar()

  // Restore a healthy Host for the remaining scenarios.
  scene.handlers.delete('autolog.get')
  scene.handlers.delete('history.export')
}

/* ------------------------------------------------------------------ *
 * Scenario 23 — terminals belong to one DSH (AI) session.
 *
 * Regression (user request): 「不同的 AI 会话，单独维护打开的 ssh、telnet」
 * The panel must stamp every session-scoped call with the DSH session id, filter
 * its stream by it, and drop the previous list when the conversation changes.
 * ------------------------------------------------------------------ */

{
  // Session-scoped RPCs must carry the owner that was handed to <Panel>.
  {
    const listCalls = scene.rpcCalls.filter((call) => call.method === 'sessions.list')
    const last = listCalls[listCalls.length - 1]
    assert.ok(last, 'the panel must fetch the session list')
    assert.equal(last.params.owner, 'session-smoke', 'sessions.list must be scoped to the DSH session')
  }

  // The global stream is filtered by the same owner.
  {
    const stream = globalStream()
    assert.ok(stream, 'the global stream must be open')
    assert.ok(
      String(stream.url).includes('owner=session-smoke'),
      'the stream must carry ?owner=, got ' + stream.url,
    )
  }

  // Host-wide settings must NOT be scoped: profiles live outside the AI session.
  {
    const profileCalls = scene.rpcCalls.filter((call) => call.method === 'profiles.list')
    assert.ok(profileCalls.length > 0, 'the profile library must have been loaded')
    for (const call of profileCalls) {
      assert.equal(call.params.owner, undefined, 'profiles.list must stay host-wide (no owner)')
    }
  }

  // Switching the AI session resets the panel to that conversation's (empty) set.
  await setSessions([sessionRecord({ id: 'st-owner', title: 'owner-shell', owner: 'session-smoke' })])
  assert.ok((sandbox.__DSH_AITERM_CLIENT__.internals.getState().sessions || []).length >= 1, 'the current conversation must show its terminals')

  // Drive the documented switch path directly: the slot passes the DSH session
  // id and the store scopes everything to it. (Changing the root props cannot
  // re-run the mount effect inside this harness.)
  sandbox.__DSH_AITERM_CLIENT__.internals.setOwner('session-other')
  await settle('switch dsh session')
  {
    const listCalls = scene.rpcCalls.filter((call) => call.method === 'sessions.list')
    const last = listCalls[listCalls.length - 1]
    assert.equal(last.params.owner, 'session-other', 'after switching, calls must use the new owner')
    const stream = globalStream()
    assert.ok(stream && String(stream.url).includes('owner=session-other'), 'the stream must follow the switch')
    assert.equal(
      (sandbox.__DSH_AITERM_CLIENT__.internals.getState().sessions || []).length,
      0,
      'the previous conversation\'s terminals must not leak into the new one',
    )
  }

  // Restore the original conversation for the remaining scenarios.
  sandbox.__DSH_AITERM_CLIENT__.internals.setOwner('session-smoke')
  await settle('restore dsh session')
  await setSessions([sessionRecord()])
}

/* ------------------------------------------------------------------ *
 * Scenario 16 — malformed global frames never throw.
 * ------------------------------------------------------------------ */

{
  const stream = globalStream()
  assert.ok(stream)
  stream.emit({ type: 'batch', state: 'step', sessionId: 'st-1', stepIndex: 0, ok: true })
  stream.emit({ type: 'batch', batchId: 'batch-9', state: 'done', sessionId: 'st-1', stepIndex: 0, ok: true })
  stream.emitRaw('{not json')
  stream.emit({ type: 'state', session: null })
  stream.emit({ type: 'sessions', sessions: 'nope' })
  await settle('malformed frames')
}

// A malformed `sessions` payload resets the list defensively; reseed it.
await setSessions([sessionRecord()])

/* ------------------------------------------------------------------ *
 * Scenario 17 — v4 session lifecycle (§15–§18): `disconnected` rendering,
 * 中断 / 重连 payloads, pending disable, reset frame, generation fallback and
 * failed-reconnect errors.
 * ------------------------------------------------------------------ */

const internals = sandbox.__DSH_AITERM_CLIENT__ && sandbox.__DSH_AITERM_CLIENT__.internals
assert.ok(internals, 'the client must expose its verification surface for the VM smoke harness')
for (const name of ['applyReset', 'createResetTracker', 'resetNotice', 'buildReconnectPayload', 'getState']) {
  assert.equal(typeof internals[name], 'function', `internals.${name} must be a function`)
}

// 17a — an open session offers 中断 and never 重连.
{
  assert.ok(findButtonByTitle(dict('disconnect')), 'an open session must show the 中断 control')
  assert.equal(findButtonByTitle(dict('reconnectAction')), null, 'an open session must not show 重连')
  assert.ok(findButtonByTitle(dict('copyScreen')), 'screen copy must be enabled while open')
}

// 17b — 中断 keeps the session in the rail (hollow amber dot, dimmed title,
// still selectable) and sends `{ id }`.
const disconnectedRecord = sessionRecord({
  state: 'disconnected',
  generation: 1,
  disconnectedAt: now,
  closeReason: 'user disconnect',
  permission: { aiAccess: 'rw', lockOwner: null, lockExpiresAt: null, humanWriteBlocked: false, aiWriteBlocked: false },
})
let resolveDisconnect = null
scene.handlers.set('sessions.disconnect', () => new Promise((resolve) => {
  resolveDisconnect = resolve
}))
await clickNode(findButtonByTitle(dict('disconnect')), 'disconnect session')
{
  const callsForDisconnect = scene.rpcCalls.filter((call) => call.method === 'sessions.disconnect')
  assert.equal(callsForDisconnect.length, 1, '中断 must call sessions.disconnect')
  assert.deepEqual(withoutOwner(callsForDisconnect[0].params), { id: 'st-1' }, '中断 must send { id } only')
  const busyControl = findButtonByTitle(dict('disconnect'))
  assert.ok(busyControl, '中断 must stay rendered while pending')
  assert.equal(busyControl.props.disabled, true, '中断 must be disabled while pending')
  assert.ok(textOf(busyControl).includes('…'), '中断 must show a busy state while pending')
}
resolveDisconnect({ session: disconnectedRecord })
await settle('disconnect resolved')
{
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('disconnectedNotice')), 'disconnecting must toast')
  assert.ok(text.includes(dict('stateDisconnected')), 'the status bar must say the session is disconnected')
  assert.ok(text.includes(dict('disconnectedTitle')), 'the disconnected banner must render')
  assert.ok(text.includes('user disconnect'), 'the close reason must render')
  assert.ok(text.includes('root@10.0.0.5'), 'a disconnected session must stay in the rail')
  // Hollow amber state dot.
  const dot = findNode((node) => node.type === 'span'
    && node.props && node.props.style
    && node.props.style.borderRadius === '50%'
    && node.props.style.background === 'transparent'
    && String(node.props.style.border || '').includes('state-warn-primary'))
  assert.ok(dot, 'a disconnected session must use a hollow amber state dot')
  // Dimmed title.
  const dimTitle = findNode((node) => node.type === 'span'
    && node.props && node.props.style
    && node.props.style.opacity === 0.7
    && textOf(node) === 'root@10.0.0.5')
  assert.ok(dimTitle, 'a disconnected session title must be dimmed')
  // The rail chip stays clickable.
  const tab = findNode((node) => node.type === 'button' && node.props && node.props.role === 'tab')
  assert.ok(tab && typeof tab.props.onClick === 'function', 'a disconnected session must stay selectable')
  // 重连 sits where 接管 normally sits; 中断 is gone.
  assert.ok(findButtonByTitle(dict('reconnectAction')), 'a disconnected session must show 重连')
  assert.equal(findButtonByTitle(dict('disconnect')), null, 'a disconnected session must not show 中断')
  // Input and screen copy are disabled while disconnected, with an explaining title.
  const copy = findButtonByTitle(dict('copyScreenUnavailable'))
  assert.ok(copy, 'screen copy must explain that it is unavailable while disconnected')
  assert.equal(copy.props.disabled, true, 'screen copy must be disabled while disconnected')
  assert.ok(!findButtonByTitle(dict('copyScreen')), 'the enabled copy control must be gone while disconnected')
  // 只读 / 只写 / 读写 stays usable on a disconnected session (§15: permission.set allowed).
  const accessSegment = findButtonByText(dict('permRo'))
  assert.ok(accessSegment, 'the AI access control must render for a disconnected session')
  assert.notEqual(accessSegment.props.disabled, true, 'the AI access control must stay usable while disconnected')
}

// 17c — 重连 from the disconnected session: payload carries the fitted terminal
// size, and the button is disabled/busy while the RPC is pending.
{
  let resolveReconnect = null
  scene.handlers.set('sessions.reconnect', () => new Promise((resolve) => {
    resolveReconnect = resolve
  }))
  await clickNode(findButtonByTitle(dict('reconnectAction')), 'reconnect session')
  const callsForReconnect = scene.rpcCalls.filter((call) => call.method === 'sessions.reconnect')
  assert.equal(callsForReconnect.length, 1, '重连 must call sessions.reconnect')
  assert.deepEqual(
    withoutOwner(callsForReconnect[0].params),
    { id: 'st-1', cols: 100, rows: 30 },
    '重连 must send { id, cols, rows } from the fitted terminal',
  )
  const pending = findButtonByTitle(dict('reconnectAction'))
  assert.ok(pending, 'the reconnect control must stay rendered while pending')
  assert.equal(pending.props.disabled, true, 'the reconnect control must be disabled while pending')
  assert.equal(pending.props['aria-busy'], true, 'the reconnect control must expose its busy state')

  resolveReconnect({ session: sessionRecord({ generation: 2 }) })
  await settle('reconnect resolved')
  const text = textOf(lastTree)
  assert.ok(text.includes(dict('reconnected')), 'a successful reconnect must toast')
  assert.ok(text.includes(dict('stateOpen')), 'the status bar must show the session as open again')
  assert.ok(findButtonByTitle(dict('disconnect')), 'the open session must show 中断 again')
  assert.equal(findButtonByTitle(dict('reconnectAction')), null, '重连 must disappear once the session is open')
  assert.ok(findButtonByTitle(dict('copyScreen')), 'screen copy must be enabled again after reconnecting')
}

// 17d — a Host-reported `reconnecting` flag disables 重连 without a local click.
{
  await setSessions([sessionRecord({ state: 'disconnected', generation: 2, reconnecting: true })])
  const pending = findButtonByTitle(dict('reconnectAction'))
  assert.ok(pending, '重连 must render for a disconnected session')
  assert.equal(pending.props.disabled, true, 'a Host-reported reconnecting flag must disable 重连')
  await setSessions([sessionRecord({ state: 'disconnected', generation: 2, reconnecting: false })])
}

// 17e — the `reset` SSE frame records one rebuild: the terminal clears once and
// prints the localized notice; a second delivery of the same frame is a no-op.
{
  const streamsBefore = streams.filter((stream) => !stream.closed).length
  globalStream().emit({ type: 'reset', session: sessionRecord({ generation: 3 }), reason: 'reconnect' })
  await settle('reset frame')
  const entry = internals.getState().resets['st-1']
  assert.ok(entry, 'a reset frame must record a reset entry')
  assert.equal(entry.generation, 3, 'the reset entry must carry the new generation')
  assert.equal(entry.reason, 'reconnect', 'the reset entry must carry the frame reason')
  assert.equal(
    streams.filter((stream) => !stream.closed).length,
    streamsBefore,
    'a reset must not resubscribe the SSE streams',
  )

  // Both streams deliver the same frame: only one reset entry (one notice).
  globalStream().emit({ type: 'reset', session: sessionRecord({ generation: 3 }), reason: 'reconnect' })
  await settle('duplicate reset frame')
  assert.equal(internals.getState().resets['st-1'].seq, entry.seq, 'a duplicate reset frame must be deduped')

  // The terminal clears + prints the notice exactly once per entry.
  const term = { resets: 0, writes: [], reset() { this.resets += 1 }, write(value) { this.writes.push(value) } }
  const tracker = internals.createResetTracker(0)
  assert.equal(internals.applyReset(term, (key) => dict(key), entry.seq, tracker), true, 'the reset must clear the terminal')
  assert.equal(term.resets, 1, 'the terminal must be reset once')
  assert.ok(term.writes.join('').includes(dict('terminalResetNotice')), 'the terminal must print the localized notice')
  assert.equal(internals.applyReset(term, (key) => dict(key), entry.seq, tracker), false, 'the same entry must not clear twice')
  assert.equal(term.resets, 1, 'the notice must render once')
  // A tracker mounted after the event does not wipe a freshly replayed buffer.
  assert.equal(
    internals.applyReset(term, (key) => dict(key), entry.seq, internals.createResetTracker(entry.seq)),
    false,
    'a stale reset entry must not clear a freshly replayed screen',
  )
}

// 17f — generation-bump fallback: a `state` frame with a higher generation is a
// reset even when the `reset` frame was missed.
{
  const previous = internals.getState().resets['st-1']
  globalStream().emit({ type: 'state', session: sessionRecord({ generation: 4 }) })
  await settle('generation bump')
  const entry = internals.getState().resets['st-1']
  assert.ok(entry && entry.seq > previous.seq, 'a higher generation must record a new reset entry')
  assert.equal(entry.generation, 4, 'the fallback reset entry must carry the new generation')
  const term = { resets: 0, writes: [], reset() { this.resets += 1 }, write(value) { this.writes.push(value) } }
  assert.equal(
    internals.applyReset(term, (key) => dict(key), entry.seq, internals.createResetTracker(previous.seq)),
    true,
    'the generation bump must clear the terminal like a reset frame',
  )
  assert.equal(term.resets, 1)
  assert.ok(term.writes.join('').includes(dict('terminalResetNotice')))
  // Equal/older generations never clear.
  globalStream().emit({ type: 'state', session: sessionRecord({ generation: 4 }) })
  await settle('same generation')
  assert.equal(internals.getState().resets['st-1'].seq, entry.seq, 'an unchanged generation must not reset again')

  // Host ordering: the `state` frame (generation bump) is emitted before the
  // `reset` frame, so the late reset frame must be deduped rather than clearing
  // the screen a second time.
  globalStream().emit({ type: 'reset', session: sessionRecord({ generation: 4 }), reason: 'reconnected' })
  await settle('late reset frame')
  assert.equal(
    internals.getState().resets['st-1'].seq,
    entry.seq,
    'a reset frame arriving after its generation bump must be deduped',
  )
}

// 17g — reconnect payload builder normalizes the fitted geometry.
{
  // Values created inside the VM context carry that realm's prototypes.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(internals.buildReconnectPayload('st-1', { cols: 120, rows: 40 })), { id: 'st-1', cols: 120, rows: 40 })
  assert.deepEqual(plain(internals.buildReconnectPayload('st-1', null)), { id: 'st-1' }, 'a missing size must omit cols/rows')
  assert.deepEqual(plain(internals.buildReconnectPayload('st-1', { cols: 0, rows: Number.NaN })), { id: 'st-1' }, 'invalid sizes must be omitted')
}

// 17h — a failed reconnect shows the Host error verbatim and keeps the session.
{
  await setSessions([sessionRecord({ state: 'disconnected', generation: 2 })])
  scene.handlers.set('sessions.reconnect', async () => ({ session: sessionRecord({ generation: 3, state: 'failed', error: 'dial tcp 10.0.0.5:22: connect: connection refused' }) }))
  await clickNode(findButtonByTitle(dict('reconnectAction')), 'failed reconnect')
  {
    const text = textOf(lastTree)
    assert.ok(
      text.includes('dial tcp 10.0.0.5:22: connect: connection refused'),
      'a failed reconnect must show the Host error verbatim',
    )
    assert.ok(text.includes(dict('failedTitle')), 'a failed reconnect must leave the session visible')
    assert.ok(findButtonByTitle(dict('reconnectAction')), 'a failed session must still offer 重连 so it can be retried')
  }

  // An RPC-level failure (e.g. RECONNECT_NO_CREDENTIALS, §16) is shown verbatim too.
  await setSessions([sessionRecord({ state: 'disconnected', generation: 3 })])
  scene.handlers.set('sessions.reconnect', async () => ({
    __hostError: { code: 'RECONNECT_NO_CREDENTIALS', message: 'no stored credentials for this session; reconnect from a saved profile' },
  }))
  await clickNode(findButtonByTitle(dict('reconnectAction')), 'reconnect without credentials')
  {
    const text = textOf(lastTree)
    assert.ok(
      text.includes('no stored credentials for this session; reconnect from a saved profile'),
      'an RPC-level reconnect failure must show the Host message verbatim',
    )
    assert.ok(findButtonByTitle(dict('reconnectAction')), 'the session must stay reconnectable after an RPC failure')
  }
}

// Reseed an open session for the tab-title check.
await setSessions([sessionRecord({ generation: 5 })])

/* ------------------------------------------------------------------ *
 * Scenario 18 — navigation stack (← returns to where you came from), the
 * labelled library entry, inline session-close confirmation and the
 * no-session home.
 * ------------------------------------------------------------------ */

{
  const stackState = () => sandbox.__DSH_AITERM_CLIENT__.internals.getState()
  const topOf = () => {
    const stack = stackState().viewStack
    return stack[stack.length - 1]
  }
  const openProfiles = async () => {
    scene.handlers.set('profiles.list', async () => ({
      profiles: [{
        id: 'p-42', name: 'nav-profile', transport: 'ssh', host: '10.9.9.9', port: 22, username: 'ops',
        authType: 'none', hasPassword: false, hasPrivateKey: false, hasPassphrase: false,
        folder: '', order: 0, updatedAt: now,
      }],
      folders: [],
    }))
    await clickNode(findButtonByTitle(dict('profiles')), 'open library')
    assert.ok(findDialog(), 'the library must open from the terminal view')
  }

  // 18a — the terminal view has a labelled 配置管理 entry, not just an icon.
  const profilesEntry = findButtonByTitle(dict('profiles'))
  assert.ok(profilesEntry, 'the terminal view must expose a 配置管理 control')
  assert.ok(textOf(profilesEntry).includes(dict('profiles')), 'the 配置管理 entry must be labelled')

  // 18b — terminal → library is one stack level.
  await openProfiles()
  assert.equal(topOf().kind, 'panel', 'opening the library pushes a panel view')
  assert.equal(stackState().viewStack.length, 2, 'the library is one level above the terminal')

  // 18c — library → edit → back returns to the library (not the terminal).
  await clickNode(findButtonByTitle(`${dict('profilesEdit')} nav-profile`), 'edit from library')
  assert.equal(topOf().kind, 'connect', 'editing pushes the connect form')
  assert.equal(topOf().draft.id, 'p-42', 'the form carries the edited profile')
  assert.equal(stackState().viewStack.length, 3, 'the form stacks above the library')
  assert.ok(findButtonByTitle(dict('back')), 'the connect form must show a ← back control')
  const formInput = findInput((props) => props.value === '10.9.9.9')
  assert.ok(formInput.props.style.height >= 30, 'form inputs must be at least 30 px tall')
  await clickNode(findButtonByTitle(dict('back')), 'back from the editor')
  assert.equal(topOf().kind, 'panel', 'back from the editor returns to the library')
  assert.ok(findDialog(), 'the library must be visible again')
  assert.equal(findNode((node) => node.type === 'form'), null, 'the form must be gone')

  // 18d — library → back returns to the terminal.
  await clickNode(findButtonByTitle(dict('profilesPanelClose')), 'back from the library')
  assert.equal(topOf().kind, 'terminal', 'back from the library returns to the terminal')
  assert.equal(stackState().viewStack.length, 1, 'the terminal is the root view')
  assert.equal(findDialog(), null, 'no overlay must remain')
  assert.ok(textOf(lastTree).includes('root@10.0.0.5'), 'the terminal view is visible again')

  // 18e — session close asks inline (rail chip), and cancel keeps the session.
  const closeButtons = () => collect(lastTree, (node) => node.type === 'button'
    && node.props && node.props.title === dict('closeSession'))
  assert.ok(closeButtons().length >= 2, 'the rail chip and the control bar both offer close')
  const closesBefore = scene.rpcCalls.filter((call) => call.method === 'sessions.close').length
  await clickNode(closeButtons()[0], 'rail close')
  assert.ok(
    textOf(lastTree).includes(fmtLike('closeSessionPrompt', { title: 'root@10.0.0.5' })),
    'closing a session must ask with an inline confirmation',
  )
  assert.equal(
    scene.rpcCalls.filter((call) => call.method === 'sessions.close').length,
    closesBefore,
    'the first close click must not close',
  )
  await clickNode(findButtonByText(dict('cancel')), 'cancel rail close')
  assert.equal(findDialog(), null, 'no dialog involved')
  assert.ok(textOf(lastTree).includes('root@10.0.0.5'), 'cancel must keep the session')

  // 18f — the control-bar close uses the same inline confirmation.
  const barClose = collect(lastTree, (node) => node.type === 'button'
    && node.props && node.props.title === dict('closeSession')).pop()
  await clickNode(barClose, 'control bar close')
  assert.ok(
    textOf(lastTree).includes(fmtLike('closeSessionPrompt', { title: 'root@10.0.0.5' })),
    'the control-bar close must ask too',
  )
  assert.equal(
    scene.rpcCalls.filter((call) => call.method === 'sessions.close').length,
    closesBefore,
    'the control-bar close must not close before confirming',
  )
  await clickNode(findButtonByText(dict('cancel')), 'cancel control bar close')

  // 18g — with no session the library is the home view and nothing dereferences
  // a missing selection (the historical crash).
  await setSessions([])
  assert.ok(findDialog(), 'the library must be the home view without sessions')
  assert.ok(textOf(lastTree).includes(dict('profilesTitle')), 'the empty home must render the library title')
  assert.ok(findButtonByText(dict('profilesNewConnection')), 'the empty home must offer 新建连接')
  assert.equal(stackState().viewStack.length, 1, 'the empty home stays at the root view')
  await setSessions([sessionRecord({ generation: 5 })])
}

/* ------------------------------------------------------------------ *
 * Tab title.
 * ------------------------------------------------------------------ */

{
  const titleTree = expand({ type: titleEntry.component, props: rootProps })
  assert.ok(textOf(titleTree).includes('root@10.0.0.5'), 'tab title must show the selected session')
}

console.log('client smoke: %d locale keys, %d slot registrations, %d RPC methods exercised', Object.keys(dictZh).length, calls.registrations.length, new Set(scene.rpcCalls.map((call) => call.method)).size)
console.log('client smoke: SMOKE OK')
process.exit(0)
