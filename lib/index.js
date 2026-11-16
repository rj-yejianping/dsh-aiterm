/**
 * `dsh-aiterm` — host half.
 *
 * A Cordis plugin that owns SSH (ssh2) and Telnet (raw socket + IAC negotiation)
 * sessions shared by the user and the model:
 *
 * - multi-session registry, each session mirrored into a headless terminal screen
 *   so the model can take readable screenshots;
 * - per-session AI permission modes (read-only / write-only / read-write) and a
 *   single control token, so the human's keystrokes are blocked while the AI
 *   operates and the AI's writes are refused while the human holds control;
 * - authenticated HTTP RPC + SSE for the browser panel, and `aiterm_*` tools
 *   for the model, both funnelled through the same enforcement point.
 *
 * This half imports no `@deepseek-ai/*` module: it lives outside the harness
 * package tree and reaches every capability through runtime services. It
 * degrades safely: tools and the prompt section load even without the Web
 * composition, and the HTTP surface is only registered when `webServer` and
 * `connection` both exist.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from './host/config.js'
import { HistoryStore } from './host/history-store.js'
import { ProfileStore, SecretStore } from './host/profiles.js'
import { registerPrompt } from './host/prompt.js'
import { SessionRegistry } from './host/registry.js'
import { registerRoutes } from './host/routes.js'
import { ScriptStore } from './host/scripts.js'
import { registerTools } from './host/tools.js'
import { ensureDir } from './host/util.js'

export const name = 'aiterm'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

export { DEFAULT_CONFIG, resolveConfig } from './host/config.js'

/**
 * Cordis plugin body.
 * @param {any} ctx plugin context.
 * @param {unknown} [config] row config from `cordis.patch.yml`.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      // logging must never break activation
    }
  }
  if (!resolved.enabled) {
    log('info', '[aiterm] disabled by configuration')
    return
  }

  const dataDir = join(homedir(), '.dsh', 'aiterm')
  /** @type {{ config: any, registry: SessionRegistry | undefined, profiles: ProfileStore | undefined, scripts: ScriptStore | undefined, log: Function }} */
  const plugin = { config: resolved, registry: undefined, profiles: undefined, scripts: undefined, log }

  // Optional services are reached through their injected contexts: Cordis
  // forbids reading a service this plugin did not declare.
  /** @type {any} */
  let credentialsService
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsService = credentialsCtx.credentials
    log('info', '[aiterm] credentials service available; profile secrets use the encrypted store')
  })

  const secrets = new SecretStore({
    getCredentials: () => credentialsService,
    dataDir,
    log,
  })
  const profiles = new ProfileStore({ dataDir, secrets, log })
  const historyStore = new HistoryStore({
    dir: join(dataDir, 'history'),
    retentionMs: resolved.historyRetentionMs,
    maxBytesPerSession: resolved.historyMaxBytesPerSession,
    maxSessions: resolved.historyMaxSessions,
    flushIntervalMs: resolved.historyFlushIntervalMs,
    log,
  })
  const scripts = new ScriptStore({ dir: join(dataDir, resolved.scriptsDir), log })
  const registry = new SessionRegistry({ config: resolved, profiles, dataDir, log, historyStore })
  plugin.profiles = profiles
  plugin.registry = registry
  plugin.scripts = scripts

  ctx.effect(() => {
    let disposed = false
    ensureDir(dataDir).catch(() => {})
    profiles.load().catch((error) => {
      log('warn', `[aiterm] could not load saved profiles: ${error instanceof Error ? error.message : String(error)}`)
    })
    // Durable history and scripts are optional state: failures only warn.
    historyStore
      .init()
      .catch((error) => log('warn', `[aiterm] history init failed: ${error instanceof Error ? error.message : String(error)}`))
    scripts
      .init()
      .catch((error) => log('warn', `[aiterm] script init failed: ${error instanceof Error ? error.message : String(error)}`))
    return async () => {
      if (disposed) return
      disposed = true
      await registry.dispose()
    }
  }, 'aiterm: session registry')

  // 1) Model-facing tools (`tools` is guaranteed by `inject`).
  registerTools(ctx, plugin)

  // 2) System-prompt guidance.
  registerPrompt(ctx)

  // 3) HTTP RPC + SSE, only when the Web composition provides both services.
  // `ctx.inject` never fires in a headless composition, which is exactly the
  // safe degradation we want: tools stay available without a Web surface.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    registerRoutes(webCtx, plugin)
  })

  log(
    'info',
    `[aiterm] host half loaded (route ${resolved.routePath}, aiAccessDefault=${resolved.aiAccessDefault}, blockHumanWhileAi=${resolved.blockHumanWhileAi}, secrets=${secrets.encrypted ? 'credential-store' : 'file-fallback'})`,
  )
}
