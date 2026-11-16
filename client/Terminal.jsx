/**
 * xterm.js terminal bound to one Host session.
 *
 * Responsibilities (CONTRACTS.md §5 and §6):
 * - open one xterm instance per session and fit it to the sidebar pane;
 * - consume `GET /aiterm/events?sessionId=<id>` (`hello` replay, `data`,
 *   `state`, `exit`, `audit` frames), writing raw base64 bytes to xterm;
 * - send keystrokes through `sessions.input` (human source) with a small queue,
 *   refusing to send while the human-write lock is held;
 * - report resize through `sessions.resize`.
 *
 * The vendor xterm stylesheet is imported as text and rendered as a React
 * `<style>` element inside this subtree, so no node is appended to
 * `document.head` or `document.body`.
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { ROUTE, currentOwner, decodeBase64, parseFrame, rpc } from './api.js'
import { errorMessage, fmt } from './locale.js'
import { applyReset, createResetTracker } from './reset.js'
import { applyResetFrame, markSessionClosed, mergeSession, notify, pushAudit, resetEntryFor, setTerminalSize } from './store.js'
import { C } from './styles.js'
import { buildTerminalTheme, terminalOptions, TERMINAL_CSS_OVERRIDES } from './terminal-theme.js'

const MAX_PENDING_INPUT = 32768
const MAX_CHUNK = 8192

/**
 * Render one live terminal.
 *
 * @param props.t - locale translate function.
 * @param props.session - normalized Host session (id, permission, state).
 * @param props.onLinkChange - receives 'connecting' | 'open' | 'error' | 'closed'.
 * @param props.reset - latest reset entry `{ seq, generation, reason, at }` or null
 *   (recorded by the store from the `reset` frame or a `generation` bump).
 * @returns the terminal host.
 */
export function TerminalView({ t, session, onLinkChange, reset }) {
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const tRef = useRef(typeof t === 'function' ? t : (key) => key)
  const sessionRef = useRef(session)
  const linkRef = useRef(onLinkChange)
  const [fatal, setFatal] = useState(null)
  // A reset entry that predates this terminal is already reflected by the
  // replay path, so it must not wipe the freshly replayed buffer.
  const resetTrackerRef = useRef(createResetTracker(reset && reset.seq ? reset.seq : 0))

  tRef.current = typeof t === 'function' ? t : (key) => key
  sessionRef.current = session
  linkRef.current = onLinkChange

  const inputLocked = Boolean(session.permission.humanWriteBlocked)
  const ended = session.state === 'closed' || session.state === 'failed'
  const disconnected = session.state === 'disconnected'


  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    let cancelled = false
    let source = null
    let resizeTimer = 0
    let fitFrame = 0
    let observer = null
    let dataSubscription = null
    let resizeSubscription = null
    let term = null
    let fit = null
    const queue = { text: '', busy: false }

    const current = () => sessionRef.current
    const translate = () => tRef.current
    const reportLink = (value) => {
      if (cancelled) return
      try {
        linkRef.current?.(value)
      } catch (error) {
        console.error('[aiterm] link reporter failed', error)
      }
    }

    const flushInput = () => {
      if (queue.busy || queue.text === '' || cancelled) return
      const snapshot = current()
      // The Host accepts input only on an open session (a disconnected session
      // answers NOT_CONNECTED) and only when the human holds the write path.
      if (snapshot.state !== 'open' || snapshot.permission.humanWriteBlocked) {
        queue.text = ''
        return
      }
      const data = queue.text.slice(0, MAX_CHUNK)
      queue.text = queue.text.slice(MAX_CHUNK)
      queue.busy = true
      rpc('sessions.input', { id: current().id, data })
        .catch((error) => {
          if (cancelled) return
          const code = error && typeof error.code === 'string' ? error.code : ''
          if (code === 'HUMAN_WRITE_BLOCKED') {
            queue.text = ''
            notify(fmt(translate(), 'blockedTitle'))
            return
          }
          // A session that is gone, closed, or overflowing cannot drain the
          // queue; drop it so a stale keystroke cannot retry forever.
          if (code === 'NOT_CONNECTED' || code === 'SESSION_NOT_FOUND' || code === 'WRITE_FAILED' || code === 'INPUT_TOO_LARGE') {
            queue.text = ''
          }
          notify(fmt(translate(), 'inputFailed', { message: errorMessage(error) }))
        })
        .finally(() => {
          queue.busy = false
          if (!cancelled) flushInput()
        })
    }

    const applyFit = () => {
      if (cancelled || !fit || !term) return
      try {
        if (host.clientWidth < 24 || host.clientHeight < 24) return
        fit.fit()
        // Publish the fitted geometry so `sessions.reconnect` can size the new
        // pty before the Host rebuilds the screen (CONTRACTS.md §17).
        setTerminalSize(current().id, term.cols, term.rows)
      } catch {
        /* the pane may be hidden while collapsing; a later resize retries */
      }
    }

    const scheduleFit = () => {
      if (cancelled) return
      if (fitFrame) cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0
        applyFit()
      })
    }

    try {
      term = new Terminal(terminalOptions({
        cols: Math.max(20, Number(current().cols) || 80),
        rows: Math.max(5, Number(current().rows) || 24),
        disableStdin: Boolean(current().permission.humanWriteBlocked) || current().state !== 'open',
      }))
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
    } catch (error) {
      console.error('[aiterm] terminal failed to open', error)
      setFatal(errorMessage(error))
      reportLink('error')
      return undefined
    }

    dataSubscription = term.onData((data) => {
      if (cancelled || !data) return
      const snapshot = current()
      // The Host accepts input only on an open session and only when the human
      // holds the write path (CONTRACTS §4).
      if (snapshot.state !== 'open') return
      if (snapshot.permission.humanWriteBlocked) return
      if (queue.text.length + data.length > MAX_PENDING_INPUT) {
        queue.text = ''
        notify(fmt(translate(), 'inputOverflow'))
        return
      }
      queue.text += data
      queueMicrotask(flushInput)
    })

    resizeSubscription = term.onResize(({ cols, rows }) => {
      if (cancelled) return
      setTerminalSize(current().id, cols, rows)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = 0
        if (cancelled) return
        rpc('sessions.resize', { id: current().id, cols, rows }).catch(() => {})
      }, 250)
    })

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleFit)
      observer.observe(host)
    }
    scheduleFit()

    const openStream = () => {
      let nextSource
      try {
        // The stream is owner-checked by the Host: a session opened in another
        // AI session must not stream into this panel.
        const owner = currentOwner()
        const ownerQuery = owner === undefined ? '' : '&owner=' + encodeURIComponent(owner)
        nextSource = new EventSource(ROUTE + '/events?sessionId=' + encodeURIComponent(current().id) + ownerQuery)
      } catch (error) {
        console.error('[aiterm] event stream failed', error)
        reportLink('error')
        return
      }
      source = nextSource
      reportLink('connecting')

      nextSource.onopen = () => {
        if (!cancelled) reportLink('open')
      }

      nextSource.onerror = () => {
        if (cancelled) return
        const snapshot = current()
        if (snapshot.state === 'closed' || snapshot.state === 'failed') {
          // Nothing left to reconnect to; the Host closed this stream.
          try {
            nextSource.close()
          } catch {
            /* ignore */
          }
          reportLink('closed')
          return
        }
        // EventSource retries by itself after a dropped stream.
        reportLink('error')
      }

      nextSource.onmessage = (event) => {
        if (cancelled) return
        const frame = parseFrame(event.data)
        if (!frame) return
        try {
          if (frame.type === 'hello') {
            if (!term) return
            term.reset()
            const replay = decodeBase64(frame.replay)
            if (replay.length > 0) term.write(replay)
            else {
              rpc('sessions.replay', { id: current().id })
                .then((result) => {
                  if (cancelled || !term) return
                  const bytes = decodeBase64(result && result.replay)
                  if (bytes.length > 0) term.write(bytes)
                })
                .catch(() => {})
            }
            if (frame.session) {
              mergeSession(frame.session)
              // `hello` replayed the retained bytes into a freshly reset buffer:
              // the rebuild it announces is already on screen, so consume the
              // reset entry instead of clearing the replay away.
              const entry = resetEntryFor(current().id)
              if (entry && entry.seq) resetTrackerRef.current.markApplied(entry.seq)
            }
            reportLink('open')
            scheduleFit()
          } else if (frame.type === 'data') {
            if (!term || typeof frame.chunk !== 'string' || frame.chunk === '') return
            const bytes = decodeBase64(frame.chunk)
            if (bytes.length > 0) term.write(bytes)
          } else if (frame.type === 'reset') {
            // The remote screen was rebuilt after a reconnect (§15/§18). Record
            // it in the store; the reset effect below clears the buffer once.
            // The same session id keeps streaming, so this stream is NOT
            // resubscribed here — it is only reopened when it actually closed.
            applyResetFrame(frame)
          } else if (frame.type === 'state') {
            mergeSession(frame.session)
          } else if (frame.type === 'exit') {
            const code = typeof frame.code === 'number' ? frame.code : null
            markSessionClosed(current().id, typeof frame.reason === 'string' ? frame.reason : undefined)
            reportLink('closed')
            notify(code === null ? translate()('sessionEnded') : fmt(translate(), 'sessionExited', { code }))
            try {
              nextSource.close()
            } catch {
              /* ignore */
            }
            if (source === nextSource) source = null
          } else if (frame.type === 'audit') {
            pushAudit(current().id, frame.entry)
          }
        } catch (error) {
          // A malformed frame must never blank the slot.
          console.error('[aiterm] terminal frame failed', error)
        }
      }
    }

    openStream()

    return () => {
      cancelled = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (fitFrame) cancelAnimationFrame(fitFrame)
      try {
        observer?.disconnect()
      } catch {
        /* ignore */
      }
      try {
        source?.close()
      } catch {
        /* ignore */
      }
      try {
        dataSubscription?.dispose()
      } catch {
        /* ignore */
      }
      try {
        resizeSubscription?.dispose()
      } catch {
        /* ignore */
      }
      try {
        term?.dispose()
      } catch {
        /* ignore */
      }
      termRef.current = null
    }
  }, [session.id])

  // Reflect the human-write lock (and a non-open session) on xterm's stdin gate
  // without remounting. A `disconnected` session cannot read or write (§15), so
  // its stdin stays closed until the reconnect succeeds.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.options.disableStdin = inputLocked || ended || session.state !== 'open'
      // A session with no transport must not keep the keyboard focus: typing
      // into a disconnected terminal would collect a queue the Host refuses.
      if (inputLocked || session.state !== 'open') term.blur()
    } catch (error) {
      console.error('[aiterm] could not update stdin gate', error)
    }
  }, [inputLocked, ended, session.state])

  // Clear the buffer and print the localized notice when the Host rebuilt the
  // remote screen (§15/§18). The store records one entry per rebuild whether it
  // arrived as a `reset` frame (either stream) or as a `generation` bump, and
  // the tracker makes this idempotent, so the notice renders exactly once.
  useEffect(() => {
    const term = termRef.current
    const token = reset && reset.seq ? reset.seq : 0
    if (!term || !token) return
    try {
      if (!applyReset(term, tRef.current, token, resetTrackerRef.current)) return
      try {
        term.scrollToBottom()
      } catch {
        /* a pane that is still hidden may not scroll yet */
      }
    } catch (error) {
      // A failed reset must never blank the slot body.
      console.error('[aiterm] could not clear the screen after a reconnect', error)
    }
  }, [reset ? reset.seq : 0, session.id])

  // Follow host theme changes (attribute flips) with the terminal palette.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const apply = () => {
      const term = termRef.current
      if (!term) return
      try {
        term.options.theme = buildTerminalTheme()
      } catch {
        /* ignore */
      }
    }
    const observer = new MutationObserver(apply)
    const options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] }
    try {
      observer.observe(document.documentElement, options)
      if (document.body) observer.observe(document.body, options)
    } catch {
      /* ignore */
    }
    return () => {
      try {
        observer.disconnect()
      } catch {
        /* ignore */
      }
    }
  }, [])

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
      <style>{xtermCss + TERMINAL_CSS_OVERRIDES}</style>
      <div
        ref={hostRef}
        className="dsst-term-host"
        // Explains why typing does nothing while the transport is gone.
        title={disconnected ? fmt(tRef.current, 'disconnectedHint') : undefined}
      />
      {fatal ? (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            textAlign: 'center',
            color: C.danger,
            fontSize: 11,
            lineHeight: 1.5,
            background: C.bgBase,
          }}
        >
          {fmt(tRef.current, 'connectFailed', { message: fatal })}
        </div>
      ) : null}
    </div>
  )
}
