/**
 * Screen-reset bookkeeping for the xterm terminal (CONTRACTS.md §15, §17, §18).
 *
 * Every successful (re)connect rebuilds the remote screen: the Host resets its
 * `Screen` snapshot, keeps the output log and history, bumps
 * `SessionInfo.generation` and broadcasts
 * `{ type: 'reset', session: SessionInfo, reason }` on both SSE streams. The
 * terminal must then:
 *
 * 1. clear its buffer (`term.reset()`),
 * 2. print one localized notice line, and
 * 3. keep writing the following `data` frames on the *same* stream.
 *
 * The notice must be rendered once even though both streams may deliver the
 * frame. `store.js` dedupes the two deliveries into a single monotonic reset
 * entry (`seq`); the tracker below makes applying that entry idempotent per
 * terminal instance.
 *
 * This module is deliberately free of React and DOM so `scripts/smoke-client.mjs`
 * can exercise it inside `node:vm` with a fake terminal — there is no browser
 * in this environment.
 */

import { fmt } from './locale.js'

/** Locale key of the one-line notice printed after a screen reset. */
export const RESET_NOTICE_KEY = 'terminalResetNotice'

/**
 * Normalize a reset token (entry `seq`) or a session generation.
 *
 * @param value - Host- or store-provided number.
 * @returns a non-negative integer (0 when absent or malformed).
 */
export function normalizeToken(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.trunc(number)
}

/**
 * Localized notice line for a rebuilt screen.
 *
 * @param t - locale translate function.
 * @returns the notice text (unknown keys fall back to the key, never throw).
 */
export function resetNotice(t) {
  return fmt(t, RESET_NOTICE_KEY)
}

/**
 * Create the idempotence gate of one terminal instance.
 *
 * The tracker starts at the reset entry that was already recorded when the
 * terminal mounted: a stale entry must not wipe a freshly replayed buffer, and
 * two deliveries of the same entry must clear the screen only once.
 *
 * @param initialToken - reset entry `seq` already reflected on screen.
 * @returns `{ applied, claim(token), markApplied(token) }`.
 */
export function createResetTracker(initialToken = 0) {
  let applied = normalizeToken(initialToken)
  return {
    /** @returns the highest token applied so far. */
    get applied() {
      return applied
    },

    /**
     * Claim one reset entry.
     *
     * @param token - reset entry `seq`.
     * @returns true when this call must clear the terminal.
     */
    claim(token) {
      const next = normalizeToken(token)
      if (next <= applied) return false
      applied = next
      return true
    },

    /**
     * Record that a token is already reflected on screen (the `hello` replay
     * rebuilds the buffer itself, so it must not be cleared again).
     *
     * @param token - reset entry `seq`.
     */
    markApplied(token) {
      const next = normalizeToken(token)
      if (next > applied) applied = next
    },
  }
}

/**
 * Clear the terminal and print the notice, at most once per reset entry.
 *
 * @param term - xterm-like sink exposing `reset()` and `write()`.
 * @param t - locale translate function.
 * @param token - reset entry `seq`.
 * @param tracker - tracker from {@link createResetTracker}.
 * @returns true when the terminal was cleared.
 */
export function applyReset(term, t, token, tracker) {
  if (!term || !tracker || typeof term.reset !== 'function' || typeof term.write !== 'function') return false
  if (!tracker.claim(token)) return false
  term.reset()
  // xterm needs CRLF; the notice is terminal text, not chrome.
  term.write(resetNotice(t) + '\r\n')
  return true
}
