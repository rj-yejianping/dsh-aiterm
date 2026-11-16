/**
 * Browser half of `dsh-aiterm`.
 *
 * Registers one right-sidebar tab type (`aiterm`) and the bodies that draw
 * the session rail, the xterm terminal and the human/AI control surface. All
 * Host communication goes through the wire protocol in CONTRACTS.md §5.
 *
 * This module is bundled by `scripts/build-client.mjs` into `lib/client.js` and
 * materialized by the Harness client module loader; only `react` and
 * `react/jsx-runtime` are resolved through the module table, never a Harness
 * client package.
 */

import { en, NS, zh } from './locale.js'
import { Panel, TabTitle } from './panel.jsx'
import { buildReconnectPayload } from './api.js'
import { applyReset, createResetTracker, resetNotice } from './reset.js'
import { getState, setOwner } from './store.js'

/** Implementation identity: the module id, the tab type id and the slot seat key. */
export const TAB_ID = 'dsh-aiterm'

/** Tab type discriminator passed to `ctx.sidebarRight.openTab`. */
export const TAB_KIND = 'aiterm'

/** Services this plugin needs before it can register anything. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/**
 * Register the tab type, its pane body, its live title and its dictionaries.
 *
 * @param ctx - Client root Context carrying the slot registry and the sidebar.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aiterm: locale')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    // A terminal page is per sidebar, not per open: one panel shows every
    // session through the rail.
    multiple: false,
    priority: 'extension',
    title: () => t('title'),
    guide: [{
      id: 'open',
      order: 30,
      title: () => t('title'),
      description: () => t('guide'),
    }],
  }), 'aiterm: tab type')

  // The pane seat dispatches a keyed body with the tab type definition's `id`.
  // `TAB_KIND` is registered as a second key as well so a seat that dispatches
  // by kind (the shape sketched in CONTRACTS.md §6) resolves the same body.
  for (const key of [TAB_ID, TAB_KIND]) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key,
      locale: NS,
      inject: (sessionId) => ({ sessionId }),
    }, Panel)), `aiterm: pane body (${key})`)

    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key,
      locale: NS,
      inject: (sessionId) => ({ sessionId }),
    }, TabTitle)), `aiterm: pane title (${key})`)
  }

  try {
    globalThis.__DSH_AITERM_CLIENT__ = {
      plugin: TAB_ID,
      kind: TAB_KIND,
      route: '/aiterm',
      // Injected by scripts/build-client.mjs from package.json so the reported
      // version can never drift from the published manifest.
      version: __DSH_PLUGIN_VERSION__,
      // Verification surface for `scripts/smoke-client.mjs`: this environment
      // has no browser, so the VM harness drives the same pure helpers the
      // terminal uses (screen reset + reconnect payload) and reads a state
      // snapshot. Not a runtime API; the Harness never calls it.
      internals: { applyReset, createResetTracker, resetNotice, buildReconnectPayload, getState, setOwner },
    }
  } catch {
    /* non-browser contexts have no globalThis assignment target */
  }
}
