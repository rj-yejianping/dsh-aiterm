/**
 * Hand-written controls.
 *
 * The Harness client packages are not available to a third-party bundle, so the
 * panel implements the small set of controls it needs (button, icon button,
 * segmented control, field, state dot, toast) on top of theme tokens. Inline
 * styles keep every DOM node inside this component subtree — nothing is injected
 * into `document.head` or `document.body`.
 */

import { useEffect, useState } from 'react'
import { focusRingVisible } from './focus.js'
import { C, S, focusRing } from './styles.js'

/**
 * Keyboard-only focus ring.
 *
 * A plain `onFocus` ring paints after a mouse click too, so clicking a tab left
 * a white outline on it while the *selection* moved elsewhere — two different
 * "boxes" competing in the session rail. `:focus-visible` only matches when the
 * user is navigating by keyboard, which is the case the ring exists for, and
 * the Host's input modality (`pointer`) is required to still be `keyboard`.
 *
 * The ring is also dropped on *any* pointer press, not only on this control:
 * selecting another tab by clicking its padding does not move DOM focus, so
 * without that the previous tab kept a stale keyboard ring after the selection
 * had already moved. See `client/focus.js`.
 *
 * @returns {{focus: boolean, focusProps: object}} ring flag and the props to spread.
 */
export function useFocusRing() {
  const [focus, setFocus] = useState(false)
  // Only listen while a ring is actually painted: the panel renders dozens of
  // controls, and a listener per control would be noise for the common case.
  useEffect(() => {
    if (!focus) return undefined
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const dismiss = () => setFocus(false)
    document.addEventListener('pointerdown', dismiss, true)
    return () => {
      try {
        document.removeEventListener('pointerdown', dismiss, true)
      } catch {
        /* ignore */
      }
    }
  }, [focus])
  const focusProps = {
    onPointerDown() {
      setFocus(false)
    },
    onFocus(event) {
      let visible = false
      try {
        const node = event && event.currentTarget
        const matches = typeof node.matches === 'function' ? node.matches(':focus-visible') : false
        const root = typeof document === 'undefined' ? null : document.documentElement
        const modality = root && root.dataset ? root.dataset.inputModality : undefined
        visible = focusRingVisible(matches, modality)
      } catch {
        visible = false
      }
      setFocus(visible)
    },
    onBlur() {
      setFocus(false)
    },
  }
  return { focus, focusProps }
}

const BTN_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 'none',
  height: 32,
  padding: '0 12px',
  // Longhands: variants override `borderColor`, and React removes a longhand
  // that the next render's style object no longer lists. With the shorthand the
  // removed colour falls back to `currentColor`, leaving a text-coloured border
  // when a button switches back from `outline` / `primary`.
  borderWidth: '0.5px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: C.radiusSm,
  background: 'transparent',
  color: C.labelSecondary,
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
  outline: 'none',
  whiteSpace: 'nowrap',
}

function variantStyle(variant, hover, active) {
  if (variant === 'primary') {
    return {
      background: hover ? C.primaryHover : C.primaryFill,
      color: C.labelForeground,
      borderColor: C.primaryFill,
    }
  }
  if (variant === 'danger') {
    return {
      background: hover ? C.hoverDanger : 'transparent',
      color: C.danger,
      borderColor: hover ? C.borderL2 : 'transparent',
    }
  }
  if (variant === 'outline') {
    return {
      background: hover ? C.hover : 'transparent',
      borderColor: C.borderL2,
      color: C.labelPrimary,
    }
  }
  return {
    background: hover || active ? C.hover : 'transparent',
    color: hover || active ? C.labelPrimary : C.labelSecondary,
    borderColor: 'transparent',
  }
}

/**
 * Compact text button.
 *
 * @param props - label, click handler, variant, busy/disabled flags.
 * @returns the button element.
 */
export function Btn({ children, onClick, variant = 'default', disabled = false, busy = false, title, ariaLabel, style }) {
  const [hover, setHover] = useState(false)
  const { focus, focusProps } = useFocusRing()
  const inert = disabled || busy
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      disabled={inert}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...focusProps}
      onClick={(event) => {
        if (inert || typeof onClick !== 'function') return
        try {
          const result = onClick(event)
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (error) {
          console.error('[aiterm] button action failed', error)
        }
      }}
      style={{
        ...BTN_BASE,
        ...variantStyle(variant, hover && !inert),
        ...(inert ? { opacity: 0.45, cursor: 'default' } : null),
        boxShadow: focusRing(focus),
        ...style,
      }}
    >
      {busy ? '…' : children}
    </button>
  )
}

/**
 * Square icon-only button.
 *
 * @param props - icon node, label for accessibility, click handler.
 * @returns the button element.
 */
export function IconBtn({ children, onClick, title, ariaLabel, active = false, danger = false, disabled = false, size = 30 }) {
  const [hover, setHover] = useState(false)
  const { focus, focusProps } = useFocusRing()
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel || title}
      aria-pressed={active}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...focusProps}
      onClick={(event) => {
        if (disabled || typeof onClick !== 'function') return
        try {
          const result = onClick(event)
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (error) {
          console.error('[aiterm] icon action failed', error)
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: size,
        height: size,
        padding: 0,
        border: '0.5px solid transparent',
        borderRadius: C.radiusSm,
        background: hover && !disabled ? (danger ? C.hoverDanger : C.hover) : 'transparent',
        color: danger ? C.danger : hover && !disabled ? C.labelPrimary : C.labelSecondary,
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
        opacity: disabled ? 0.45 : 1,
        boxShadow: focusRing(focus),
      }}
    >
      {children}
    </button>
  )
}

/**
 * Three-state segmented control (AI permission).
 *
 * @param props - options, current value, change handler.
 * @returns the segmented control element.
 */
export function Segmented({ options, value, onChange, disabled = false, label }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        flex: 'none',
        height: 30,
        border: `0.5px solid ${C.borderL2}`,
        borderRadius: C.radiusSm,
        overflow: 'hidden',
      }}
    >
      {options.map((option, index) => (
        <SegmentButton
          key={option.value}
          option={option}
          active={option.value === value}
          disabled={disabled}
          last={index === options.length - 1}
          onSelect={() => {
            if (!disabled && option.value !== value) onChange(option.value)
          }}
        />
      ))}
    </div>
  )
}

function SegmentButton({ option, active, disabled, last, onSelect }) {
  const [hover, setHover] = useState(false)
  const { focus, focusProps } = useFocusRing()
  return (
    <button
      type="button"
      role="button"
      aria-pressed={active}
      title={option.hint}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...focusProps}
      onClick={onSelect}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 42,
        height: '100%',
        padding: '0 10px',
        border: 0,
        borderRight: last ? 0 : `0.5px solid ${C.borderL2}`,
        background: active ? C.bgLayer3 : hover && !disabled ? C.hover : 'transparent',
        color: disabled ? C.labelTertiary : active ? C.labelPrimary : C.labelSecondary,
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        fontWeight: active ? 600 : 400,
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
        boxShadow: focusRing(focus),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {option.label}
    </button>
  )
}

/** Session state dot. @param props - Host session state. @returns the dot. */
export function StateDot({ state }) {
  // `disconnected` (§15) is a recoverable state, not a live one: a hollow amber
  // ring reads as "kept, transport gone" next to open (solid green) and
  // failed (red).
  if (state === 'disconnected') {
    return (
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          width: 6,
          height: 6,
          boxSizing: 'border-box',
          borderRadius: '50%',
          border: `1px solid ${C.warn}`,
          background: 'transparent',
        }}
      />
    )
  }
  const background = state === 'open'
    ? C.success
    : state === 'failed'
      ? C.danger
      : state === 'connecting'
        ? C.warn
        : C.labelTertiary
  return (
    <span
      aria-hidden="true"
      style={{
        flex: 'none',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background,
        opacity: state === 'closed' ? 0.6 : 1,
      }}
    />
  )
}

/**
 * Form field wrapper.
 *
 * @param props - label, optional hint, control children.
 * @returns the field element.
 */
export function Field({ label, hint, children, style }) {
  return (
    <label style={{ ...S.field, ...style }}>
      <span style={S.label}>{label}</span>
      {children}
      {hint ? <span style={S.hint}>{hint}</span> : null}
    </label>
  )
}

/** Transient toast. @param props - localized message. @returns the toast or null. */
export function Toast({ toast }) {
  if (!toast || !toast.text) return null
  return (
    <div role="status" aria-live="polite" style={S.toast}>
      {toast.text}
    </div>
  )
}

/** Small inline spinner substitute that keeps layout stable. */
export function Busy({ text }) {
  return <span style={{ color: C.labelTertiary, fontSize: 12 }}>{text}</span>
}

/**
 * Shared view header: ← back, title (plus optional hint), right action slot and
 * an optional × close.
 *
 * Every sub-view renders this — the connect form directly, the overlay sheets
 * through {@link Sheet} — so entering and leaving a view always looks and
 * behaves the same. `onBack` pops one level of the store's view stack; the
 * caller owns what that means for its view.
 *
 * @param props.title - visible title.
 * @param props.hint - optional second, muted line.
 * @param props.onBack - back handler (omit for a home view that cannot go back).
 * @param props.backLabel - accessible label/tooltip of the back control.
 * @param props.onClose - optional close handler for a distinct × control.
 * @param props.closeLabel - accessible label/tooltip of the close control.
 * @param props.actions - optional node rendered in the right action slot.
 * @returns the header element.
 */
export function ViewHeader({ title, hint, onBack, backLabel, onClose, closeLabel, actions }) {
  return (
    <div style={S.viewHeader}>
      {onBack ? (
        <IconBtn title={backLabel || title} onClick={onBack}>
          <BackIcon />
        </IconBtn>
      ) : null}
      <div style={S.viewHeaderText}>
        <span style={S.viewHeaderTitle} title={title}>{title}</span>
        {hint ? <span style={S.viewHeaderHint}>{hint}</span> : null}
      </div>
      {actions ? <div style={S.viewHeaderActions}>{actions}</div> : null}
      {onClose ? (
        <IconBtn title={closeLabel || title} onClick={onClose}>
          <CloseIcon />
        </IconBtn>
      ) : null}
    </div>
  )
}

/**
 * Inline confirmation bar for destructive actions.
 *
 * Replaces the old "press the same button twice within 3 seconds" pattern for
 * profile deletion and session closing: an explicit question, one confirm, one
 * cancel — no timer to expire under the user and no second action by accident.
 *
 * @param props.message - already-localized question (e.g. 确认删除 xxx？).
 * @param props.confirmLabel - localized confirm label.
 * @param props.cancelLabel - localized cancel label.
 * @param props.onConfirm - confirm handler.
 * @param props.onCancel - cancel handler.
 * @param props.busy - whether the confirm action is in flight.
 * @param props.danger - render the confirm action in the danger style (default).
 * @returns the confirmation bar.
 */
export function InlineConfirm({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  danger = true,
}) {
  return (
    <div
      style={S.inlineConfirm}
      role="alertdialog"
      aria-label={message}
      onKeyDown={(event) => {
        if (event && event.key === 'Escape') {
          // Cancel the question instead of letting the panel pop a view.
          event.stopPropagation()
          if (!busy && typeof onCancel === 'function') onCancel()
        }
      }}
    >
      <span style={S.inlineConfirmText} title={message}>{message}</span>
      <Btn variant={danger ? 'danger' : 'primary'} busy={busy} disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </Btn>
      <Btn disabled={busy} onClick={onCancel}>{cancelLabel}</Btn>
    </div>
  )
}

/**
 * Full-pane overlay sheet used by the profiles, history and scripts panels.
 *
 * Lives inside the tab body subtree: nothing is portalled to
 * `document.head`/`document.body`. Escape is handled once by the panel (which
 * pops the view stack); the sheet itself must not bind another key listener or
 * one Escape would retreat two levels.
 *
 * @param props.title - sheet title (rendered by {@link ViewHeader}).
 * @param props.onBack - back handler (usually close this sheet).
 * @param props.backLabel - accessible label of the back control.
 * @param props.onClose - optional distinct close handler (× control).
 * @param props.closeLabel - accessible label of the × control.
 * @param props.actions - optional right-slot actions.
 * @param props.children - body content.
 * @param props.footer - optional footer content.
 * @returns the sheet element.
 */
export function Sheet({ title, onBack, backLabel, onClose, closeLabel, actions, children, footer }) {
  return (
    <div style={S.sheet} role="dialog" aria-modal="true" aria-label={title}>
      <ViewHeader
        title={title}
        onBack={onBack}
        backLabel={backLabel}
        onClose={onClose}
        closeLabel={closeLabel}
        actions={actions}
      />
      <div style={S.sheetBody}>{children}</div>
      {footer !== undefined && footer !== null ? <div style={S.sheetFooter}>{footer}</div> : null}
    </div>
  )
}

/**
 * In-panel floating window: a genuinely "new window" for a large, secondary
 * view such as run results.
 *
 * It sits **above** the sheet that renders it (`position:absolute; inset:12px`)
 * instead of replacing it, and it spans only the panel subtree — nothing is
 * portalled to `document.body`/`head`. Esc is handled by this window with its
 * own capture-phase listener and `stopPropagation()`, so one press closes the
 * window and does NOT also pop the view stack behind it (the panel's Esc owner
 * listens in the bubble phase).
 *
 * @param props.title - window title.
 * @param props.onClose - close handler.
 * @param props.closeLabel - accessible label/tooltip of the × control.
 * @param props.children - scrollable body content.
 * @returns the floating window.
 */
export function OverlayWindow({ title, onClose, closeLabel, children }) {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onKeyDown = (event) => {
      if (!event || event.key !== 'Escape') return
      // This window is the topmost layer: consume the press here.
      event.stopPropagation()
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof onClose === 'function') onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      try {
        document.removeEventListener('keydown', onKeyDown, true)
      } catch {
        /* ignore */
      }
    }
  }, [onClose])

  return (
    <div style={S.overlayWindow} role="dialog" aria-modal="false" aria-label={title}>
      <div style={S.overlayWindowHead}>
        <span style={S.overlayWindowTitle} title={title}>{title}</span>
        <span style={S.controlSpacer} />
        <IconBtn title={closeLabel || title} onClick={onClose}>
          <CloseIcon />
        </IconBtn>
      </div>
      <div style={S.overlayWindowBody}>{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Icons — currentColor only, so they follow the surrounding token.
 * ------------------------------------------------------------------ */

const svg = (size, children, extra) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" style={{ flex: 'none', ...extra }}>
    {children}
  </svg>
)

/** Back arrow glyph (view navigation). @returns the icon. */
export function BackIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M9.8 3.6 5.4 8l4.4 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.6 8h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ))
}

/** Terminal prompt glyph. @returns the icon. */
export function TerminalIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M2.5 4.5 6 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 11.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ))
}

/** Plus glyph. @returns the icon. */
export function PlusIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ))
}

/** Close glyph. @returns the icon. */
export function CloseIcon({ size = 14 }) {
  return svg(size, (
    <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  ))
}

/** Audit list glyph. @returns the icon. */
export function AuditIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ))
}

/** Lock glyph. @returns the icon. */
export function LockIcon({ size = 13 }) {
  return svg(size, (
    <>
      <rect x="3.5" y="7" width="9" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.1" />
    </>
  ))
}

/** Chevron glyph for the audit popover button. @returns the icon. */
export function ChevronIcon({ size = 12, open = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none' }}
    >
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** History/clock glyph. @returns the icon. */
export function HistoryIcon({ size = 15 }) {
  return svg(size, (
    <>
      <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.1" />
      <path d="M8 4.8V8l2.2 1.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ))
}

/** Script/document glyph. @returns the icon. */
export function ScriptIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M4 2.6h5.2L12 5.4v8H4z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 7.4h4M6 9.8h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </>
  ))
}

/** Saved-profile folder glyph. @returns the icon. */
export function ProfilesIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M2.4 4.4a1 1 0 0 1 1-1h3l1.2 1.4h4.9a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.6 9.2h4.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </>
  ))
}

/** Copy glyph. @returns the icon. */
export function CopyIcon({ size = 15 }) {
  return svg(size, (
    <>
      <rect x="5.4" y="5.4" width="7" height="7" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M10.4 5.4V4.2A1.2 1.2 0 0 0 9.2 3H4.2A1.2 1.2 0 0 0 3 4.2v5a1.2 1.2 0 0 0 1.2 1.2h1.2" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ))
}

/** Power glyph for 中断 (disconnect but keep the session). @returns the icon. */
export function PowerIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M8 2.8v5.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M4.6 5.2a4.4 4.4 0 1 0 6.8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ))
}

/** Circular arrow glyph for 重连 (reconnect the same session). @returns the icon. */
export function RefreshIcon({ size = 15 }) {
  return svg(size, (
    <>
      <path d="M13 5.6V2.8m0 2.8H10.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ))
}
