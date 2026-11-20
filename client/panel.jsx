/**
 * Right-sidebar panel: session rail, control bar, terminal and connect form.
 *
 * All state comes from the shared store (`store.js`): the global SSE stream
 * keeps the session list live, and each selected session opens its own stream
 * inside {@link TerminalView}. Every visible string is localized through the
 * `aiterm` namespace; every color is a `--dsw-alias-*` token.
 */

import { useEffect, useRef, useState } from 'react'
import {
  copyText,
  formatBytes,
  normalizeScreenResult,
  readScreen,
  rpc,
  sessionsDisconnect,
  sessionsReconnect,
} from './api.js'
import { errorMessage, fmt } from './locale.js'
import {
  canGoBack,
  closeConnectView,
  closePanel,
  getTerminalSize,
  markSessionClosed,
  mergeSession,
  notify,
  openConnectView,
  openPanel,
  patchPermission,
  popView,
  refreshSessions,
  releaseGlobalStream,
  retainGlobalStream,
  selectSession,
  setOwner,
  useAppState,
} from './store.js'
import { TerminalView } from './Terminal.jsx'
import { QuickScripts } from './QuickScripts.jsx'
import { ConnectForm } from './ConnectForm.jsx'
import { AuditPopover } from './AuditPopover.jsx'
import { HistoryPanel } from './HistoryPanel.jsx'
import { ProfilesPanel } from './ProfilesPanel.jsx'
import { ScriptsPanel } from './ScriptsPanel.jsx'
import {
  AuditIcon,
  Btn,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  HistoryIcon,
  IconBtn,
  InlineConfirm,
  LockIcon,
  PlusIcon,
  ProfilesIcon,
  RefreshIcon,
  ScriptIcon,
  Segmented,
  StateDot,
  TerminalIcon,
  Toast,
  PowerIcon,
  useFocusRing,
} from './ui.jsx'
import { C, S } from './styles.js'

function translate(t) {
  return typeof t === 'function' ? t : (key) => key
}

function selectedSessionOf(state) {
  if (!state.sessions || state.sessions.length === 0) return null
  const match = state.sessions.find((session) => session.id === state.selectedId)
  return match || state.sessions[0]
}

/**
 * The tab body rendered into `sidebar.right.pane.tab`.
 *
 * `sessionId` is the DSH (AI) session this panel is mounted in. Terminals
 * belong to the AI session that opened them, so it is pushed into the store
 * before anything is fetched: switching conversations must show that
 * conversation's terminals, never the previous one's.
 *
 * @param props.t - locale translate function injected by the slot's `locale`.
 * @param props.sessionId - DSH session id from the slot injection.
 * @returns the panel.
 */
export function Panel({ t: rawT, sessionId: dshSessionId }) {
  const t = translate(rawT)
  const state = useAppState()
  const selected = selectedSessionOf(state)

  useEffect(() => {
    setOwner(dshSessionId)
  }, [dshSessionId])

  useEffect(() => {
    retainGlobalStream()
    refreshSessions().catch(() => {})
    return () => releaseGlobalStream()
  }, [])

  // Keep the store's selection inside the live list.
  useEffect(() => {
    if (selected && state.selectedId !== selected.id) selectSession(selected.id)
  }, [selected ? selected.id : null, state.selectedId])

  // The connect form and the overlay panels are entries of the store's view
  // stack; the panel merely renders the top entry, so ← / Esc can always return
  // to where the user came from.
  //
  // One Escape owner for the whole tab body: each press leaves exactly one
  // level. Inline editors and the inline confirmation bar cancel themselves and
  // stop propagation before this bubble-phase listener runs, so they never
  // retreat two levels at once.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onKeyDown = (event) => {
      if (!event || event.key !== 'Escape') return
      if (event.defaultPrevented) return
      if (!popView()) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      try {
        document.removeEventListener('keydown', onKeyDown)
      } catch {
        /* ignore */
      }
    }
  }, [])

  if (!state.ready && state.sessions.length === 0) {
    return (
      <div style={S.root}>
        <div style={{ ...S.stateWrap, flex: 1 }}>{t('loading')}</div>
        <Toast toast={state.toast} />
      </div>
    )
  }

  // With no session, the connection library is the useful first screen: the user
  // picks a saved profile (or presses 新建连接) instead of being dropped into an
  // empty form. An explicit 新建/编辑 (view === 'connect') still wins.
  const profilesAsHome = !selected && state.view !== 'connect'
  // showForm must cover the no-session case: the terminal branch dereferences
  // `selected.id`, so a null session may never reach it.
  const showForm = state.view === 'connect' || !selected
  // Latest screen-rebuild event of the selected session (§15/§18). The terminal
  // clears once per entry; it can come from either SSE stream or from a
  // `generation` bump when the reset frame was missed.
  const reset = selected && state.resets ? state.resets[selected.id] || null : null

  return (
    <div style={S.root}>
      <SessionRail t={t} />
      {showForm ? (
        <ConnectForm
          key={state.connectDraft && state.connectDraft.id ? `edit:${state.connectDraft.id}` : 'new'}
          t={t}
          draft={state.connectDraft}
          onCancel={canGoBack() ? () => closeConnectView() : undefined}
          onSaved={(profileId) => closeConnectView(profileId)}
        />
      ) : (
        <>
          <ControlBar t={t} session={selected} />
          <TerminalPane key={selected.id} t={t} session={selected} reset={reset} />
        </>
      )}
      {!showForm && state.panel === 'history' ? (
        <HistoryPanel t={t} sessionId={selected ? selected.id : null} onClose={closePanel} />
      ) : null}
      {!showForm && state.panel === 'scripts' ? (
        <ScriptsPanel t={t} sessionId={selected ? selected.id : null} onClose={closePanel} />
      ) : null}
      {(profilesAsHome || (!showForm && state.panel === 'profiles')) ? (
        <ProfilesPanel t={t} onClose={profilesAsHome ? undefined : closePanel} />
      ) : null}
      <Toast toast={state.toast} />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Session rail
 * ------------------------------------------------------------------ */

function SessionRail({ t }) {
  const state = useAppState()
  /** Session waiting for the inline close confirmation. */
  const [closingId, setClosingId] = useState(null)
  const [closingBusy, setClosingBusy] = useState(false)
  // Profile management is a connection-library action, not a per-session one, so
  // it lives on the tab row as a labelled entry: the terminal view always has a
  // visible way back to the library (not just a tiny folder icon).
  const profilesOpen = state.panel === 'profiles'
  const toggleProfiles = () => {
    if (profilesOpen) closePanel()
    else openPanel('profiles')
  }

  const closing = closingId ? state.sessions.find((session) => session.id === closingId) || null : null
  // The rail must mark the same session the body below renders. The body uses
  // `selectedSessionOf()` (which falls back to the first session when the id is
  // stale); marking `state.selectedId` instead could leave every tab unmarked
  // while a terminal was displayed.
  const selected = selectedSessionOf(state)
  const activeId = selected ? selected.id : null
  /** Duplicate titles ("PC", "PC") get a #n suffix so tabs stay distinguishable. */
  const titleCounts = new Map()
  for (const session of state.sessions) {
    const base = session.title || ''
    titleCounts.set(base, (titleCounts.get(base) || 0) + 1)
  }
  const seenTitles = new Map()
  const labelFor = (session) => {
    const base = session.title || ''
    if ((titleCounts.get(base) || 0) < 2) return base
    const index = (seenTitles.get(base) || 0) + 1
    seenTitles.set(base, index)
    return `${base} #${index}`
  }

  const closeSession = async (id) => {
    if (closingBusy) return
    setClosingBusy(true)
    markSessionClosed(id)
    try {
      await rpc('sessions.close', { id })
    } catch (error) {
      notify(fmt(t, 'closeFailed', { message: errorMessage(error) }))
    } finally {
      setClosingBusy(false)
      setClosingId(null)
    }
  }

  return (
    <>
      <div style={S.rail} role="tablist" aria-label={t('sessions')}>
        {state.sessions.map((session) => {
          const active = session.id === activeId
          const disconnected = session.state === 'disconnected'
          const label = labelFor(session)
          return (
            <SessionChip
              key={session.id}
              t={t}
              session={session}
              label={label}
              active={active}
              disconnected={disconnected}
              onSelect={() => selectSession(session.id)}
              onRequestClose={() => setClosingId(session.id)}
            />
          )
        })}
        <span style={S.railSpacer} />
        <Btn
          variant={profilesOpen ? 'outline' : 'default'}
          title={t('profiles')}
          ariaLabel={t('profiles')}
          onClick={toggleProfiles}
          style={{ height: 32, padding: '0 8px' }}
        >
          <ProfilesIcon />
          {t('profiles')}
        </Btn>
        <button
          type="button"
          style={S.railAdd}
          title={t('newSession')}
          aria-label={t('newSession')}
          onClick={() => openConnectView()}
        >
          <PlusIcon />
        </button>
      </div>
      {closing ? (
        <div style={S.railConfirmWrap}>
          <InlineConfirm
            message={fmt(t, 'closeSessionPrompt', { title: closing.title })}
            confirmLabel={t('closeConfirm')}
            cancelLabel={t('cancel')}
            busy={closingBusy}
            onConfirm={() => closeSession(closing.id)}
            onCancel={() => setClosingId(null)}
          />
        </div>
      ) : null}
    </>
  )
}

/**
 * One session tab.
 *
 * Three visual states that must not be confused with each other:
 *  - **selected**: accent bar + accent border + accent-tinted surface + bold title;
 *  - **hover**: a soft wash only, always weaker than selected;
 *  - **keyboard focus**: the ring overlay, and only for real keyboard navigation
 *    (`useFocusRing` asks `:focus-visible` *and* the Host's input modality), so
 *    clicking a tab never leaves a white box behind — neither on the clicked tab
 *    nor on the tab that was selected before. The ring is a separate layer so it
 *    cannot replace the selected chip's accent bar.
 *
 * @param props.t - locale translator.
 * @param props.session - session info.
 * @param props.label - rail label (duplicate titles carry a `#n` suffix).
 * @param props.active - whether this is the selected session.
 * @param props.disconnected - whether the transport is gone (§15).
 * @param props.onSelect - select this session.
 * @param props.onRequestClose - open the inline close confirmation.
 * @returns the chip.
 */
function SessionChip({ t, session, label, active, disconnected, onSelect, onRequestClose }) {
  const { focus, focusProps } = useFocusRing()
  const [hover, setHover] = useState(false)
  const chipStyle = {
    ...S.railChip,
    ...(active ? S.railChipActive : null),
    ...(!active && hover ? S.railChipHover : null),
  }
  return (
    <div
      role="presentation"
      style={chipStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // A click on the chip padding does not move DOM focus off the previously
      // focused tab; dropping the ring here keeps a stale keyboard box from
      // outliving the selection.
      onPointerDown={focusProps.onPointerDown}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // The full title (with host/port) is the tooltip: two sessions to the
        // same profile share a name, so the label alone cannot identify them.
        title={`${label} · ${session.username ? `${session.username}@` : ''}${session.host}${
          session.port ? `:${session.port}` : ''
        }${disconnected ? ` · ${t('stateDisconnected')}` : ''}`}
        onClick={onSelect}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          height: '100%',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 13,
          lineHeight: 1,
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
          outline: 'none',
        }}
        {...focusProps}
      >
        <StateDot state={session.state} />
        {/* A disconnected session stays in the rail (it can be reconnected) but
            is dimmed and uses the hollow amber dot. */}
        <span style={disconnected ? S.railTitleDim : S.railTitle}>{label}</span>
        <span
          style={{
            ...S.transportBadge,
            ...(session.transport === 'telnet' ? S.transportBadgeTelnet : S.transportBadgeSsh),
          }}
        >
          {session.transport}
        </span>
      </button>
      <IconBtn size={26} danger title={t('closeSession')} onClick={onRequestClose}>
        <CloseIcon size={12} />
      </IconBtn>
      {/* Last child on purpose: the ring paints over the chip's own border and
          the close button's hover wash, never under them. */}
      {focus ? <span aria-hidden="true" style={S.railChipRing} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Control bar: AI access, lock state, takeover, audit, close
 * ------------------------------------------------------------------ */

const PERMISSION_OPTIONS = [
  { value: 'ro', labelKey: 'permRo', hintKey: 'permRoHint' },
  { value: 'wo', labelKey: 'permWo', hintKey: 'permWoHint' },
  { value: 'rw', labelKey: 'permRw', hintKey: 'permRwHint' },
]

function ControlBar({ t, session }) {
  const app = useAppState()
  const panel = app.panel
  const permission = session.permission
  const [now, setNow] = useState(() => Date.now())
  const [auditOpen, setAuditOpen] = useState(false)
  const [busyAction, setBusyAction] = useState(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [closing, setClosing] = useState(false)
  const [copying, setCopying] = useState(false)
  const auditRootRef = useRef(null)
  const barRef = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    setAuditOpen(false)
    setConfirmClose(false)
    setBusyAction(null)
  }, [session.id])

  const closed = session.state === 'closed' || session.state === 'failed'
  // v4 lifecycle (§15): a disconnected session keeps its rail chip and id but
  // has no transport; 重连 reuses that id and bumps the generation.
  const disconnected = session.state === 'disconnected'
  const canReconnect = disconnected || session.state === 'failed'
  const canDisconnect = session.state === 'open'
  const reconnecting = busyAction === 'reconnect' || session.reconnecting === true
  const lockOwner = permission.lockOwner
  const countdown = lockOwner === 'ai' && permission.lockExpiresAt
    ? Math.max(0, Math.ceil((permission.lockExpiresAt - now) / 1000))
    : null
  const lockText = lockOwner === 'ai' ? t('lockAi') : lockOwner === 'human' ? t('lockHuman') : t('lockFree')
  const lockColor = lockOwner === 'ai' ? C.warn : lockOwner === 'human' ? C.success : C.labelTertiary

  const setAccess = async (aiAccess) => {
    if (busyAction) return
    setBusyAction('access')
    try {
      const result = await rpc('permission.set', { id: session.id, aiAccess })
      patchPermission(session.id, result && result.permission)
      notify(t('accessChanged'))
    } catch (error) {
      notify(fmt(t, 'accessFailed', { message: errorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  const takeOver = async () => {
    if (busyAction) return
    setBusyAction('lock')
    try {
      const result = await rpc('lock.takeOver', { id: session.id })
      patchPermission(session.id, result && result.permission)
      notify(t('takenOver'))
    } catch (error) {
      notify(fmt(t, 'takeOverFailed', { message: errorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  const releaseAi = async () => {
    if (busyAction) return
    setBusyAction('lock')
    try {
      const result = await rpc('lock.release', { id: session.id })
      patchPermission(session.id, result && result.permission)
      notify(t('released'))
    } catch (error) {
      notify(fmt(t, 'releaseFailed', { message: errorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  /**
   * Close the session (terminates it and removes it from the rail). Guarded by
   * the shared inline confirmation instead of the old 3-second second-click.
   */
  const closeSession = async () => {
    if (closing) return
    setClosing(true)
    markSessionClosed(session.id)
    try {
      await rpc('sessions.close', { id: session.id })
    } catch (error) {
      notify(fmt(t, 'closeFailed', { message: errorMessage(error) }))
    } finally {
      setClosing(false)
      setConfirmClose(false)
    }
  }

  /**
   * Copy the visible screen text of this session (`read.screen`, human reader).
   * Read-only: nothing is sent to the remote terminal. A disconnected session
   * has no transport to read from (§15), so the control is disabled with a
   * title explaining why.
   */
  const copyScreen = async () => {
    if (copying) return
    if (disconnected) {
      notify(t('copyScreenUnavailable'))
      return
    }
    setCopying(true)
    try {
      const raw = await readScreen(session.id, { changedOnly: false })
      const result = normalizeScreenResult(raw)
      if (!result.text) {
        notify(t('copyScreenEmpty'))
        return
      }
      const ok = await copyText(result.text, barRef.current)
      notify(ok ? t('copyScreenDone') : t('copyFailed'))
    } catch (error) {
      notify(fmt(t, 'copyScreenFailed', { message: errorMessage(error) }))
    } finally {
      setCopying(false)
    }
  }

  /**
   * 中断: keep the session in the rail but drop the transport (§15).
   *
   * No confirmation: the session is recoverable with 重连 and its history,
   * permission mode and audit trail are kept.
   */
  const disconnectSession = async () => {
    if (busyAction || !canDisconnect) return
    setBusyAction('disconnect')
    try {
      const result = await sessionsDisconnect(session.id)
      if (result && result.session) mergeSession(result.session)
      notify(t('disconnectedNotice'))
    } catch (error) {
      notify(fmt(t, 'disconnectFailed', { message: errorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  /**
   * 重连: same id, rebuilt screen. The payload carries the *fitted* terminal
   * size so the new pty is sized before the Host resets the screen (§17).
   */
  const reconnectSession = async () => {
    if (busyAction) return
    setBusyAction('reconnect')
    try {
      const size = getTerminalSize(session.id) || { cols: session.cols, rows: session.rows }
      const result = await sessionsReconnect(session.id, size)
      const settled = result && result.session ? mergeSession(result.session) : null
      // A connection failure resolves with a `failed` session instead of
      // throwing: show the Host reason verbatim and keep the session so the
      // user can retry or close it.
      if (settled && settled.state === 'failed') {
        notify(fmt(t, 'reconnectFailed', { message: settled.error || t('unknownError') }))
      } else if (settled && settled.state === 'open') {
        notify(t('reconnected'))
      }
    } catch (error) {
      notify(fmt(t, 'reconnectFailed', { message: errorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  const togglePanel = (name) => {
    if (panel === name) closePanel()
    else openPanel(name)
  }

  return (
    <>
      <div ref={barRef} style={{ ...S.controlBar, position: 'relative' }}>
        <Segmented
          label={t('permission')}
          value={permission.aiAccess}
          disabled={closed || busyAction !== null}
          options={PERMISSION_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
            hint: t(option.hintKey),
          }))}
          onChange={setAccess}
        />

        <span style={{ ...S.lockChip, color: lockColor }} title={`${t('lockFree')} / ${t('lockAi')} / ${t('lockHuman')}`}>
          {lockOwner ? <LockIcon /> : <span style={{ ...S.lockDot, background: lockColor }} />}
          <span>{lockText}</span>
          {countdown !== null ? (
            <span style={{ color: C.labelTertiary }}>· {fmt(t, 'lockAiCountdown', { seconds: countdown })}</span>
          ) : null}
        </span>

        <div style={S.controlSpacer} />

        {canReconnect ? (
          // A disconnected session shows 重连 exactly where 接管 normally sits.
          <Btn
            title={t('reconnectAction')}
            ariaLabel={reconnecting ? t('reconnectingAction') : t('reconnectAction')}
            onClick={reconnectSession}
            busy={reconnecting}
            disabled={busyAction !== null}
          >
            <RefreshIcon size={14} />
            {t('reconnectAction')}
          </Btn>
        ) : lockOwner === 'human' ? (
          <Btn onClick={releaseAi} disabled={busyAction !== null}>{t('releaseAi')}</Btn>
        ) : (
          <Btn onClick={takeOver} disabled={busyAction !== null || closed}>{t('takeOver')}</Btn>
        )}

        {canDisconnect ? (
          <IconBtn
            danger
            title={t('disconnect')}
            ariaLabel={t('disconnectHint')}
            disabled={busyAction !== null || session.reconnecting === true}
            onClick={disconnectSession}
          >
            {busyAction === 'disconnect' ? <span style={{ fontSize: 12 }}>…</span> : <PowerIcon />}
          </IconBtn>
        ) : null}

        <IconBtn
          active={panel === 'history'}
          title={t('history')}
          onClick={() => togglePanel('history')}
        >
          <HistoryIcon />
        </IconBtn>

        <IconBtn
          active={panel === 'scripts'}
          title={t('scripts')}
          onClick={() => togglePanel('scripts')}
        >
          <ScriptIcon />
        </IconBtn>

        <IconBtn
          title={disconnected ? t('copyScreenUnavailable') : t('copyScreen')}
          disabled={copying || disconnected}
          onClick={copyScreen}
        >
          {copying ? <span style={{ fontSize: 12 }}>…</span> : <CopyIcon />}
        </IconBtn>

        <div ref={auditRootRef} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
          <IconBtn
            active={auditOpen}
            title={t('audit')}
            onClick={() => setAuditOpen((open) => !open)}
          >
            <AuditIcon />
            <ChevronIcon open={auditOpen} />
          </IconBtn>
          <AuditPopover
            t={t}
            sessionId={session.id}
            open={auditOpen}
            onClose={() => setAuditOpen(false)}
            rootRef={auditRootRef}
          />
        </div>

        <IconBtn
          danger
          title={t('closeSession')}
          onClick={() => setConfirmClose(true)}
        >
          <CloseIcon />
        </IconBtn>
      </div>
      {confirmClose ? (
        <div style={S.railConfirmWrap}>
          <InlineConfirm
            message={fmt(t, 'closeSessionPrompt', { title: session.title })}
            confirmLabel={t('closeConfirm')}
            cancelLabel={t('cancel')}
            busy={closing}
            onConfirm={closeSession}
            onCancel={() => setConfirmClose(false)}
          />
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Terminal area
 * ------------------------------------------------------------------ */

function TerminalPane({ t, session, reset }) {
  const [link, setLink] = useState('connecting')
  // Quick scripts sit *under* the terminal, like the button row a terminal app
  // puts at the bottom of the window. Collapsed by default: the sidebar is
  // narrow and the terminal is the point; the toggle keeps it one click away.
  const [quickOpen, setQuickOpen] = useState(false)
  const blocked = Boolean(session.permission.humanWriteBlocked)
  const ended = session.state === 'closed' || session.state === 'failed'
  const disconnected = session.state === 'disconnected'

  return (
    <div style={S.pane}>
      {blocked && !ended && !disconnected ? <BlockedBanner t={t} session={session} /> : null}
      {disconnected ? <DisconnectedNotice t={t} session={session} /> : null}
      {ended ? <EndedNotice t={t} session={session} /> : null}
      <div style={S.termWrap}>
        <TerminalView t={t} session={session} onLinkChange={setLink} reset={reset} />
      </div>
      <QuickScripts
        t={t}
        sessionId={ended || disconnected ? null : session.id}
        open={quickOpen}
        onToggle={() => setQuickOpen((open) => !open)}
        onOpenLibrary={() => openPanel('scripts')}
      />
      <StatusBar t={t} session={session} link={link} />
    </div>
  )
}

/**
 * Banner for a `disconnected` session (§15): the transport is gone but the
 * session (history, audit, AI permission) is kept. Input and screen copy stay
 * disabled until 重连 succeeds; the control bar carries the action.
 */
function DisconnectedNotice({ t, session }) {
  return (
    <div style={{ ...S.banner, borderLeftColor: C.warn }} role="status">
      <span style={S.bannerText}>
        {t('disconnectedTitle')}
        <span style={S.bannerHint}>{t('disconnectedHint')}</span>
        {session.closeReason ? (
          <span style={S.bannerHint}>{fmt(t, 'closedReason', { reason: session.closeReason })}</span>
        ) : null}
      </span>
    </div>
  )
}

function BlockedBanner({ t, session }) {
  const [busy, setBusy] = useState(false)

  const takeOver = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await rpc('lock.takeOver', { id: session.id })
      patchPermission(session.id, result && result.permission)
      notify(t('takenOver'))
    } catch (error) {
      notify(fmt(t, 'takeOverFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={S.banner} role="status">
      <LockIcon size={12} />
      <span style={S.bannerText}>
        {t('blockedTitle')}
        <span style={S.bannerHint}>{t('blockedHint')}</span>
      </span>
      <Btn variant="primary" onClick={takeOver} busy={busy} disabled={busy}>{t('takeOver')}</Btn>
    </div>
  )
}

function EndedNotice({ t, session }) {
  const failed = session.state === 'failed'
  const [busy, setBusy] = useState(false)

  const closeSession = async () => {
    if (busy) return
    setBusy(true)
    try {
      await rpc('sessions.close', { id: session.id })
    } catch {
      // The Host may already have dropped the session; the notice stays until
      // the global list refreshes.
    } finally {
      setBusy(false)
      markSessionClosed(session.id, session.error)
    }
  }

  return (
    <div
      style={{ ...S.banner, borderLeftColor: failed ? C.danger : C.labelTertiary }}
      role="status"
    >
      <span style={S.bannerText}>
        {failed ? t('failedTitle') : t('closedTitle')}
        {session.error ? <span style={S.bannerHint}>{fmt(t, 'closedReason', { reason: session.error })}</span> : null}
      </span>
      <Btn onClick={closeSession} busy={busy} disabled={busy}>{t('closeSession')}</Btn>
    </div>
  )
}

function StatusBar({ t, session, link }) {
  const stateKey = session.state === 'open'
    ? 'stateOpen'
    : session.state === 'disconnected'
      ? 'stateDisconnected'
      : session.state === 'closed'
        ? 'stateClosed'
        : session.state === 'failed'
          ? 'stateFailed'
          : 'stateConnecting'
  const reconnecting = session.reconnecting === true || (session.state === 'open' && link === 'error')
  const stateColor = session.state === 'failed'
    ? C.danger
    : reconnecting || session.state === 'disconnected'
      ? C.warnLabel
      : C.labelTertiary
  const address = `${session.transport === 'telnet' ? 'telnet' : 'ssh'} ${session.username ? `${session.username}@` : ''}${session.host}${session.port ? `:${session.port}` : ''}`

  return (
    <div style={S.statusBar}>
      <span style={{ ...S.statusItem, color: stateColor }}>
        {reconnecting ? t('reconnecting') : t(stateKey)}
      </span>
      <span style={S.statusItem}>{address}</span>
      <span style={S.controlSpacer} />
      <span style={S.statusItem}>{fmt(t, 'statusSize', { cols: session.cols, rows: session.rows })}</span>
      <span style={S.statusItem}>
        {fmt(t, 'statusBytes', { in: formatBytes(session.bytesIn), out: formatBytes(session.bytesOut) })}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab title
 * ------------------------------------------------------------------ */

/**
 * Live tab title: the selected session's name, or the panel name.
 *
 * @param props.t - locale translate function injected by the title seat.
 * @returns the title content.
 */
export function TabTitle({ t: rawT }) {
  const t = translate(rawT)
  const state = useAppState()
  const session = selectedSessionOf(state)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 220 }}>
      <TerminalIcon size={12} />
      {session ? (
        <span
          style={{
            ...S.transportBadge,
            ...(session.transport === 'telnet' ? S.transportBadgeTelnet : S.transportBadgeSsh),
          }}
        >
          {session.transport}
        </span>
      ) : null}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session ? session.title : t('title')}
      </span>
    </span>
  )
}
