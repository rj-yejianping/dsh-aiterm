/**
 * Quick-script bar: one-click saved scripts, grouped by folder.
 *
 * Rendered under the terminal (the row of buttons a terminal app puts at the
 * bottom of the window). Clicking a chip runs that script against the current
 * session with the script's default parameter values; a script that declares
 * required parameters without defaults still runs — the Host reports the
 * missing parameter inside the progress panel, and the chip points at the
 * scripts panel for the full form.
 *
 * The bar owns its own `scripts.list` fetch (the panel's list is local to the
 * panel) and re-fetches whenever it is opened, so a script saved in the panel
 * shows up here immediately.
 */

import { useEffect, useRef, useState } from 'react'
import { normalizeScriptSummary, scriptsList, scriptsRun } from './api.js'
import { errorMessage, fmt } from './locale.js'
import { notify } from './store.js'
import { Btn, Sheet } from './ui.jsx'
import { sortScriptNames } from './scriptOrder.js'
import { C, S } from './styles.js'

/** How many chips render before the row is scrolled (display only). */
const CHIP_LIMIT = 200

/** localStorage key for the「which folders show in the quick bar」preference. */
const HIDDEN_KEY = 'dsh.aiterm.quickHiddenFolders'

/**
 * Read the set of folders hidden from the quick bar.
 *
 * @returns {string[]} hidden folder names.
 */
function readHidden() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(HIDDEN_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Replace the hidden-folder set.
 *
 * @param names - folder names to hide.
 * @returns {void}
 */
function writeHidden(names) {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(HIDDEN_KEY, JSON.stringify(names))
  } catch {
    /* storage unavailable: the choice simply does not persist */
  }
}

/**
 * Group summaries by folder, ungrouped last, honouring the user's local order
 * (`scriptOrder.js`) inside each folder — the same order the scripts panel shows.
 *
 * @param summaries - normalized `ScriptSummary[]`.
 * @returns `[{ folder, items }]` with `''` for 未分组.
 */
function groupScripts(summaries) {
  /** @type {Map<string, any[]>} */
  const byFolder = new Map()
  for (const summary of summaries) {
    const folder = summary.folder || ''
    if (!byFolder.has(folder)) byFolder.set(folder, [])
    byFolder.get(folder).push(summary)
  }
  const names = [...byFolder.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })
  return names.map((folder) => {
    const items = byFolder.get(folder)
    const ordered = sortScriptNames(folder, items.map((item) => item.name))
    return {
      folder,
      items: ordered
        .map((name) => items.find((item) => item.name === name))
        .filter(Boolean),
    }
  })
}

/**
 * The quick bar itself.
 *
 * @param props.t - locale translator.
 * @param props.sessionId - session the chips run against.
 * @param props.open - whether the bar is visible.
 * @param props.onToggle - show/hide handler (also collapses the bar).
 * @param props.onOpenLibrary - open the scripts panel for the full editor.
 * @returns the bar.
 */
export function QuickScripts({ t, sessionId, open, onToggle, onOpenLibrary }) {
  const [groups, setGroups] = useState([])
  const [loadState, setLoadState] = useState('idle')
  const [busyName, setBusyName] = useState(null)
  /** Folders the user hid from the bar (persisted). */
  const [hidden, setHidden] = useState(() => readHidden())
  /** Whether the folder-visibility checklist is open. */
  const [picking, setPicking] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Re-fetch whenever the bar becomes visible: the panel may have saved a script
  // since the last time it was opened.
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoadState((current) => (current === 'idle' ? 'loading' : current))
    scriptsList()
      .then((raw) => {
        if (cancelled || !aliveRef.current) return
        const summaries = (raw && Array.isArray(raw.scripts) ? raw.scripts : []).map(normalizeScriptSummary).filter(Boolean)
        setGroups(groupScripts(summaries.slice(0, CHIP_LIMIT)))
        setLoadState(summaries.length === 0 ? 'empty' : 'ready')
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const allFolders = groups.map((group) => group.folder)
  const visibleGroups = groups.filter((group) => !hidden.includes(group.folder))

  /** Hide or show one folder in the bar. @param folder - folder name ("" = ungrouped). */
  const toggleFolder = (folder) => {
    const next = hidden.includes(folder)
      ? hidden.filter((entry) => entry !== folder)
      : [...hidden, folder]
    setHidden(next)
    writeHidden(next)
  }

  const run = async (summary) => {
    if (busyName !== null) return
    if (!sessionId) {
      notify(t('quickScriptsNoSession'))
      return
    }
    setBusyName(summary.name)
    try {
      const result = await scriptsRun({ name: summary.name, params: {}, sessionId })
      const runs = result && result.result && Array.isArray(result.result.runs) ? result.result.runs : []
      const failed = runs.filter((entry) => entry && entry.ok === false).length
      notify(
        failed > 0
          ? fmt(t, 'quickScriptsPartial', { name: summary.name, failed })
          : fmt(t, 'quickScriptsDone', { name: summary.name }),
      )
    } catch (error) {
      notify(fmt(t, 'quickScriptsFailed', { name: summary.name, message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setBusyName(null)
    }
  }

  if (!open) {
    return (
      <div style={S.quickBarCollapsed}>
        <Btn title={t('quickScripts')} ariaLabel={t('quickScripts')} onClick={onToggle}>
          {t('quickScriptsShow')}
        </Btn>
      </div>
    )
  }

  return (
    <div style={S.quickBar} role="toolbar" aria-label={t('quickScripts')}>
      <div style={S.quickBarHead}>
        <span style={S.quickBarTitle}>{t('quickScripts')}</span>
        <span style={S.controlSpacer} />
        {loadState === 'loading' ? <span style={S.hint}>{t('loading')}</span> : null}
        {loadState === 'error' ? <span style={S.hint}>{t('quickScriptsLoadFailed')}</span> : null}
        <Btn
          active={picking}
          onClick={() => setPicking((open) => !open)}
          title={t('quickFolderVisibility')}
        >
          {t('quickFolderVisibility')}
        </Btn>
        <Btn onClick={onOpenLibrary} title={t('scriptsTitle')}>
          {t('quickScriptsManage')}
        </Btn>
        <Btn onClick={onToggle} title={t('quickScriptsHide')}>
          {t('quickScriptsHide')}
        </Btn>
      </div>
      {picking ? (
        <div style={S.quickBarRow} role="group" aria-label={t('quickFolderVisibility')}>
          {allFolders.length === 0 ? <span style={S.hint}>{t('quickScriptsEmpty')}</span> : null}
          {allFolders.map((folder) => (
            <label key={folder || '__ungrouped'} style={S.pickRow}>
              <input
                type="checkbox"
                checked={!hidden.includes(folder)}
                onChange={() => toggleFolder(folder)}
                style={S.pickBox}
              />
              <span style={S.pickTitle}>{folder || t('scriptsUngrouped')}</span>
            </label>
          ))}
        </div>
      ) : null}
      <div style={S.quickBarRow}>
        {loadState === 'empty' ? (
          <span style={S.hint}>{t('quickScriptsEmpty')}</span>
        ) : (
          visibleGroups.map((group) => (
            <span key={group.folder || '__ungrouped'} style={S.quickGroup}>
              <span style={S.quickFolder}>{group.folder || t('scriptsUngrouped')}</span>
              {group.items.map((summary) => (
                <button
                  key={summary.name}
                  type="button"
                  style={{
                    ...S.quickChip,
                    ...(busyName === summary.name ? S.quickChipBusy : null),
                  }}
                  title={`${summary.name}${summary.folder ? ` · ${summary.folder}` : ''} · ${fmt(t, 'scriptsSteps', { count: summary.stepCount })}`}
                  disabled={busyName !== null}
                  onClick={() => run(summary)}
                >
                  {busyName === summary.name ? '…' : summary.name}
                </button>
              ))}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * Full-screen fallback used when the bar is closed: a compact launcher sheet.
 *
 * Kept separate so the terminal keeps its height; the bar is the primary path.
 *
 * @param props.t - locale translator.
 * @param props.open - whether the sheet shows.
 * @param props.onClose - close handler.
 * @param props.onRun - run a named script.
 * @returns the sheet or null.
 */
export function QuickScriptsSheet({ t, open, onClose, onRun }) {
  const [groups, setGroups] = useState([])
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    scriptsList()
      .then((raw) => {
        if (cancelled) return
        setGroups(groupScripts((raw && Array.isArray(raw.scripts) ? raw.scripts : []).map(normalizeScriptSummary).filter(Boolean)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])
  if (!open) return null
  return (
    <Sheet title={t('quickScripts')} onClose={onClose} closeLabel={t('cancel')}>
      {groups.length === 0 ? <span style={S.hint}>{t('quickScriptsEmpty')}</span> : null}
      {groups.map((group) => (
        <div key={group.folder || '__ungrouped'} style={S.quickSheetGroup}>
          <div style={S.listGroupHeader}>{group.folder || t('scriptsUngrouped')}</div>
          {group.items.map((summary) => (
            <button
              key={summary.name}
              type="button"
              style={{ ...S.listRow, color: C.labelPrimary }}
              onClick={() => onRun(summary)}
            >
              <span style={S.listRowTitle}>{summary.name}</span>
              <span style={S.listRowMeta}>{fmt(t, 'scriptsSteps', { count: summary.stepCount })}</span>
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  )
}
