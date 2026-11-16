/**
 * 配置管理（Profiles）panel: grouped saved-profile list with inline actions.
 *
 * Opens from the SSH/Telnet control bar as an overlay inside the tab body
 * (same seat as the history and scripts panels). Data comes from
 * CONTRACTS.md §13:
 *
 * - `profiles.list` `{}` → `{ profiles: ProfileInfo[], folders: [{ name, count }] }`
 * - `profiles.rename` `{ id, name }` → `{ profile }`
 * - `profiles.setFolder` `{ id, folder }` → `{ profile }`
 * - `profiles.delete` `{ id }` → `{ ok: boolean }`
 * - `profiles.save` `{ profile }` → `{ profile }` (only through the connect form)
 *
 * The id is never sent as a mutable field: renaming changes the display name
 * only, because the id is part of the credential key. Every write is human-only
 * Host-side, so this panel is the human path and the AI cannot reach it.
 *
 * Every async path is guarded, malformed payloads are normalized, and errors
 * are rendered inline: nothing here can blank the slot.
 */

import { useEffect, useRef, useState } from 'react'
import {
  errorMessage,
  fmt,
} from './locale.js'
import {
  groupByFolder,
  normalizeProfilesResult,
  normalizeSession,
  profilesDelete,
  profilesList,
  profilesRename,
  profilesSetFolder,
  rpc,
} from './api.js'
import {
  openConnectView,
  mergeSession,
  notify,
  selectSession,
  useAppState,
} from './store.js'
import { Btn, Field, InlineConfirm, Sheet } from './ui.jsx'
import { S } from './styles.js'

/** Marker option in the move picker that reveals the new-folder input. */
const NEW_FOLDER = '__new__'

/**
 * `transport user@host:port`, the row address line.
 *
 * @param profile - normalized profile.
 * @returns the address text.
 */
function addressOf(profile) {
  const user = profile.username ? `${profile.username}@` : ''
  return `${profile.transport} ${user}${profile.host}:${profile.port}`
}

/**
 * Render one profile row plus its inline rename / move editors.
 *
 * The action row is always visible (not hover-only): 连接 is the primary action,
 * followed by 编辑 / 重命名 / 移动文件夹 / 删除. Deleting swaps the row's action
 * row for the shared inline confirmation — no timer, no second-click guessing.
 *
 * @param props.profile - normalized profile.
 * @param props.t - locale translate function.
 * @param props.busy - whether a write is in flight.
 * @param props.renaming - `{ id, value }` when this row is being renamed.
 * @param props.moving - `{ id, value, folder }` when this row is being moved.
 * @param props.confirmed - whether this row is awaiting delete confirmation.
 * @param props.highlighted - whether this row was just saved (accent style).
 * @param props.folderOptions - folder names offered by the move picker.
 * @param props.rowRef - ref callback used to scroll a saved row into view.
 * @param props.handlers - callbacks for every action.
 * @returns the row element.
 */
function ProfileRow({
  profile,
  t,
  busy,
  renaming,
  moving,
  confirmed,
  highlighted,
  folderOptions,
  rowRef,
  handlers,
}) {
  const renamingThis = Boolean(renaming && renaming.id === profile.id)
  const movingThis = Boolean(moving && moving.id === profile.id)
  const badges = []
  if (profile.hasPassword) badges.push({ key: 'password', label: t('profilesBadgePassword') })
  if (profile.hasPrivateKey) badges.push({ key: 'privateKey', label: t('profilesBadgePrivateKey') })
  if (profile.hasPassphrase) badges.push({ key: 'passphrase', label: t('profilesBadgePassphrase') })

  return (
    <div
      ref={rowRef}
      data-profile-id={profile.id}
      style={{ ...S.profileRow, ...(highlighted ? S.profileRowHighlight : null) }}
    >
      <div style={S.profileMain}>
        <span style={S.profileName} title={profile.name}>{profile.name}</span>
        <span style={S.profileAddress} title={addressOf(profile)}>{addressOf(profile)}</span>
        {badges.length > 0 ? (
          <span style={S.profileBadges}>
            {badges.map((badge) => <span key={badge.key} style={S.badge}>{badge.label}</span>)}
          </span>
        ) : null}
      </div>

      {renamingThis ? (
        <div style={S.inlineRow}>
          <input
            style={{ ...S.input, width: 140 }}
            value={renaming.value}
            aria-label={t('profilesNamePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => handlers.onRenameInput(event.target.value)}
            onKeyDown={(event) => {
              if (!event) return
              if (event.key === 'Enter') handlers.onRenameSubmit(profile)
              if (event.key === 'Escape') {
                // Cancel the editor, not the whole panel behind it.
                event.stopPropagation()
                handlers.onRenameCancel()
              }
            }}
          />
          <Btn
            variant="primary"
            title={`${t('profilesRenameSave')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onRenameSubmit(profile)}
          >
            {t('profilesRenameSave')}
          </Btn>
          <Btn title={`${t('profilesRenameCancel')} ${profile.name}`} disabled={busy} onClick={handlers.onRenameCancel}>
            {t('profilesRenameCancel')}
          </Btn>
        </div>
      ) : null}

      {movingThis ? (
        <div style={S.inlineRow}>
          <select
            style={{ ...S.select, width: 120 }}
            value={moving.value}
            aria-label={`${t('profilesMove')} ${profile.name}`}
            disabled={busy}
            onChange={(event) => handlers.onMoveInput(event.target.value)}
          >
            <option value="">{t('folderNone')}</option>
            {folderOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={NEW_FOLDER}>{t('folderNew')}</option>
          </select>
          {moving.value === NEW_FOLDER ? (
            <input
              style={{ ...S.input, width: 110 }}
              value={moving.folder}
              aria-label={`${t('folderName')} ${profile.name}`}
              placeholder={t('folderName')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => handlers.onMoveFolderInput(event.target.value)}
              onKeyDown={(event) => {
                if (!event) return
                if (event.key === 'Enter') handlers.onMoveSubmit(profile)
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  handlers.onMoveCancel()
                }
              }}
            />
          ) : null}
          <Btn
            variant="primary"
            title={`${t('profilesRenameSave')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onMoveSubmit(profile)}
          >
            {t('profilesRenameSave')}
          </Btn>
          <Btn title={`${t('profilesRenameCancel')} ${profile.name}`} disabled={busy} onClick={handlers.onMoveCancel}>
            {t('profilesRenameCancel')}
          </Btn>
        </div>
      ) : null}

      {renamingThis || movingThis ? null : confirmed ? (
        <InlineConfirm
          message={fmt(t, 'profilesDeletePrompt', { name: profile.name })}
          confirmLabel={t('profilesDeleteConfirm')}
          cancelLabel={t('cancel')}
          busy={busy}
          onConfirm={() => handlers.onDeleteConfirm(profile)}
          onCancel={handlers.onDeleteCancel}
        />
      ) : (
        <div style={S.profileActions}>
          <Btn
            variant="primary"
            style={S.rowBtn}
            title={`${t('profilesConnect')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onConnect(profile)}
          >
            {t('profilesConnect')}
          </Btn>
          <Btn
            style={S.rowBtn}
            title={`${t('profilesEdit')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onEdit(profile)}
          >
            {t('profilesEdit')}
          </Btn>
          <Btn
            style={S.rowBtn}
            title={`${t('profilesRename')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onRenameStart(profile)}
          >
            {t('profilesRename')}
          </Btn>
          <Btn
            style={S.rowBtn}
            title={`${t('profilesMove')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onMoveStart(profile)}
          >
            {t('profilesMove')}
          </Btn>
          <Btn
            style={S.rowBtn}
            variant="danger"
            title={`${t('profilesDelete')} ${profile.name}`}
            disabled={busy}
            onClick={() => handlers.onDeleteStart(profile)}
          >
            {t('profilesDelete')}
          </Btn>
        </div>
      )}
    </div>
  )
}

/**
 * Render the profiles panel.
 *
 * @param props.t - locale translate function.
 * @param props.onClose - close handler.
 * @returns the panel.
 */
export function ProfilesPanel({ t, onClose }) {
  const app = useAppState()
  const highlightId = app.highlightProfileId || null
  const [profiles, setProfiles] = useState([])
  const [folders, setFolders] = useState([])
  const [listState, setListState] = useState('loading')
  const [listError, setListError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [moving, setMoving] = useState(null)
  const [confirmedId, setConfirmedId] = useState(null)
  const [newFolder, setNewFolder] = useState('')
  /** Folders created in this session: the Host derives folders from profiles, so
   *  an empty folder exists only here (see the Host-gap note in the report). */
  const [extraFolders, setExtraFolders] = useState([])
  const aliveRef = useRef(true)
  const listRef = useRef(null)
  const rowRefs = useRef(new Map())

  /**
   * Reload the list. Errors keep the last known rows on screen.
   */
  async function load() {
    setListState('loading')
    setListError(null)
    try {
      const raw = await profilesList()
      if (!aliveRef.current) return
      const normalized = normalizeProfilesResult(raw)
      setProfiles(normalized.profiles)
      setFolders(normalized.folders.map((entry) => entry.name))
      setListState(normalized.profiles.length > 0 ? 'ready' : 'empty')
    } catch (error) {
      if (!aliveRef.current) return
      setListError(errorMessage(error))
      setListState('error')
    }
  }

  useEffect(() => {
    aliveRef.current = true
    load()
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Scroll the row that was just saved into view (no-op without a DOM).
  useEffect(() => {
    if (!highlightId) return
    const node = rowRefs.current.get(highlightId)
    if (node && typeof node.scrollIntoView === 'function') {
      try {
        node.scrollIntoView({ block: 'nearest' })
      } catch {
        /* a hidden pane may refuse to scroll */
      }
    }
  }, [highlightId, profiles.length])

  const folderOptions = [...new Set([
    ...folders,
    ...extraFolders,
    ...(profiles.map((profile) => profile.folder).filter(Boolean)),
  ])].sort((left, right) => left.localeCompare(right))

  const groups = groupByFolder(profiles)

  /** @param action - async action; resets busy, toasts and shows Host errors verbatim. */
  async function run(action) {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      const message = errorMessage(error)
      if (aliveRef.current) {
        setActionError(message)
        // A failed write is easy to miss inline on a scrolled list, so it also
        // surfaces as a toast (both carry the Host message verbatim).
        notify(fmt(t, 'profilesActionFailed', { message }))
      }
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const connect = (profile) => run(async () => {
    const result = await rpc('sessions.create', {
      profileId: profile.id,
      transport: profile.transport,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      cols: 100,
      rows: 30,
    })
    const session = normalizeSession(result && result.session)
    if (result && result.session) mergeSession(result.session)
    if (session) selectSession(session.id)
  })

  // Editing pushes the connect form on top of this sheet: ← returns here, and a
  // successful save lands back on the list with the row highlighted.
  const edit = (profile) => openConnectView(profile)

  const startDelete = (profile) => {
    setRenaming(null)
    setMoving(null)
    setActionError(null)
    setConfirmedId(profile.id)
  }

  const cancelDelete = () => setConfirmedId(null)

  const remove = (profile) => {
    setConfirmedId(null)
    run(async () => {
      await profilesDelete(profile.id)
      notify(t('profilesDeleteDone'))
      await load()
    })
  }

  const submitRename = (profile) => {
    const name = renaming && renaming.id === profile.id ? String(renaming.value || '').trim() : ''
    if (name === '') {
      setActionError(t('profilesNameRequired'))
      return
    }
    setRenaming(null)
    run(async () => {
      await profilesRename(profile.id, name)
      notify(t('profilesRenamed'))
      await load()
    })
  }

  const submitMove = (profile) => {
    if (!moving || moving.id !== profile.id) return
    const folder = moving.value === NEW_FOLDER ? String(moving.folder || '').trim() : moving.value
    if (moving.value === NEW_FOLDER && folder === '') {
      setActionError(t('profilesFolderNameRequired'))
      return
    }
    setMoving(null)
    run(async () => {
      await profilesSetFolder(profile.id, folder)
      notify(t('profilesMoved'))
      await load()
    })
  }

  const createFolder = () => {
    const name = newFolder.trim()
    if (name === '') {
      setActionError(t('profilesFolderNameRequired'))
      return
    }
    setActionError(null)
    setExtraFolders((current) => (current.includes(name) ? current : current.concat([name])))
    setNewFolder('')
    notify(fmt(t, 'profilesFolderAdded', { name }))
  }

  const handlers = {
    onConnect: connect,
    onEdit: edit,
    onRenameStart: (profile) => {
      setMoving(null)
      setConfirmedId(null)
      setActionError(null)
      setRenaming({ id: profile.id, value: profile.name })
    },
    onRenameInput: (value) => setRenaming((current) => (current ? { ...current, value } : current)),
    onRenameSubmit: submitRename,
    onRenameCancel: () => setRenaming(null),
    onMoveStart: (profile) => {
      setRenaming(null)
      setConfirmedId(null)
      setActionError(null)
      setMoving({ id: profile.id, value: profile.folder || '', folder: '' })
    },
    onMoveInput: (value) => setMoving((current) => (current ? { ...current, value } : current)),
    onMoveFolderInput: (value) => setMoving((current) => (current ? { ...current, folder: value } : current)),
    onMoveSubmit: submitMove,
    onMoveCancel: () => setMoving(null),
    onDeleteStart: startDelete,
    onDeleteConfirm: remove,
    onDeleteCancel: cancelDelete,
  }

  const footer = (
    <>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {fmt(t, 'profilesFooter', { profiles: profiles.length, folders: folderOptions.length })}
      </span>
      <span style={S.controlSpacer} />
      <Btn onClick={load} disabled={busy || listState === 'loading'}>{t('profilesReload')}</Btn>
    </>
  )

  return (
    <Sheet
      title={t('profilesTitle')}
      onBack={typeof onClose === 'function' ? onClose : undefined}
      backLabel={t('profilesPanelClose')}
      actions={(
        <Btn variant="primary" onClick={() => openConnectView()} disabled={busy}>
          {t('profilesNewConnection')}
        </Btn>
      )}
      footer={footer}
    >
      <div style={S.folderPickerRow}>
        <Field label={t('profilesNewFolder')} style={S.grow}>
          <input
            style={S.input}
            value={newFolder}
            placeholder={t('profilesNewFolderPlaceholder')}
            aria-label={t('profilesNewFolderPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setNewFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event && event.key === 'Enter') createFolder()
            }}
          />
        </Field>
        <Btn
          onClick={createFolder}
          disabled={busy || newFolder.trim() === ''}
          title={t('profilesCreateFolder')}
        >
          {t('profilesCreateFolder')}
        </Btn>
      </div>

      {actionError ? <div style={S.formError} role="alert">{actionError}</div> : null}

      {listState === 'loading' && profiles.length === 0 ? <div style={S.auditEmpty}>{t('profilesLoading')}</div> : null}
      {listState === 'error' ? (
        <div style={S.formError} role="alert">{fmt(t, 'profilesListFailed', { message: listError || '' })}</div>
      ) : null}
      {listState === 'empty' ? (
        <div style={S.stateWrap}>
          <p style={S.stateTitle}>{t('profilesEmpty')}</p>
          <p style={S.stateDetail}>{t('profilesEmptyHint')}</p>
          <Btn variant="primary" onClick={() => openConnectView()} disabled={busy}>
            {t('profilesNewConnection')}
          </Btn>
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <div ref={listRef} style={S.profileList} role="list" aria-label={t('profilesTitle')}>
          {groups.map((group) => (
            <div key={group.folder || '__ungrouped'} style={S.profileSection}>
              <div style={S.profileSectionHeader}>
                <span>{group.folder || t('profilesUngrouped')}</span>
                <span style={S.profileCount}>{fmt(t, 'profilesFolderCount', { count: group.count })}</span>
              </div>
              {group.items.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  t={t}
                  busy={busy}
                  renaming={renaming}
                  moving={moving}
                  confirmed={confirmedId === profile.id}
                  highlighted={highlightId === profile.id}
                  folderOptions={folderOptions}
                  rowRef={(node) => {
                    if (node) rowRefs.current.set(profile.id, node)
                    else rowRefs.current.delete(profile.id)
                  }}
                  handlers={handlers}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </Sheet>
  )
}
