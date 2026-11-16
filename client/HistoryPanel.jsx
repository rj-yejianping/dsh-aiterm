/**
 * 历史（History）panel: search persisted terminal output of any session.
 *
 * Opens from the control bar as an overlay inside the tab body. Data comes from
 * two RPCs (CONTRACTS.md §12.3):
 * - `history.sessions` `{ limit? }` → `{ sessions: CatalogEntry[] }`
 * - `history.query` `{ sessionId, since?, until?, search?, context?, maxMatches?, maxBytes? }`
 *   → `{ matches: [{ at, line, before[], after[] }], truncated, scannedBytes, entry? }`
 *
 * Every payload is normalized defensively and both async paths have an inline
 * error state, so an empty catalog or a failing Host RPC can never blank the
 * slot. The panel only ever reads — it never sends input to a terminal.
 */

import { useEffect, useRef, useState } from 'react'
import {
  copyText,
  formatBytes,
  formatStamp,
  formatTimeOfDay,
  highlightPattern,
  historyExport,
  historyQuery,
  historySessions,
  autologGet,
  autologSet,
  hostSearchValue,
  normalizeCatalogEntry,
  normalizeHistoryQuery,
  parseTimeInput,
  splitHighlight,
} from './api.js'
import { errorMessage, fmt } from './locale.js'
import { notify } from './store.js'
import { Btn, Field, Segmented, Sheet } from './ui.jsx'
import { C, S } from './styles.js'

const CONTEXT_CHOICES = ['0', '1', '2', '3', '4', '5']

/**
 * One context line (before/after a match); the timestamp column stays blank.
 *
 * @param props.line - context line text.
 * @returns the row.
 */
function ContextRow({ line }) {
  return (
    <div style={S.matchRow}>
      <span style={S.matchTime} />
      <span style={S.contextText}>{line}</span>
    </div>
  )
}

/**
 * One match row with keyword highlighting.
 *
 * @param props.match - normalized match.
 * @param props.pattern - highlight pattern (may be null).
 * @returns the row.
 */
function MatchRow({ match, pattern }) {
  const parts = splitHighlight(match.line, pattern)
  return (
    <div style={S.matchRow}>
      <span style={S.matchTime}>{formatTimeOfDay(match.at)}</span>
      <span style={S.matchText}>
        {parts.map((part, index) => (part.hit
          ? <span key={`h${index}`} style={S.matchHit}>{part.text}</span>
          : <span key={`p${index}`}>{part.text}</span>))}
      </span>
    </div>
  )
}

/**
 * Render the history panel.
 *
 * @param props.t - locale translate function.
 * @param props.sessionId - currently selected session (used as the default pick).
 * @param props.onClose - close handler.
 * @returns the panel.
 */
export function HistoryPanel({ t, sessionId, onClose }) {
  const [sessions, setSessions] = useState([])
  const [listState, setListState] = useState('loading')
  const [listError, setListError] = useState(null)
  const [pickedId, setPickedId] = useState(null)
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [search, setSearch] = useState('')
  const [context, setContext] = useState('0')
  const [result, setResult] = useState(null)
  const [pattern, setPattern] = useState(null)
  /** Auto-log (write every session to a file) state. */
  const [autoLog, setAutoLog] = useState({ enabled: false, dir: '' })
  const [autoLogBusy, setAutoLogBusy] = useState(false)
  /**
   * False when the running Host predates the export / auto-log RPCs. The
   * client bundle updates on refresh but the Host only on restart, so a fresh
   * page against an old process must say "restart" instead of "unknown RPC".
   */
  const [logBackend, setLogBackend] = useState(true)
  /** Last export result: file paths on the Host. */
  const [exported, setExported] = useState(null)
  const [exportBusy, setExportBusy] = useState('')
  const [exportError, setExportError] = useState(null)
  const [queryState, setQueryState] = useState('idle')
  const [queryError, setQueryError] = useState(null)
  const [manualText, setManualText] = useState(null)
  const bodyRef = useRef(null)
  const requestRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    let cancelled = false
    const load = async () => {
      if (!cancelled) {
        setListState('loading')
        setListError(null)
      }
      try {
        const raw = await historySessions({ limit: 50 })
        if (cancelled || !aliveRef.current) return
        const list = raw && Array.isArray(raw.sessions)
          ? raw.sessions.map(normalizeCatalogEntry).filter(Boolean)
          : []
        // Newest first, including closed sessions (CONTRACTS.md §12.3).
        list.sort((left, right) => (right.lastTs || right.createdAt) - (left.lastTs || left.createdAt))
        setSessions(list)
        setListState(list.length > 0 ? 'ready' : 'empty')
        const preferred = list.find((entry) => entry.id === sessionId) || list[0]
        setPickedId(preferred ? preferred.id : null)
      } catch (error) {
        if (cancelled || !aliveRef.current) return
        setListError(errorMessage(error))
        setListState('error')
      }
    }
    load()
    return () => {
      cancelled = true
      aliveRef.current = false
    }
  }, [])

  /**
   * Run one query. Time fields are parsed client-side so an invalid value can
   * be reported inline before any RPC is attempted.
   *
   * @param id - catalog session id (defaults to the picked session).
   * @param filters - the filter fields captured at call time.
   */
  async function runQuery(id = pickedId, filters = { since, until, search, context }) {
    if (!id) {
      setQueryState('empty')
      setQueryError(null)
      setResult(null)
      return
    }

    const sinceParsed = parseTimeInput(filters.since)
    const untilParsed = parseTimeInput(filters.until)
    if (!sinceParsed.ok) {
      setQueryState('error')
      setQueryError(fmt(t, 'historyTimeInvalid', { value: String(filters.since || '').trim() }))
      return
    }
    if (!untilParsed.ok) {
      setQueryState('error')
      setQueryError(fmt(t, 'historyTimeInvalid', { value: String(filters.until || '').trim() }))
      return
    }

    const token = requestRef.current + 1
    requestRef.current = token
    setQueryState('loading')
    setQueryError(null)
    setPattern(highlightPattern(filters.search))

    try {
      const raw = await historyQuery({
        sessionId: id,
        since: sinceParsed.at,
        until: untilParsed.at,
        search: hostSearchValue(filters.search),
        context: Number(filters.context) || 0,
        maxMatches: 200,
      })
      if (requestRef.current !== token || !aliveRef.current) return
      const normalized = normalizeHistoryQuery(raw)
      setResult(normalized)
      const fragment = normalized.matches.length === 0 ? normalized.text.trim() : ''
      setQueryState(normalized.matches.length > 0 || fragment !== '' ? 'ready' : 'empty')
    } catch (error) {
      if (requestRef.current !== token || !aliveRef.current) return
      setQueryError(fmt(t, 'historyQueryFailed', { message: errorMessage(error) }))
      setQueryState('error')
      setResult(null)
    }
  }

  // Query the preferred session as soon as the catalog resolves (and whenever
  // the user picks another one), honouring the filters typed so far.
  useEffect(() => {
    if (!pickedId) return
    runQuery(pickedId, { since, until, search, context })
  }, [pickedId])

  const selectSession = (id) => {
    if (id === pickedId) {
      runQuery(id)
      return
    }
    setPickedId(id)
    setResult(null)
    setQueryState('idle')
    setQueryError(null)
    setManualText(null)
  }

  const fragmentLines = result && result.matches.length === 0 && result.text.trim() !== ''
    ? result.text.replace(/\n+$/, '').split('\n')
    : []
  const hasMatches = Boolean(result && result.matches.length > 0)
  const hasContent = hasMatches || fragmentLines.length > 0
  const resultCount = hasMatches ? result.matches.length : fragmentLines.length

  const copyResults = async () => {
    if (!hasContent) return
    const text = hasMatches
      ? result.matches.map((match) => `${formatTimeOfDay(match.at)}  ${match.line}`).join('\n')
      : result.text
    try {
      const ok = await copyText(text, bodyRef.current)
      if (ok) notify(t('copied'))
      else {
        setManualText(text)
        notify(t('historyCopyFailed'))
      }
    } catch {
      setManualText(text)
      notify(t('historyCopyFailed'))
    }
  }

  // Read the auto-log switch once when the panel opens (Host owns the truth).
  useEffect(() => {
    let cancelled = false
    autologGet()
      .then((state) => {
        if (cancelled || !state) return
        setAutoLog({
          enabled: state.enabled === true,
          dir: typeof state.dir === 'string' ? state.dir : '',
        })
      })
      .catch((error) => {
        if (cancelled) return
        if (error && error.code === 'UNKNOWN_METHOD') setLogBackend(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Export session output to files on the Host.
   *
   * @param scope - `'current'` for the picked session, `'all'` for every session.
   * @returns {Promise<void>} resolves when the result (or error) is shown.
   */
  const runExport = async (scope) => {
    if (exportBusy) return
    setExportBusy(scope)
    setExportError(null)
    try {
      const params =
        scope === 'all'
          ? { all: true }
          : { sessionId: pickedId || (sessionId || undefined) }
      const result = await historyExport(params)
      setExported(result || null)
      const files = result && Array.isArray(result.files) ? result.files : []
      notify(files.length > 0 ? fmt(t, 'historyExportDone', { count: files.length }) : t('historyExportEmpty'))
    } catch (error) {
      if (error && error.code === 'UNKNOWN_METHOD') {
        setLogBackend(false)
        setExportError(t('historyExportNeedsRestart'))
      } else {
        setExportError(errorMessage(error))
      }
    } finally {
      setExportBusy('')
    }
  }

  /** Flip the Host auto-log switch. @returns {Promise<void>} resolves when applied. */
  const toggleAutoLog = async () => {
    if (autoLogBusy) return
    setAutoLogBusy(true)
    try {
      const next = await autologSet({ enabled: !autoLog.enabled })
      setAutoLog({
        enabled: next && next.enabled === true,
        dir: next && typeof next.dir === 'string' ? next.dir : autoLog.dir,
      })
      notify(next && next.enabled === true ? t('historyAutoLogOn') : t('historyAutoLogOff'))
    } catch (error) {
      if (error && error.code === 'UNKNOWN_METHOD') {
        setLogBackend(false)
        notify(t('historyExportNeedsRestart'))
      } else {
        notify(fmt(t, 'historyAutoLogFailed', { message: errorMessage(error) }))
      }
    } finally {
      setAutoLogBusy(false)
    }
  }

  const footer = (
    <>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {result
          ? `${fmt(t, 'historyFooter', {
            size: formatBytes(result.scannedBytes),
            count: resultCount,
          })}${result.truncated ? ` · ${t('historyTruncated')}` : ''}`
          : t('historyEmptyQuery')}
      </span>
      <span style={S.controlSpacer} />
      <Btn
        onClick={copyResults}
        disabled={!hasContent}
        title={t('historyCopy')}
      >
        {t('historyCopy')}
      </Btn>
      <Btn
        onClick={() => runExport('current')}
        busy={exportBusy === 'current'}
        disabled={exportBusy !== '' || !logBackend}
        title={logBackend ? fmt(t, 'historyExportHint', { dir: autoLog.dir || '~/.dsh/aiterm/exports' }) : t('historyExportNeedsRestart')}
      >
        {t('historyExportOne')}
      </Btn>
      <Btn
        onClick={() => runExport('all')}
        busy={exportBusy === 'all'}
        disabled={exportBusy !== '' || !logBackend}
        title={logBackend ? t('historyExportAllHint') : t('historyExportNeedsRestart')}
      >
        {t('historyExportAll')}
      </Btn>
    </>
  )

  return (
    <Sheet
      title={t('historyTitle')}
      onBack={onClose}
      backLabel={t('historyPanelClose')}
      footer={footer}
    >
      <div style={S.sectionTitle}>{t('historySessionsTitle')}</div>

      {listState === 'loading' ? <div style={S.auditEmpty}>{t('historyLoadingSessions')}</div> : null}
      {listState === 'error' ? (
        <div style={S.formError} role="alert">{fmt(t, 'historySessionsFailed', { message: listError })}</div>
      ) : null}
      {listState === 'empty' ? <div style={S.auditEmpty}>{t('historySessionsEmpty')}</div> : null}

      {sessions.length > 0 ? (
        <div style={S.listBox} role="listbox" aria-label={t('historySessionsTitle')}>
          {sessions.map((entry) => {
            const active = entry.id === pickedId
            const created = entry.createdAt > 0 ? formatStamp(entry.createdAt) : '—'
            const closed = entry.closedAt ? formatStamp(entry.closedAt) : t('historyOngoing')
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={active}
                title={`${entry.title} · ${entry.host || entry.transport}`}
                style={{ ...S.listRow, ...(active ? S.listRowActive : null) }}
                onClick={() => selectSession(entry.id)}
              >
                <span style={S.listRowTitle}>{entry.title}</span>
                <span style={S.listRowMeta}>
                  {`${entry.host || entry.transport} · ${created}→${closed} · ${formatBytes(entry.bytes)}`}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      <div style={S.filterRow}>
        <Field label={t('historySince')} style={S.grow}>
          <input
            style={S.input}
            value={since}
            placeholder="10m"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setSince(event.target.value)}
            onKeyDown={(event) => {
              if (event && event.key === 'Enter') runQuery()
            }}
          />
        </Field>
        <Field label={t('historyUntil')} style={S.grow}>
          <input
            style={S.input}
            value={until}
            placeholder=""
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setUntil(event.target.value)}
            onKeyDown={(event) => {
              if (event && event.key === 'Enter') runQuery()
            }}
          />
        </Field>
        <div style={{ flex: 'none', width: 62 }}>
          <Field label={t('historyContext')}>
            <select
              style={S.select}
              value={context}
              onChange={(event) => setContext(event.target.value)}
            >
              {CONTEXT_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <Field label={t('historySearch')} hint={t('historySearchHint')}>
        <input
          style={S.input}
          value={search}
          placeholder="error|timeout"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event && event.key === 'Enter') runQuery()
          }}
        />
      </Field>

      <div style={S.actionRow}>
        <Btn
          variant="primary"
          onClick={() => runQuery()}
          disabled={!pickedId || queryState === 'loading'}
        >
          {queryState === 'loading' ? t('historyQuerying') : t('historyQuery')}
        </Btn>
      </div>

      {queryState === 'error' && queryError ? (
        <div style={S.formError} role="alert">{queryError}</div>
      ) : null}

      {!pickedId && listState !== 'loading' ? <div style={S.auditEmpty}>{t('historyNeedSession')}</div> : null}

      {queryState === 'empty' && !queryError ? (
        <div style={S.auditEmpty}>
          {t('historyNoMatches')}
          <span style={{ display: 'block', fontSize: 10 }}>{t('historyNoMatchesHint')}</span>
        </div>
      ) : null}

      {hasMatches ? (
        <div ref={bodyRef} style={S.scrollArea}>
          {result.matches.map((match, index) => (
            <div
              key={`${match.at}-${index}`}
              style={{ display: 'flex', flexDirection: 'column', flex: 'none', padding: '2px 0', borderBottom: `0.5px solid ${C.borderL1}` }}
            >
              {match.before.map((line, lineIndex) => <ContextRow key={`b${lineIndex}`} line={line} />)}
              <MatchRow match={match} pattern={pattern} />
              {match.after.map((line, lineIndex) => <ContextRow key={`a${lineIndex}`} line={line} />)}
            </div>
          ))}
        </div>
      ) : null}

      {!hasMatches && fragmentLines.length > 0 ? (
        <div ref={bodyRef} style={S.scrollArea}>
          <div style={S.hint}>{t('historyFragment')}</div>
          {fragmentLines.map((line, index) => (
            <div key={`f${index}`} style={S.matchRow}>
              <span style={S.matchText}>{line}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={S.sectionTitle}>{t('historyLogFileTitle')}</div>
      {!logBackend ? (
        <div style={S.hint} role="status">{t('historyExportNeedsRestart')}</div>
      ) : null}
      <label style={S.checkRow}>
        <input
          type="checkbox"
          checked={autoLog.enabled}
          disabled={autoLogBusy || !logBackend}
          onChange={() => toggleAutoLog()}
          style={S.pickBox}
        />
        <span style={S.checkLabel}>{t('historyAutoLogLabel')}</span>
      </label>
      <span style={S.hint}>
        {autoLog.enabled ? fmt(t, 'historyAutoLogWhere', { dir: autoLog.dir }) : t('historyAutoLogOffHint')}
      </span>

      {exportError ? (
        <div style={S.formError} role="alert">
          {fmt(t, 'historyExportFailed', { message: exportError })}
        </div>
      ) : null}
      {exported ? (
        <div style={S.exportBox} role="status">
          <div style={S.hint}>{fmt(t, 'historyExportWhere', { dir: exported.dir || '' })}</div>
          {(exported.files || []).map((file) => (
            <div key={file.path} style={S.exportRow}>
              <span style={S.exportPath} title={file.path}>{file.path}</span>
              <span style={S.exportMeta}>
                {`${formatBytes(file.bytes)} · ${fmt(t, 'historyExportLines', { count: file.lines })}`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {manualText !== null ? (
        <div style={{ flex: 'none', padding: 6, border: `0.5px solid ${C.borderL2}`, borderRadius: C.radiusSm, background: C.bgLayer1 }}>
          <div style={S.hint}>{t('historyManualCopy')}</div>
          <textarea
            style={S.textarea}
            readOnly
            value={manualText}
            onFocus={(event) => {
              try {
                event.target.select()
              } catch {
                /* ignore */
              }
            }}
          />
        </div>
      ) : null}
    </Sheet>
  )
}
