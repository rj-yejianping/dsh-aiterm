/**
 * Connect form: profile picker + manual SSH / Telnet parameters.
 *
 * Calls `sessions.create` and, when asked, `profiles.save` (CONTRACTS §5, §13).
 * Two modes share the same fields:
 *
 * - **new** (default): open a session, optionally saving it as a profile. The
 *   folder selector travels with the `profiles.save` payload (§13).
 * - **edit** (`draft` prop carries a saved profile): the id is preserved in the
 *   payload and secret fields start blank — blank means "keep the stored
 *   credential", so editing metadata never erases a saved password/key.
 *
 * Passwords and private keys are write-only: they live in this component's
 * state just long enough to open a connection or save the profile and are never
 * rendered back from Host data.
 */

import { useEffect, useState } from 'react'
import {
  buildProfilePayload,
  normalizeProfilesResult,
  normalizeSession,
  profilesList,
  profilesSave,
  rpc,
} from './api.js'
import { errorMessage, fmt, hostErrorText } from './locale.js'
import { mergeSession, notify, selectSession, setHighlightProfile } from './store.js'
import { Btn, Field, ViewHeader } from './ui.jsx'
import { S } from './styles.js'

const AUTH_OPTIONS = ['password', 'privateKey', 'agent', 'none']

/** Placeholder value in the folder picker that reveals the new-folder input. */
const NEW_FOLDER = '__new__'

function defaultPort(transport) {
  return transport === 'telnet' ? '23' : '22'
}

/**
 * Return value for the folder picker.
 *
 * @param choice - selected option value.
 * @param typed - text typed in the new-folder input.
 * @returns the folder label ('' = ungrouped).
 */
function folderValue(choice, typed) {
  if (choice === NEW_FOLDER) return String(typed || '').trim()
  return typeof choice === 'string' ? choice : ''
}

/**
 * Render the connect form.
 *
 * @param props.t - locale translate function.
 * @param props.onCancel - leave the form (back arrow / cancel button).
 * @param props.onSaved - called with the saved profile id after `profiles.save`
 *   so the library can return to its list and highlight the row; falls back to
 *   `onCancel` when absent.
 * @param props.draft - saved profile being edited (switches to edit mode).
 * @returns the form.
 */
export function ConnectForm({ t, onCancel, onSaved, draft }) {
  const editing = Boolean(draft && typeof draft.id === 'string' && draft.id)

  const [profiles, setProfiles] = useState([])
  const [folders, setFolders] = useState([])
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [profilesError, setProfilesError] = useState(null)

  const [transport, setTransport] = useState(editing ? draft.transport : 'ssh')
  const [profileId, setProfileId] = useState(editing ? draft.id : '')
  const [host, setHost] = useState(editing ? draft.host : '')
  const [port, setPort] = useState(String(editing ? draft.port : defaultPort('ssh')))
  const [username, setUsername] = useState(editing ? draft.username : '')
  const [authType, setAuthType] = useState(editing ? draft.authType : 'password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [saveProfile, setSaveProfile] = useState(false)
  const [profileName, setProfileName] = useState(editing ? draft.name : '')
  const [folderChoice, setFolderChoice] = useState(editing && draft.folder ? draft.folder : '')
  const [newFolder, setNewFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setProfilesLoading(true)
    profilesList()
      .then((raw) => {
        if (cancelled) return
        const normalized = normalizeProfilesResult(raw)
        setProfiles(normalized.profiles)
        setFolders(normalized.folders.map((entry) => entry.name))
      })
      .catch((failure) => {
        if (!cancelled) setProfilesError(errorMessage(failure))
      })
      .finally(() => {
        if (!cancelled) setProfilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const folderNames = [...new Set([
    ...folders,
    ...(editing && draft.folder ? [draft.folder] : []),
  ])]

  const activeProfile = editing ? draft : profiles.find((profile) => profile.id === profileId)
  const canReuseSecret = Boolean(activeProfile) && (
    (authType === 'password' && activeProfile.hasPassword)
    || (authType === 'privateKey' && activeProfile.hasPrivateKey)
  )
  // A selected profile whose saved secret is missing: type it here, or the Host
  // rejects the connect with MISSING_SECRET (the hint says so up front).
  const profileNeedsSecret = Boolean(activeProfile) && !canReuseSecret
    && (authType === 'password' || authType === 'privateKey')
  const secretHint = canReuseSecret
    ? t('profileUsesSavedSecret')
    : profileNeedsSecret
      ? t('profileNeedsSecretHint')
      : null

  const chooseTransport = (next) => {
    setTransport(next)
    if (!editing) setProfileId('')
    setPort((current) => (current === '22' || current === '23' || current === '' ? defaultPort(next) : current))
  }

  /** A manual edit means "connect with these values", not "use the profile". */
  const markManual = () => {
    if (profileId && !editing) setProfileId('')
  }

  const chooseProfile = (id) => {
    setProfileId(id)
    if (!id) return
    const profile = profiles.find((entry) => entry.id === id)
    if (!profile) return
    setTransport(profile.transport)
    setHost(profile.host)
    setPort(String(profile.port))
    setUsername(profile.username)
    setAuthType(profile.authType)
    setFolderChoice(profile.folder || '')
    setPassword('')
    setPrivateKey('')
    setPassphrase('')
    if (!profileName && profile.name) setProfileName(`${profile.name} copy`)
  }

  const toggleSaveProfile = (checked) => {
    setSaveProfile(checked)
    if (checked && !profileName.trim()) {
      const fallback = host.trim() ? `${username.trim() ? `${username.trim()}@` : ''}${host.trim()}` : 'profile'
      setProfileName(fallback)
    }
  }

  /** Client-side target checks, shared by connect and save. */
  const validateTarget = () => {
    if (!host.trim()) return t('errorHostRequired')
    if (transport === 'ssh' && username.trim().length === 0) return t('errorUsernameRequired')
    const portValue = Number(port)
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) return t('errorPort')
    return null
  }

  /** The `profile` payload for `profiles.save` (secrets only when typed). */
  const profilePayload = (name) => buildProfilePayload({
    id: editing ? draft.id : undefined,
    order: editing ? draft.order : undefined,
    name,
    transport,
    host,
    port: Number(port),
    username,
    authType,
    folder: folderValue(folderChoice, newFolder),
    password,
    privateKey,
    passphrase,
  })

  /** Persist the profile being edited, then leave the form. */
  const saveEdit = async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (busy) return
    const problem = validateTarget()
    if (problem) {
      setError(problem)
      return
    }
    const name = profileName.trim()
    if (!name) {
      setError(t('profilesNameRequired'))
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await profilesSave(profilePayload(name))
      const savedId = result && result.profile && result.profile.id ? result.profile.id : draft.id
      notify(t('profilesSaved'))
      // Return to where the form was opened from (the profile library, usually)
      // and let it highlight the row that was just saved.
      if (typeof onSaved === 'function') onSaved(savedId)
      else if (typeof onCancel === 'function') onCancel()
    } catch (failure) {
      setError(fmt(t, 'profilesSaveFailed', { message: errorMessage(failure) }))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (busy) return
    if (editing) {
      await saveEdit()
      return
    }

    const problem = validateTarget()
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setBusy(true)

    try {
      const hostValue = host.trim()
      const portValue = Number(port)
      const params = {
        transport,
        host: hostValue,
        port: portValue,
        cols: 100,
        rows: 30,
      }
      if (profileId) params.profileId = profileId

      // The Host's `sessions.create` reads a FLAT auth shape: `authType` plus
      // `password` / `privateKey` (see lib/host/registry.js resolveTarget). The
      // structured `auth` object is built Host-side; sending it from here would
      // be ignored and would also change how profile-less auth is validated.
      if (transport === 'ssh') {
        const usernameValue = username.trim()
        params.username = usernameValue
        params.authType = authType
        if (authType === 'password' && password) params.password = password
        if (authType === 'privateKey') {
          if (privateKey.trim()) params.privateKey = privateKey
          if (passphrase) params.passphrase = passphrase
        }
      }

      const result = await rpc('sessions.create', params)
      const session = normalizeSession(result && result.session)
      if (result && result.session) mergeSession(result.session)
      if (session) selectSession(session.id)

      if (saveProfile) {
        const name = profileName.trim() || `${username.trim() ? `${username.trim()}@` : ''}${hostValue}`
        try {
          const saved = await profilesSave(profilePayload(name))
          // Highlight the new row the next time the library is opened.
          if (saved && saved.profile && saved.profile.id) setHighlightProfile(saved.profile.id)
          notify(t('profilesSaved'))
        } catch (failure) {
          notify(fmt(t, 'profileSaveFailed', { message: errorMessage(failure) }))
        }
      }
    } catch (failure) {
      // Known Host codes are rendered in the panel language (`hostErrorText`);
      // anything else keeps the Host wording verbatim.
      setError(fmt(t, 'connectFailed', { message: hostErrorText(t, failure) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form style={S.form} onSubmit={submit} noValidate>
      <ViewHeader
        title={editing ? t('profilesEditTitle') : t('connectTitle')}
        hint={editing ? undefined : t('connectHint')}
        onBack={typeof onCancel === 'function' ? onCancel : undefined}
        backLabel={t('back')}
      />
      <div style={S.formScroll}>
        {editing ? <span style={S.hint}>{t('profilesEditHint')}</span> : null}

        <div style={S.row}>
          <div style={S.grow}>
            <Field label={t('transport')}>
              <select
                style={S.select}
                value={transport}
                onChange={(event) => chooseTransport(event.target.value)}
                disabled={busy}
              >
                <option value="ssh">SSH</option>
                <option value="telnet">Telnet</option>
              </select>
            </Field>
          </div>
          {editing ? null : (
            <div style={{ ...S.field, flex: 1.4, minWidth: 0 }}>
              <span style={S.label}>{t('profile')}</span>
              <select
                style={S.select}
                value={profileId}
                onChange={(event) => chooseProfile(event.target.value)}
                disabled={busy || profilesLoading}
              >
                <option value="">{profilesLoading ? t('profileLoading') : t('profileManual')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {`${profile.name} · ${profile.transport} ${profile.host}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!profilesLoading && profiles.length === 0 && !editing ? <span style={S.hint}>{t('profileEmpty')}</span> : null}
        {profilesError ? <span style={S.hint}>{fmt(t, 'profileLoadFailed', { message: profilesError })}</span> : null}

        <div style={S.row}>
          <div style={S.grow}>
            <Field label={t('host')}>
              <input
                style={S.input}
                value={host}
                onChange={(event) => {
                  markManual()
                  setHost(event.target.value)
                }}
                placeholder="10.0.0.5"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
            </Field>
          </div>
          <div style={S.portField}>
            <Field label={t('port')}>
              <input
                style={S.input}
                value={port}
                onChange={(event) => {
                  markManual()
                  setPort(event.target.value.replace(/[^0-9]/g, ''))
                }}
                inputMode="numeric"
                disabled={busy}
              />
            </Field>
          </div>
        </div>

        {transport === 'ssh' ? (
          <>
            <Field label={t('username')}>
              <input
                style={S.input}
                value={username}
                onChange={(event) => {
                  markManual()
                  setUsername(event.target.value)
                }}
                placeholder="root"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
            </Field>

            <Field label={t('authType')}>
              <select
                style={S.select}
                value={authType}
                onChange={(event) => {
                  markManual()
                  setAuthType(event.target.value)
                }}
                disabled={busy}
              >
                {AUTH_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(`auth${option.charAt(0).toUpperCase()}${option.slice(1)}`)}
                  </option>
                ))}
              </select>
            </Field>

            {authType === 'password' ? (
              <Field label={t('password')} hint={secretHint || t('passwordHint')}>
                <input
                  style={S.input}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </Field>
            ) : null}

            {authType === 'privateKey' ? (
              <>
                <Field label={t('privateKey')} hint={secretHint || t('privateKeyHint')}>
                  <textarea
                    style={S.textarea}
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                  />
                </Field>
                <Field label={t('passphrase')}>
                  <input
                    style={S.input}
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </Field>
              </>
            ) : null}
          </>
        ) : (
          <span style={S.hint}>{t('passwordHint')}</span>
        )}

        <Field label={t('folder')} hint={folderChoice === NEW_FOLDER ? t('folderName') : undefined}>
          <select
            style={S.select}
            value={folderChoice}
            aria-label={t('folder')}
            onChange={(event) => setFolderChoice(event.target.value)}
            disabled={busy}
          >
            <option value="">{t('folderNone')}</option>
            {folderNames.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={NEW_FOLDER}>{t('folderNew')}</option>
          </select>
        </Field>
        {folderChoice === NEW_FOLDER ? (
          <Field label={t('folderName')}>
            <input
              style={S.input}
              value={newFolder}
              aria-label={t('folderName')}
              placeholder={t('folderName')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setNewFolder(event.target.value)}
              disabled={busy}
            />
          </Field>
        ) : null}

        {editing ? (
          <Field label={t('profileName')}>
            <input
              style={S.input}
              value={profileName}
              aria-label={t('profileName')}
              onChange={(event) => setProfileName(event.target.value)}
              disabled={busy}
            />
          </Field>
        ) : (
          <>
            <label style={S.checkboxRow}>
              <input
                type="checkbox"
                style={S.checkbox}
                checked={saveProfile}
                onChange={(event) => toggleSaveProfile(event.target.checked)}
                disabled={busy}
              />
              {t('saveProfile')}
            </label>

            {saveProfile ? (
              <Field label={t('profileName')}>
                <input
                  style={S.input}
                  value={profileName}
                  aria-label={t('profileName')}
                  onChange={(event) => setProfileName(event.target.value)}
                  disabled={busy}
                />
              </Field>
            ) : null}
          </>
        )}

        {error ? <div style={S.formError} role="alert">{error}</div> : null}
      </div>

      <div style={S.formActions}>
        {typeof onCancel === 'function' ? (
          <Btn onClick={onCancel} disabled={busy}>{t('cancel')}</Btn>
        ) : null}
        <Btn type="submit" variant="primary" onClick={submit} busy={busy} disabled={busy}>
          {editing
            ? (busy ? t('connectingAction') : t('profilesSaveAction'))
            : (busy ? t('connectingAction') : t('connectAction'))}
        </Btn>
      </div>
    </form>
  )
}
