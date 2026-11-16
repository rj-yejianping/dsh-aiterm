/**
 * Plugin configuration: defaults, coercion and bounds.
 *
 * Every value can be overridden from the row's `config` in `cordis.patch.yml`,
 * so users tune behaviour without touching code, and their patch layer survives
 * plugin upgrades.
 */

import { boundInteger } from './util.js'

/** AI permission modes: read-only, write-only, read-write. */
export const AI_ACCESS_MODES = Object.freeze(['ro', 'wo', 'rw'])

/** Default row configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  aiAccessDefault: 'rw',
  aiAutoLock: true,
  aiLockIdleMs: 30_000,
  blockHumanWhileAi: true,
  humanCanPreempt: true,
  maxSessions: 16,
  scrollback: 4000,
  replayBufferBytes: 262_144,
  aiReadMaxBytes: 65_536,
  deltaDefaultMaxBytes: 8_192,
  connectTimeoutMs: 20_000,
  keepaliveMs: 15_000,
  routePath: '/aiterm',
  knownHostsPolicy: 'accept-new',
  terminalType: 'xterm-256color',
  promptPattern: '[#$%>❯»]\\s*$',
  historyRetentionMs: 86_400_000,
  historyMaxBytesPerSession: 8 * 1024 * 1024,
  historyMaxSessions: 100,
  historyFlushIntervalMs: 250,
  scriptsDir: 'scripts',
  maxDetachedSessions: 20,
  autoReconnect: false,
  autoReconnectAttempts: 3,
  autoReconnectDelayMs: 2_000,
})

/**
 * Normalise a raw row config into a complete, bounded configuration.
 * @param {unknown} input raw config from the Loader row.
 * @returns {typeof DEFAULT_CONFIG} resolved config.
 */
export function resolveConfig(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const routePath =
    typeof source.routePath === 'string' && source.routePath.startsWith('/') && source.routePath.length > 1
      ? source.routePath.replace(/\/+$/, '')
      : DEFAULT_CONFIG.routePath
  const policy = source.knownHostsPolicy
  return {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled === true,
    aiAccessDefault: AI_ACCESS_MODES.includes(source.aiAccessDefault) ? source.aiAccessDefault : DEFAULT_CONFIG.aiAccessDefault,
    aiAutoLock: source.aiAutoLock === undefined ? DEFAULT_CONFIG.aiAutoLock : source.aiAutoLock === true,
    aiLockIdleMs: boundInteger(source.aiLockIdleMs, DEFAULT_CONFIG.aiLockIdleMs, 1000, 3_600_000),
    blockHumanWhileAi: source.blockHumanWhileAi === undefined ? DEFAULT_CONFIG.blockHumanWhileAi : source.blockHumanWhileAi === true,
    humanCanPreempt: source.humanCanPreempt === undefined ? DEFAULT_CONFIG.humanCanPreempt : source.humanCanPreempt === true,
    maxSessions: boundInteger(source.maxSessions, DEFAULT_CONFIG.maxSessions, 1, 128),
    scrollback: boundInteger(source.scrollback, DEFAULT_CONFIG.scrollback, 100, 100_000),
    replayBufferBytes: boundInteger(source.replayBufferBytes, DEFAULT_CONFIG.replayBufferBytes, 1024, 16 * 1024 * 1024),
    aiReadMaxBytes: boundInteger(source.aiReadMaxBytes, DEFAULT_CONFIG.aiReadMaxBytes, 1024, 16 * 1024 * 1024),
    deltaDefaultMaxBytes: boundInteger(source.deltaDefaultMaxBytes, DEFAULT_CONFIG.deltaDefaultMaxBytes, 256, 1024 * 1024),
    connectTimeoutMs: boundInteger(source.connectTimeoutMs, DEFAULT_CONFIG.connectTimeoutMs, 1000, 300_000),
    keepaliveMs: boundInteger(source.keepaliveMs, DEFAULT_CONFIG.keepaliveMs, 0, 600_000),
    routePath,
    knownHostsPolicy: policy === 'strict' || policy === 'insecure' ? policy : 'accept-new',
    terminalType:
      typeof source.terminalType === 'string' && source.terminalType.trim().length > 0 && source.terminalType.length <= 64
        ? source.terminalType.trim()
        : DEFAULT_CONFIG.terminalType,
    promptPattern:
      typeof source.promptPattern === 'string' && source.promptPattern.trim().length > 0 && source.promptPattern.length <= 512
        ? source.promptPattern
        : DEFAULT_CONFIG.promptPattern,
    historyRetentionMs: boundInteger(source.historyRetentionMs, DEFAULT_CONFIG.historyRetentionMs, 60_000, 30 * 86_400_000),
    historyMaxBytesPerSession: boundInteger(
      source.historyMaxBytesPerSession,
      DEFAULT_CONFIG.historyMaxBytesPerSession,
      64 * 1024,
      512 * 1024 * 1024,
    ),
    historyMaxSessions: boundInteger(source.historyMaxSessions, DEFAULT_CONFIG.historyMaxSessions, 1, 5000),
    historyFlushIntervalMs: boundInteger(source.historyFlushIntervalMs, DEFAULT_CONFIG.historyFlushIntervalMs, 50, 10_000),
    scriptsDir:
      typeof source.scriptsDir === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(source.scriptsDir)
        ? source.scriptsDir
        : DEFAULT_CONFIG.scriptsDir,
    maxDetachedSessions: boundInteger(source.maxDetachedSessions, DEFAULT_CONFIG.maxDetachedSessions, 0, 200),
    autoReconnect: source.autoReconnect === undefined ? DEFAULT_CONFIG.autoReconnect : source.autoReconnect === true,
    autoReconnectAttempts: boundInteger(source.autoReconnectAttempts, DEFAULT_CONFIG.autoReconnectAttempts, 0, 10),
    autoReconnectDelayMs: boundInteger(source.autoReconnectDelayMs, DEFAULT_CONFIG.autoReconnectDelayMs, 200, 60_000),
  }
}
