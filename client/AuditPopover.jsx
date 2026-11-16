/**
 * Bounded per-session audit popover.
 *
 * The popover reads `audit.list` through RPC when it opens, then keeps growing
 * from the live `audit` frames the session SSE stream delivers (pushed into the
 * shared store by the terminal view).
 */

import { useEffect, useRef, useState } from 'react'
import { errorMessage, fmt } from './locale.js'
import { rpc } from './api.js'
import { setAudit, useAppState } from './store.js'
import { C, S } from './styles.js'

const ACTION_KEYS = {
  read: 'auditRead',
  write: 'auditWrite',
  deny: 'auditDeny',
  lock: 'auditLock',
}

function timeLabel(at) {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour12: false })
  } catch {
    return ''
  }
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * Render the audit popover.
 *
 * @param props.t - locale translate function.
 * @param props.sessionId - selected session id (null hides the popover).
 * @param props.open - whether the popover is open.
 * @param props.onClose - close handler.
 * @param props.rootRef - element containing both the trigger and the popover.
 * @returns the popover, or null when closed.
 */
export function AuditPopover({ t, sessionId, open, onClose, rootRef }) {
  const state = useAppState()
  const popoverRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open || !sessionId) return undefined
    let cancelled = false
    setLoading(true)
    setError(null)
    rpc('audit.list', { id: sessionId, limit: 100 })
      .then((result) => {
        if (cancelled) return
        const entries = result && Array.isArray(result.entries) ? result.entries : []
        setAudit(sessionId, entries)
      })
      .catch((failure) => {
        if (!cancelled) setError(errorMessage(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const root = rootRef && rootRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      // The popover is the topmost layer: close it and stop here, otherwise the
      // panel's view-stack listener would also pop a level on the same press.
      event.stopPropagation()
      if (typeof event.preventDefault === 'function') event.preventDefault()
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose, rootRef])

  if (!open || !sessionId) return null

  const entries = (state.audit[sessionId] || []).slice().reverse()

  return (
    <div ref={popoverRef} style={S.popover} role="dialog" aria-label={t('audit')}>
      <div style={S.popoverHeader}>
        <span style={{ flex: 1, minWidth: 0 }}>{t('audit')}</span>
      </div>
      <div style={S.auditList}>
        {loading && entries.length === 0 ? <div style={S.auditEmpty}>{t('auditLoading')}</div> : null}
        {!loading && entries.length === 0 ? <div style={S.auditEmpty}>{t('auditEmpty')}</div> : null}
        {entries.map((entry, index) => {
          const actionKey = ACTION_KEYS[entry.action] || 'auditRead'
          const source = entry.source === 'ai' ? t('sourceAi') : t('sourceHuman')
          const detail = oneLine(entry.detail)
          return (
            <div key={`${entry.at}-${index}`} style={S.auditRow} title={detail || undefined}>
              <span style={S.auditTime}>{timeLabel(entry.at)}</span>
              <span
                style={{
                  ...S.auditBadge,
                  color: entry.source === 'ai' ? C.warnLabel : C.labelSecondary,
                }}
              >
                {source}
              </span>
              <span
                style={{
                  ...S.auditBadge,
                  color: entry.action === 'deny' ? C.danger : C.labelSecondary,
                }}
              >
                {t(actionKey)}
              </span>
              <span style={S.auditDetail}>{detail || '—'}</span>
            </div>
          )
        })}
      </div>
      {error ? (
        <div style={{ ...S.formError, margin: 6 }}>{fmt(t, 'auditFailed', { message: error })}</div>
      ) : null}
    </div>
  )
}
