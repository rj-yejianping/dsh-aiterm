/**
 * 脚本（Scripts）panel: a master-detail script manager.
 *
 * Layout (left → right, then bottom):
 * - creation row: 新建 · 逐行命令 / 新建 · 高级脚本. Neither is a permanent
 *   primary button: while a draft is open, the button matching the draft's
 *   dialect is the only one drawn as active, and with no draft both are
 *   secondary. (The two dialects are separate creation paths — no conversion.)
 * - folder bar: 分组 scope picker + 添加分组 / 重命名分组 / 删除分组.
 * - split: the left column lists the scripts of the scoped folder (click to
 *   select) with [+ 新建] [− 删除] [▲ 上移] [▼ 下移] [复制] below it; the right
 *   column edits the selection (名称 / 类型 / 内容 / 保存 / 取消).
 * - run section below the split: 运行目标 + params + 运行, plus a single-line
 *   result summary and [查看结果]. The full run log is NOT rendered in the flow:
 *   it opens in an {@link OverlayWindow} floating above the panel, so collapsing
 *   it cannot leave a reserved blank block behind.
 *
 * Data sources (CONTRACTS.md §12.3, §14.4):
 * - `scripts.list` `{}` → `{ scripts: ScriptSummary[] }` (no steps; `scripts.get`
 *   is used to load the editor)
 * - `scripts.get` `{ name }` → `{ script: ScriptDefinition }`
 * - `scripts.save` `{ script }` → `{ script: ScriptSummary }`   (human only)
 * - `scripts.delete` `{ name }` → `{ ok: boolean }`              (human only)
 * - `scripts.run` `{ name, params?, sessionId?, targets? }` → `{ result: BatchResult }`
 * - global SSE `{ type: 'batch', batchId, label?, state: 'step' | 'done', … }`
 *
 * The macro dialect compiles to `steps` only, so 名称 / 描述 / 分组 / 参数 are
 * kept in the editor metadata and merged into the save payload for both
 * dialects — dropping them was a real bug (the Host rejected the save).
 *
 * Display order is client-side only: the Host has no `order` field, so ▲/▼ write
 * to `scriptOrder.js` (localStorage) and never rewrite the script.
 */

import { useEffect, useRef, useState } from 'react'
import {
  normalizeScriptDefinition,
  normalizeScriptSummary,
  oneLine,
  scriptsDelete,
  scriptsGet,
  scriptsList,
  scriptsRun,
  scriptsSave,
  truncateText,
} from './api.js'
import { errorMessage, fmt } from './locale.js'
import {
  STEP_TEMPLATES,
  insertTemplate,
  kindLabelKey,
  validateScriptDefinition,
} from './scriptLang.js'
import {
  createBatchState,
  finishBatch,
  notify,
  startBatch,
  useAppState,
} from './store.js'
import { Btn, Field, InlineConfirm, OverlayWindow, Segmented, Sheet } from './ui.jsx'
import { parseMacro, serializeMacro, insertMacroTemplate, MACRO_TEMPLATES } from './macroLang.js'
import { dialectOf, rememberDialect } from './scriptDialect.js'
import {
  forgetFolder,
  forgetScript,
  moveScript,
  renameFolderOrder,
  sortScriptNames,
} from './scriptOrder.js'
import { C, S } from './styles.js'

/** Steps keep living progress compact; the full text is in the result. */
const STEP_TEXT_LIMIT = 200

/** At most this many validation problems are rendered at once. */
const VALIDATION_SHOWN = 3

/** Starter text a brand-new script opens with (placeholder, not a step list). */
const MACRO_STARTER = [
  '# 每行一条命令，例如：',
  "uname -a",
  '@wait 300',
  '',
].join('\n')

/** Template for 新建: a fresh script with no steps yet. */
const EMPTY_DEFINITION = { name: '', description: '', folder: '', params: {}, steps: [] }

/**
 * `user@host:port` label for a session row.
 *
 * @param session - session info from the store.
 * @returns the address string.
 */
function sessionAddress(session) {
  const user = session.username ? `${session.username}@` : ''
  const port = session.port ? `:${session.port}` : ''
  return `${user}${session.host}${port}`
}

/**
 * Pretty-print the editable fields of one script definition.
 *
 * @param definition - normalized `ScriptDefinition`.
 * @returns the editor text (pretty JSON, or '' when unrepresentable).
 */
function serializeDefinition(definition) {
  try {
    return JSON.stringify({
      name: definition.name,
      description: definition.description,
      folder: definition.folder,
      params: definition.params,
      steps: definition.steps,
    }, null, 2)
  } catch {
    return ''
  }
}

/**
 * One live progress row: `"  " * depth + path · kind · ✓/✗ · session · text`.
 *
 * v3 batch frames carry `depth`, `path` and `kind`; v2 frames fall back to the
 * flat `#stepIndex` and a neutral kind label so older Hosts still render. A
 * failing step may also carry a `code`, which stays available in the tooltip.
 *
 * @param props.line - stored batch line.
 * @param props.t - locale translate function.
 * @returns the row.
 */
function ProgressRow({ line, t }) {
  const raw = line.ok ? line.text : (line.error || line.text)
  const text = truncateText(oneLine(raw), STEP_TEXT_LIMIT)
  const full = truncateText(oneLine(raw), 500)
  const tooltip = [full, line.code].filter(Boolean).join(' · ')
  const depth = Number.isInteger(line.depth) && line.depth > 0 ? line.depth : 0
  const path = line.path ? line.path : `#${line.stepIndex}`
  return (
    <div style={S.batchLine} title={tooltip || undefined}>
      <span style={S.batchPath}>{`${'  '.repeat(depth)}${path}`}</span>
      <span style={S.batchSep}>·</span>
      <span style={S.batchKind}>{t(kindLabelKey(line.kind))}</span>
      <span style={S.batchSep}>·</span>
      <span style={{ flex: 'none', color: line.ok ? C.success : C.danger }}>{line.ok ? '✓' : '✗'}</span>
      <span style={S.batchSession}>{line.sessionId}</span>
      <span style={S.batchText}>{text || '—'}</span>
    </div>
  )
}

/**
 * Render the scripts panel.
 *
 * @param props.t - locale translate function.
 * @param props.sessionId - currently selected session (default run target).
 * @param props.onClose - close handler.
 * @returns the panel.
 */
export function ScriptsPanel({ t, sessionId, onClose }) {
  const app = useAppState()
  const [scripts, setScripts] = useState([])
  const [listState, setListState] = useState('loading')
  const [listError, setListError] = useState(null)
  /** Folder currently shown in the left column ('' = 未分组). */
  const [folderScope, setFolderScope] = useState('')
  /** Folders created here that contain no script yet (the Host derives folders). */
  const [extraFolders, setExtraFolders] = useState([])
  const [selectedName, setSelectedName] = useState(null)
  /** Open editor draft: `{ mode, meta, text, seededFrom }` or null. */
  const [draft, setDraft] = useState(null)
  /** Whether the 「+ 新建」 dialect chooser is open. */
  const [newChoice, setNewChoice] = useState(false)
  const [draftLoading, setDraftLoading] = useState(false)
  const [draftError, setDraftError] = useState(null)
  /** Bumped after a local ▲/▼ move so the list re-sorts. */
  const [orderVersion, setOrderVersion] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [folderAddOpen, setFolderAddOpen] = useState(false)
  const [folderAddName, setFolderAddName] = useState('')
  const [folderRenameOpen, setFolderRenameOpen] = useState(false)
  const [folderRenameDraft, setFolderRenameDraft] = useState('')
  /** Inline confirmation for deleting the scoped folder. */
  const [folderConfirm, setFolderConfirm] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState(null)
  const [editorNotice, setEditorNotice] = useState(null)
  const [emptyConfirm, setEmptyConfirm] = useState(false)
  const [paramValues, setParamValues] = useState({})
  const [targetMode, setTargetMode] = useState('current')
  /** Session ids ticked in the「选定会话」mode (explicit multi-target run). */
  const [picked, setPicked] = useState([])
  const [runError, setRunError] = useState(null)
  /** Whether the floating results window is open (never part of the flow). */
  const [resultsOpen, setResultsOpen] = useState(false)
  const progressRef = useRef(null)
  const aliveRef = useRef(true)

  const batch = app && app.batch ? app.batch : createBatchState()
  const running = batch.state === 'running' || batch.pending
  const allSessions = app && Array.isArray(app.sessions) ? app.sessions : []
  const openSessions = allSessions.filter((session) => session && session.state === 'open')
  const script = scripts.find((entry) => entry.name === selectedName) || null
  const lines = Array.isArray(batch.lines) ? batch.lines : []
  const runs = batch.runs || null

  /** All folder names known locally (from scripts + folders added here). */
  const folders = [...new Set([
    ...scripts.map((entry) => entry.folder || '').filter((name) => name !== ''),
    ...extraFolders,
  ])].sort((left, right) => left.localeCompare(right))

  const folderScripts = scripts.filter((entry) => (entry.folder || '') === folderScope)
  const folderNames = folderScripts.map((entry) => entry.name)
  // `orderVersion` is a dependency-only bump: scriptOrder lives in localStorage,
  // so a ▲/▼ move must force this render.
  const orderedNames = sortScriptNames(folderScope, folderNames)
  const orderedScripts = orderedNames
    .map((name) => folderScripts.find((entry) => entry.name === name))
    .filter(Boolean)
  const selectedIndex = selectedName ? orderedNames.indexOf(selectedName) : -1
  const canMoveUp = selectedIndex > 0
  const canMoveDown = selectedIndex >= 0 && selectedIndex < orderedNames.length - 1

  /**
   * Reload the script list.
   *
   * @param preferName - script to select afterwards (falls back to the first in
   *   the scoped folder).
   * @param options.openDraft - also load the selected script into the editor.
   * @param options.scope - folder to show afterwards (defaults to the current
   *   scope); callers that just changed folders pass it explicitly because the
   *   state update has not landed yet.
   * @returns {Promise<void>} resolves after the list state settled.
   */
  async function loadScripts(preferName, options = {}) {
    setListState('loading')
    setListError(null)
    try {
      const raw = await scriptsList()
      if (!aliveRef.current) return
      const list = raw && Array.isArray(raw.scripts)
        ? raw.scripts.map(normalizeScriptSummary).filter(Boolean)
        : []
      setScripts(list)
      setListState(list.length > 0 ? 'ready' : 'empty')

      const knownFolders = [...new Set([
        ...list.map((entry) => entry.folder || '').filter((name) => name !== ''),
        ...extraFolders,
      ])].sort((a, b) => a.localeCompare(b))
      const current = typeof options.scope === 'string' ? options.scope : folderScope
      const hasUngrouped = list.some((entry) => (entry.folder || '') === '')
      // Keep the requested scope while it still exists; otherwise fall back to
      // 未分组 when it has scripts, then to the first folder that does. The list
      // must never stay scoped to an empty folder just because 未分组 is empty.
      let scope = current
      if (current !== '' && !knownFolders.includes(current)) scope = ''
      if (scope === '' && !hasUngrouped && knownFolders.length > 0) scope = knownFolders[0]
      setFolderScope(scope)

      const inScope = list.filter((entry) => (entry.folder || '') === scope)
      const wanted = typeof preferName === 'string' && preferName !== '' ? preferName : selectedName
      const next = inScope.find((entry) => entry.name === wanted) || inScope[0] || null
      setSelectedName(next ? next.name : null)
      setConfirmDelete(false)
      if (options.openDraft === true) await openDraft(next ? next.name : null)
      else if (!next) setDraft(null)
    } catch (error) {
      if (!aliveRef.current) return
      setListError(errorMessage(error))
      setListState('error')
    }
  }

  /**
   * Load one script's full definition into the editor (the list only has
   * summaries; seeding an empty program would wipe the script on save).
   *
   * @param name - script name, or null to clear the editor.
   * @returns {Promise<void>} resolves when the draft (or error) is set.
   */
  async function openDraft(name) {
    if (!name) {
      setDraft(null)
      setDraftError(null)
      setDraftLoading(false)
      return
    }
    setDraftLoading(true)
    setDraftError(null)
    setEditError(null)
    setEditorNotice(null)
    setEmptyConfirm(false)
    try {
      const raw = await scriptsGet(name)
      if (!aliveRef.current) return
      const definition = normalizeScriptDefinition(raw && raw.script)
      if (!definition) {
        setDraft(null)
        setDraftError(fmt(t, 'scriptsGetInvalid', { name }))
        return
      }
      // The dialect is a property of the script (recorded when it was created);
      // a program the per-line syntax cannot express always falls back to JSON so
      // if/loop structure is never hidden.
      const asMacro = serializeMacro(definition.steps)
      const mode = dialectOf(definition.name) === 'json' || asMacro.ok !== true ? 'json' : 'macro'
      setDraft({
        mode,
        seededFrom: definition.name,
        meta: {
          name: definition.name,
          description: typeof definition.description === 'string' ? definition.description : '',
          folder: typeof definition.folder === 'string' ? definition.folder : '',
          params: definition.params && typeof definition.params === 'object' ? definition.params : {},
        },
        text: mode === 'json' ? serializeDefinition(definition) : asMacro.text,
      })
    } catch (error) {
      // The Host message is shown verbatim (404 SCRIPT_NOT_FOUND is actionable).
      if (!aliveRef.current) return
      setDraft(null)
      setDraftError(fmt(t, 'scriptsGetFailed', { message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setDraftLoading(false)
    }
  }

  useEffect(() => {
    aliveRef.current = true
    loadScripts(undefined, { openDraft: true })
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Re-seed parameter values whenever the selected script (or list) changes.
  useEffect(() => {
    const next = {}
    if (script) {
      for (const [name, definition] of Object.entries(script.params || {})) {
        next[name] = definition && typeof definition.default === 'string' ? definition.default : ''
      }
    }
    setParamValues(next)
  }, [selectedName, scripts])

  // A run opens the results window so live progress is visible; the user may
  // still close it and reopen with 查看结果.
  useEffect(() => {
    if (batch.state === 'running' || batch.pending) setResultsOpen(true)
  }, [batch.state, batch.pending])

  // Follow live progress inside the results window.
  useEffect(() => {
    const node = progressRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines.length, batch.state, resultsOpen])

  /** Select one script and load it into the editor. @param name - script name. */
  const chooseScript = (name) => {
    if (name === selectedName && draft) return
    setSelectedName(name)
    setRunError(null)
    setConfirmDelete(false)
    setFolderConfirm(false)
    openDraft(name)
  }

  /**
   * Switch the scoped folder and select its first script (loaded into the
   * editor so the right pane never goes stale).
   *
   * @param name - folder name ('' = 未分组).
   */
  const chooseFolder = (name) => {
    setFolderScope(name)
    setConfirmDelete(false)
    setFolderConfirm(false)
    setFolderRenameOpen(false)
    setFolderAddOpen(false)
    const inFolder = scripts.filter((entry) => (entry.folder || '') === name)
    const ordered = sortScriptNames(name, inFolder.map((entry) => entry.name))
    const first = ordered.length > 0 ? ordered[0] : null
    setSelectedName(first)
    setRunError(null)
    if (first) openDraft(first)
    else {
      setDraft(null)
      setDraftError(null)
    }
  }

  /**
   * Start a new script draft in one dialect.
   *
   * @param dialect - 'macro' (逐行命令) or 'json' (高级脚本).
   */
  const startNew = (dialect = 'macro') => {
    if (saving || draftLoading) return
    setSelectedName(null)
    setEditError(null)
    setEditorNotice(null)
    setEmptyConfirm(false)
    setDraftError(null)
    setConfirmDelete(false)
    setRunError(null)
    setDraft({
      mode: dialect,
      seededFrom: null,
      
      meta: { name: '', description: '', folder: folderScope, params: {} },
      text: dialect === 'macro' ? MACRO_STARTER : JSON.stringify(EMPTY_DEFINITION, null, 2),
    })
  }

  /** Discard the draft: reload a saved script, or close the blank editor. */
  const cancelDraft = () => {
    setEditError(null)
    setEditorNotice(null)
    setEmptyConfirm(false)
    if (draft && draft.seededFrom) openDraft(draft.seededFrom)
    else setDraft(null)
  }

  /** Patch the open draft (immutable). @param patch - partial draft / partial meta. */
  const updateDraft = (patch) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateMeta = (patch) => {
    setDraft((current) => (current ? { ...current, meta: { ...current.meta, ...patch } } : current))
  }

  /**
   * Insert one skeleton from the template dropdown into the editor.
   *
   * @param templateId - id from `STEP_TEMPLATES` (or 'python' in macro mode).
   */
  const applyTemplate = (templateId) => {
    if (!templateId || saving || !draft) return
    // Two disjoint template sets: the macro list inserts line syntax, the JSON
    // list inserts step skeletons. Showing one list under the other dialect
    // would insert the wrong shape (that is what 'python' used to work around).
    if (draft.mode === 'macro') {
      const text = insertMacroTemplate(draft.text, templateId)
      if (text !== null) {
        updateDraft({ text })
        setEditError(null)
        setEmptyConfirm(false)
        setEditorNotice(null)
      }
      return
    }
    try {
      const result = insertTemplate(draft.text, templateId)
      if (!result || result.ok !== true) return
      updateDraft({ text: result.text })
      setEditError(null)
      setEmptyConfirm(false)
      setEditorNotice(result.rebuilt ? t('scriptsTemplateRebuilt') : null)
    } catch (error) {
      setEditError(errorMessage(error))
    }
  }

  const saveScript = async () => {
    if (saving || !draft) return
    /** @type {any} */
    let parsed
    if (draft.mode === 'macro') {
      // The macro is compiled here, in the client: the stored format stays the
      // same step list the Host already validates, so nothing changes server-side.
      // Commands are sent exactly as typed (the「等命令跑完」toggle was removed).
      const compiled = parseMacro(draft.text)
      if (compiled.ok !== true) {
        setEditError(fmt(t, 'scriptsMacroParseError', { line: compiled.line, message: compiled.message }))
        return
      }
      parsed = { steps: compiled.steps }
    } else {
      try {
        parsed = JSON.parse(draft.text)
      } catch (error) {
        setEditError(fmt(t, 'scriptsJsonInvalid', { message: errorMessage(error) }))
        return
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEditError(t('scriptsJsonObject'))
      return
    }

    // Structural validation first: the Host would reject the same program with
    // a terse BAD_SCRIPT, while this reports the exact JSON path.
    let problems
    try {
      problems = validateScriptDefinition(parsed)
    } catch (error) {
      setEditError(errorMessage(error))
      return
    }
    if (problems.length > 0) {
      const messages = problems.slice(0, VALIDATION_SHOWN).map((entry) => fmt(t, 'scriptsValidateAt', {
        path: entry.path,
        message: fmt(t, entry.key, entry.params),
      }))
      if (problems.length > VALIDATION_SHOWN) {
        messages.push(fmt(t, 'scriptsValidateMore', { count: problems.length - VALIDATION_SHOWN }))
      }
      setEditError(messages.join('\n'))
      return
    }

    // An existing script seeded from `scripts.get` must never be wiped by a
    // single click: an empty program needs an explicit second confirmation.
    const steps = Array.isArray(parsed.steps) ? parsed.steps : []
    const seeded = typeof draft.seededFrom === 'string' && draft.seededFrom !== ''
    if (seeded && steps.length === 0 && !emptyConfirm) {
      const summary = scripts.find((entry) => entry.name === draft.seededFrom) || null
      const originalSteps = summary ? summary.stepCount : 0
      if (originalSteps > 0) {
        setEmptyConfirm(true)
        setEditError(fmt(t, 'scriptsEmptySaveWarn', { count: originalSteps }))
        return
      }
    }

    // 名称 / 描述 / 分组 come from the metadata fields in BOTH dialects (the
    // macro body only supplies steps); the JSON body may carry params.
    const name = String(draft.meta.name || '').trim()
      || (typeof parsed.name === 'string' ? parsed.name.trim() : '')
    if (name === '') {
      setEditError(t('scriptsNameRequired'))
      return
    }
    const payload = {
      name,
      description: draft.meta.description || (typeof parsed.description === 'string' ? parsed.description : ''),
      folder: draft.meta.folder || (typeof parsed.folder === 'string' ? parsed.folder : ''),
      params: parsed.params && typeof parsed.params === 'object' && Object.keys(parsed.params).length > 0
        ? parsed.params
        : draft.meta.params,
      steps,
    }

    setSaving(true)
    setEditError(null)
    try {
      const raw = await scriptsSave(payload)
      if (!aliveRef.current) return
      const summary = normalizeScriptSummary(raw && raw.script)
      const savedName = summary ? summary.name : payload.name
      rememberDialect(savedName, draft.mode)
      notify(t('scriptsSaved'))
      setEmptyConfirm(false)
      const savedScope = payload.folder
      setFolderScope(savedScope)
      setFolderRenameOpen(false)
      await loadScripts(savedName, { openDraft: true, scope: savedScope })
    } catch (error) {
      // The Host message is shown verbatim (validation errors are actionable).
      if (!aliveRef.current) return
      setEditError(errorMessage(error))
    } finally {
      if (aliveRef.current) setSaving(false)
    }
  }

  /** First click opens the inline confirmation bar; it never deletes by itself. */
  const startDelete = () => {
    if (!script || deleting || running) return
    setConfirmDelete(true)
  }

  const deleteScript = async () => {
    if (!script || deleting || running) return
    setConfirmDelete(false)
    setDeleting(true)
    setRunError(null)
    try {
      const removed = script
      await scriptsDelete(removed.name)
      if (!aliveRef.current) return
      forgetScript(removed.folder || '', removed.name)
      notify(t('scriptsDeleted'))
      setDraft(null)
      await loadScripts('')
    } catch (error) {
      if (!aliveRef.current) return
      setRunError(fmt(t, 'scriptsDeleteFailed', { message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setDeleting(false)
    }
  }

  /**
   * Duplicate the selected script as `<name>-copy` (incrementing when taken).
   *
   * The copy is a full definition read back from the Host, never a summary, so
   * the steps (and parameters) survive; the dialect is recorded for the copy too.
   */
  const duplicateScript = async () => {
    if (!script || saving || deleting) return
    setRunError(null)
    setSaving(true)
    try {
      const raw = await scriptsGet(script.name)
      if (!aliveRef.current) return
      const definition = normalizeScriptDefinition(raw && raw.script)
      if (!definition) throw new Error(fmt(t, 'scriptsGetInvalid', { name: script.name }))
      const taken = new Set(scripts.map((entry) => entry.name))
      let copyName = `${script.name}-copy`
      let suffix = 2
      while (taken.has(copyName)) {
        copyName = `${script.name}-copy${suffix}`
        suffix += 1
      }
      const saved = await scriptsSave({
        name: copyName,
        description: definition.description,
        folder: definition.folder,
        params: definition.params,
        steps: definition.steps,
      })
      if (!aliveRef.current) return
      const summary = normalizeScriptSummary(saved && saved.script)
      const finalName = summary ? summary.name : copyName
      rememberDialect(finalName, dialectOf(script.name))
      notify(fmt(t, 'scriptsCopied', { name: finalName }))
      await loadScripts(finalName, { openDraft: true })
    } catch (error) {
      if (!aliveRef.current) return
      setRunError(fmt(t, 'scriptsCopyFailed', { message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setSaving(false)
    }
  }

  /**
   * Move the selected script up/down in the local display order (§ no Host order).
   *
   * @param delta - -1 for ▲, +1 for ▼.
   */
  const moveSelected = (delta) => {
    if (!selectedName) return
    const result = moveScript(folderScope, orderedNames, selectedName, delta)
    if (result.moved) setOrderVersion((value) => value + 1)
  }

  /** Sessions ticked in 选定会话, still restricted to sessions that are open. */
  const pickedOpen = openSessions.map((session) => session.id).filter((id) => picked.includes(id))

  const togglePicked = (id) => {
    setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }

  const runScript = async () => {
    if (!script || running) return
    if (targetMode === 'current' && !sessionId) {
      setRunError(t('scriptsTargetNoSessions'))
      return
    }
    const targets = openSessions.map((session) => session.id)
    if (targetMode === 'all' && targets.length === 0) {
      setRunError(t('scriptsTargetNoSessions'))
      return
    }
    if (targetMode === 'selected' && pickedOpen.length === 0) {
      setRunError(t('scriptsTargetPickedEmpty'))
      return
    }
    setRunError(null)
    startBatch(`script:${script.name}`)

    const values = {}
    for (const [name, value] of Object.entries(paramValues)) values[name] = value
    const payload = { name: script.name, params: values }
    if (targetMode === 'all') payload.targets = targets
    else if (targetMode === 'selected') payload.targets = pickedOpen
    else payload.sessionId = sessionId

    try {
      const raw = await scriptsRun(payload)
      finishBatch({ result: raw && raw.result })
    } catch (error) {
      finishBatch({ error: errorMessage(error) })
    }
  }

  /**
   * A folder is just a field on each script, so renaming/deleting one means
   * re-saving the scripts it contains. Each rewrite is the script's full
   * definition read back from the Host, never a summary — a partial save would
   * wipe the steps.
   *
   * @param from - current folder name.
   * @param to - new name, or '' to move the scripts to 未分组.
   * @returns {Promise<void>} resolves when every script was rewritten.
   */
  const rewriteFolder = async (from, to) => {
    const affected = scripts.filter((entry) => (entry.folder || '') === from)
    for (const entry of affected) {
      const raw = await scriptsGet(entry.name)
      const definition = normalizeScriptDefinition(raw && raw.script)
      if (!definition) throw new Error(fmt(t, 'scriptsGetInvalid', { name: entry.name }))
      await scriptsSave({
        name: definition.name,
        description: definition.description,
        folder: to,
        params: definition.params,
        steps: definition.steps,
      })
    }
  }

  const addFolder = () => {
    const name = String(folderAddName || '').trim().slice(0, 64)
    if (name === '') return
    setExtraFolders((current) => (current.includes(name) ? current : current.concat([name])))
    setFolderScope(name)
    setSelectedName(null)
    setDraft(null)
    setDraftError(null)
    setFolderAddName('')
    setFolderAddOpen(false)
    notify(fmt(t, 'scriptsFolderAdded', { name }))
  }

  const renameFolder = async () => {
    const next = String(folderRenameDraft || '').trim().slice(0, 64)
    if (next === '' || next === folderScope) {
      setFolderRenameOpen(false)
      return
    }
    setFolderBusy(true)
    try {
      await rewriteFolder(folderScope, next)
      if (!aliveRef.current) return
      renameFolderOrder(folderScope, next)
      setExtraFolders((current) => current.map((entry) => (entry === folderScope ? next : entry)))
      setFolderRenameOpen(false)
      setFolderScope(next)
      notify(t('scriptsFolderRenamed'))
      await loadScripts(selectedName, { openDraft: true, scope: next })
    } catch (error) {
      notify(fmt(t, 'scriptsFolderFailed', { message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setFolderBusy(false)
    }
  }

  const deleteFolder = async () => {
    if (!folderScope) return
    setFolderBusy(true)
    try {
      await rewriteFolder(folderScope, '')
      if (!aliveRef.current) return
      forgetFolder(folderScope)
      setExtraFolders((current) => current.filter((entry) => entry !== folderScope))
      setFolderConfirm(false)
      setFolderScope('')
      notify(t('scriptsFolderDeleted'))
      await loadScripts(selectedName, { openDraft: true, scope: '' })
    } catch (error) {
      notify(fmt(t, 'scriptsFolderFailed', { message: errorMessage(error) }))
    } finally {
      if (aliveRef.current) setFolderBusy(false)
    }
  }

  const openCount = openSessions.length

  /**
   * One-line run status for the panel (the full log is in the results window).
   *
   * @returns the localized summary line.
   */
  const resultSummary = () => {
    if (running) return fmt(t, 'scriptsResultRunning', { steps: lines.length })
    if (lines.length === 0 && !runs) return t('scriptsProgressEmpty')
    const parts = [fmt(t, 'scriptsResultDone', { steps: lines.length })]
    if (runs) {
      if (runs.timedOut) parts.push(t('scriptsRunTimedOut'))
      parts.push(fmt(t, 'scriptsRunSummary', {
        runs: runs.runs.length,
        ok: runs.runs.filter((run) => run.ok).length,
      }))
    }
    return parts.filter(Boolean).join(' · ')
  }

  const folderLabel = folderScope || t('scriptsUngrouped')
  const selectedMeta = script
    ? [script.description || null, fmt(t, 'scriptsSteps', { count: script.stepCount }), fmt(t, 'scriptsParamsCount', { count: script.paramCount })]
      .filter(Boolean)
      .join(' · ')
    : ''

  return (
    <Sheet title={t('scriptsTitle')} onBack={onClose} backLabel={t('scriptsPanelClose')}>
      {/* Folder scope + folder management. */}
      <div style={S.folderBar}>
        <span style={S.label}>{t('scriptsFolder')}</span>
        <select
          style={{ ...S.select, flex: '1 1 120px', width: 'auto' }}
          value={folderScope}
          aria-label={t('scriptsFolderScope')}
          disabled={folderBusy}
          onChange={(event) => chooseFolder(event.target.value)}
        >
          <option value="">{t('scriptsUngrouped')}</option>
          {folders.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <Btn
          style={S.rowBtnSmall}
          onClick={() => { setFolderAddOpen(true); setFolderRenameOpen(false); setFolderConfirm(false) }}
          disabled={folderBusy}
        >
          {t('scriptsFolderAdd')}
        </Btn>
        <Btn
          style={S.rowBtnSmall}
          onClick={() => { setFolderRenameOpen(true); setFolderRenameDraft(folderScope); setFolderAddOpen(false); setFolderConfirm(false) }}
          disabled={!folderScope || folderBusy}
        >
          {t('scriptsFolderRename')}
        </Btn>
        <Btn
          style={S.rowBtnSmall}
          variant="danger"
          onClick={() => { setFolderConfirm(true); setFolderRenameOpen(false); setFolderAddOpen(false) }}
          disabled={!folderScope || folderBusy}
        >
          {t('scriptsFolderDelete')}
        </Btn>
      </div>

      {folderAddOpen ? (
        <div style={S.actionRow}>
          <input
            style={{ ...S.input, width: 150 }}
            value={folderAddName}
            aria-label={t('scriptsFolderNew')}
            placeholder={t('scriptsFolderNew')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFolderAddName(event.target.value)}
            onKeyDown={(event) => {
              if (event && event.key === 'Enter') addFolder()
              if (event && event.key === 'Escape') {
                event.stopPropagation()
                setFolderAddOpen(false)
              }
            }}
          />
          <Btn variant="primary" onClick={addFolder} disabled={String(folderAddName).trim() === ''}>
            {t('scriptsFolderUse')}
          </Btn>
          <Btn onClick={() => setFolderAddOpen(false)}>{t('cancel')}</Btn>
        </div>
      ) : null}

      {folderRenameOpen ? (
        <div style={S.actionRow}>
          <input
            style={{ ...S.input, width: 150 }}
            value={folderRenameDraft}
            aria-label={t('scriptsFolderRename')}
            placeholder={t('scriptsFolderNew')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFolderRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event && event.key === 'Enter') renameFolder()
              if (event && event.key === 'Escape') {
                event.stopPropagation()
                setFolderRenameOpen(false)
              }
            }}
          />
          <Btn variant="primary" onClick={renameFolder} disabled={folderBusy}>
            {t('scriptsFolderUse')}
          </Btn>
          <Btn onClick={() => setFolderRenameOpen(false)}>{t('cancel')}</Btn>
        </div>
      ) : null}

      {folderConfirm ? (
        <InlineConfirm
          message={fmt(t, 'scriptsFolderDeletePrompt', { name: folderScope })}
          confirmLabel={t('scriptsFolderDelete')}
          cancelLabel={t('cancel')}
          busy={folderBusy}
          onConfirm={deleteFolder}
          onCancel={() => setFolderConfirm(false)}
        />
      ) : null}

      {/* Master (left) / detail (right). */}
      <div style={S.scriptSplit}>
        <div style={S.scriptListCol}>
          <div style={S.scriptListScroll} role="listbox" aria-label={t('scriptsTitle')}>
            {listState === 'loading' ? <div style={S.auditEmpty}>{t('scriptsLoading')}</div> : null}
            {listState === 'error' ? (
              <div style={{ ...S.formError, margin: 6 }} role="alert">
                {fmt(t, 'scriptsListFailed', { message: listError || '' })}
              </div>
            ) : null}
            {listState === 'empty' ? (
              <div style={S.auditEmpty}>
                {t('scriptsEmpty')}
                <span style={{ display: 'block', fontSize: 11 }}>{t('scriptsEmptyHint')}</span>
              </div>
            ) : null}
            {listState !== 'loading' && scripts.length > 0 && orderedScripts.length === 0 ? (
              <div style={S.auditEmpty}>{t('scriptsFolderEmpty')}</div>
            ) : null}
            {orderedScripts.map((entry) => {
              const active = entry.name === selectedName
              return (
                <button
                  key={entry.name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-label={entry.name}
                  title={entry.description || entry.name}
                  style={{ ...S.listRow, ...(active ? S.scriptRowActive : null) }}
                  onClick={() => chooseScript(entry.name)}
                >
                  <span style={S.listRowTitle}>{entry.name}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <span style={S.dialectTag}>
                      {dialectOf(entry.name) === 'macro' ? t('scriptsModeMacro') : t('scriptsModeJson')}
                    </span>
                    <span style={S.listRowMeta}>{fmt(t, 'scriptsSteps', { count: entry.stepCount })}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div style={{ ...S.scriptListButtons, position: 'relative' }}>
            {newChoice ? (
              <div style={S.newChoicePop} role="menu" aria-label={t('scriptsNewType')}>
                <Btn
                  style={S.newChoiceOption}
                  onClick={() => { setNewChoice(false); startNew('macro') }}
                  disabled={saving || draftLoading}
                >
                  {t('scriptsModeMacro')}
                </Btn>
                <Btn
                  style={S.newChoiceOption}
                  onClick={() => { setNewChoice(false); startNew('json') }}
                  disabled={saving || draftLoading}
                >
                  {t('scriptsModeJson')}
                </Btn>
              </div>
            ) : null}
            <Btn
              style={S.rowBtnSmall}
              title={t('scriptsNewAction')}
              aria-expanded={newChoice}
              onClick={() => setNewChoice((open) => !open)}
              disabled={saving || draftLoading}
            >
              {`+ ${t('scriptsNewAction')}`}
            </Btn>
            <Btn
              style={S.rowBtnSmall}
              variant="danger"
              title={t('scriptsDelete')}
              onClick={startDelete}
              disabled={!script || running || deleting}
              busy={deleting}
            >
              {`− ${t('scriptsDelete')}`}
            </Btn>
            <Btn style={S.rowBtnSmall} title={t('scriptsMoveUp')} onClick={() => moveSelected(-1)} disabled={!canMoveUp}>
              ▲
            </Btn>
            <Btn style={S.rowBtnSmall} title={t('scriptsMoveDown')} onClick={() => moveSelected(1)} disabled={!canMoveDown}>
              ▼
            </Btn>
            <Btn style={S.rowBtnSmall} title={t('scriptsCopy')} onClick={duplicateScript} disabled={!script || saving}>
              {t('scriptsCopy')}
            </Btn>
          </div>
        </div>

        <div style={S.scriptEditCol}>
          {draftError ? <div style={S.formError} role="alert">{draftError}</div> : null}
          {draftLoading && !draft ? <span style={S.hint}>{t('scriptsLoadingEditor')}</span> : null}
          {draft ? (
            <>
              <Field label={t('scriptsName')} hint={t('scriptsNameHint')}>
                <input
                  style={S.input}
                  value={draft.meta.name}
                  aria-label={t('scriptsName')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  onChange={(event) => updateMeta({ name: event.target.value })}
                />
              </Field>

              <div style={S.actionRow}>
                <span style={S.label}>{t('scriptsFolder')}</span>
                <select
                  style={{ ...S.select, flex: '1 1 110px', width: 'auto' }}
                  value={draft.meta.folder}
                  aria-label={t('scriptsFolder')}
                  disabled={saving}
                  onChange={(event) => updateMeta({ folder: event.target.value })}
                >
                  <option value="">{t('scriptsUngrouped')}</option>
                  {folders.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                  {draft.meta.folder && !folders.includes(draft.meta.folder) ? (
                    <option value={draft.meta.folder}>{draft.meta.folder}</option>
                  ) : null}
                </select>
              </div>

              {/* The dialect is a property of the script, not a switch: a script
                  created as 逐行命令 stays commands, a 高级脚本 stays JSON. */}
              <div style={S.actionRow}>
                <span style={S.label}>{t('scriptsMode')}</span>
                <span style={S.dialectTag}>
                  {draft.mode === 'macro' ? t('scriptsModeMacro') : t('scriptsModeJson')}
                </span>
                <span style={S.hint}>
                  {draft.mode === 'macro' ? t('scriptsMacroHint') : t('scriptsJsonHint')}
                </span>
              </div>

              {draft.mode === 'macro' ? <span style={S.hint}>{t('scriptsMacroHelp')}</span> : null}

              <div style={S.templateRow}>
                <span style={S.label}>{t('scriptsTemplate')}</span>
                <select
                  style={{ ...S.select, flex: '1 1 120px', width: 'auto' }}
                  value=""
                  aria-label={t('scriptsTemplate')}
                  disabled={saving}
                  onChange={(event) => applyTemplate(event.target.value)}
                >
                  <option value="">{t('scriptsTemplatePlaceholder')}</option>
                  {(draft.mode === 'macro' ? MACRO_TEMPLATES : STEP_TEMPLATES).map((template) => (
                    <option key={template.id} value={template.id}>{t(template.labelKey)}</option>
                  ))}
                </select>
              </div>

              <div style={{ ...S.field, ...S.editorGrow }}>
                <span style={S.label}>
                  {draft.mode === 'macro' ? t('scriptsModeMacro') : t('scriptsSave')}
                </span>
                <textarea
                  style={{ ...S.textarea, ...S.editorBody }}
                  value={draft.text}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    updateDraft({ text: event.target.value })
                    if (emptyConfirm) setEmptyConfirm(false)
                    if (editError) setEditError(null)
                  }}
                  disabled={saving}
                />
              </div>
              {editorNotice ? <span style={S.hint}>{editorNotice}</span> : null}
              {editError ? (
                <div style={{ ...S.formError, whiteSpace: 'pre-wrap' }} role="alert">{editError}</div>
              ) : null}
              <div style={S.actionRow}>
                <Btn variant="primary" onClick={saveScript} busy={saving} disabled={saving}>
                  {emptyConfirm ? t('scriptsEmptySaveConfirm') : t('scriptsSaveAction')}
                </Btn>
                <Btn onClick={cancelDraft} disabled={saving}>
                  {t('scriptsCancel')}
                </Btn>
              </div>
            </>
          ) : !draftLoading ? (
            <div style={S.stateWrap}>
              <p style={S.stateDetail}>{t('scriptsEditorEmpty')}</p>
            </div>
          ) : null}
        </div>
      </div>

      {confirmDelete ? (
        <InlineConfirm
          message={fmt(t, 'scriptsDeletePrompt', { name: script ? script.name : '' })}
          confirmLabel={t('scriptsDeleteConfirm')}
          cancelLabel={t('cancel')}
          busy={deleting}
          onConfirm={deleteScript}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}

      {/* Run controls live outside the editor, below the split. */}
      {script ? (
        <div style={S.runSection}>
          <div style={S.actionRow}>
            <span style={S.sectionTitle}>{t('scriptsTarget')}</span>
            <Segmented
              label={t('scriptsTarget')}
              value={targetMode}
              disabled={running}
              options={[
                { value: 'current', label: t('scriptsTargetCurrent'), hint: t('scriptsTargetCurrent') },
                { value: 'selected', label: t('scriptsTargetPicked'), hint: t('scriptsTargetPickedHint') },
                { value: 'all', label: t('scriptsTargetAll'), hint: fmt(t, 'scriptsTargetAllHint', { count: openCount }) },
              ]}
              onChange={setTargetMode}
            />
            <span style={S.hint}>
              {targetMode === 'all'
                ? fmt(t, 'scriptsTargetAllHint', { count: openCount })
                : targetMode === 'selected'
                  ? fmt(t, 'scriptsTargetPickedHint', { count: pickedOpen.length })
                  : (sessionId || '—')}
            </span>
          </div>

          {targetMode === 'selected' ? (
            <div style={S.pickList} role="group" aria-label={t('scriptsTargetPicked')}>
              {openCount === 0 ? (
                <span style={S.hint}>{t('scriptsTargetNoSessions')}</span>
              ) : (
                openSessions.map((session) => {
                  const checked = pickedOpen.includes(session.id)
                  return (
                    <label key={session.id} style={S.pickRow}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={running}
                        onChange={() => togglePicked(session.id)}
                        style={S.pickBox}
                      />
                      <span style={S.pickTitle}>{session.title}</span>
                      <span style={S.pickMeta}>{sessionAddress(session)}</span>
                    </label>
                  )
                })
              )}
            </div>
          ) : null}

          {script.paramCount > 0 ? (
            <div style={S.actionRow}>
              <span style={S.sectionTitle}>{t('scriptsParams')}</span>
              {Object.entries(script.params).map(([name, definition]) => (
                <Field
                  key={name}
                  label={name}
                  hint={definition && definition.description ? definition.description : undefined}
                >
                  <input
                    style={S.input}
                    value={paramValues[name] === undefined ? '' : paramValues[name]}
                    placeholder={definition && definition.default ? definition.default : ''}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const next = { ...paramValues, [name]: event.target.value }
                      setParamValues(next)
                    }}
                    onKeyDown={(event) => {
                      if (event && event.key === 'Enter') runScript()
                    }}
                    disabled={running}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <span style={S.hint}>{t('scriptsNoParams')}</span>
          )}

          <div style={S.actionRow}>
            <Btn variant="primary" onClick={runScript} disabled={running || !script}>
              {running ? t('scriptsRunning') : t('scriptsRun')}
            </Btn>
            <span style={{ ...S.resultSummary, flex: '1 1 140px' }}>{resultSummary()}</span>
            <Btn onClick={() => setResultsOpen(true)} title={t('scriptsResultTitle')}>
              {t('scriptsViewResult')}
            </Btn>
          </div>

          {runError ? <div style={S.formError} role="alert">{runError}</div> : null}
          {batch.state === 'done' && !runError && batch.error ? (
            <div style={S.formError} role="alert">
              {fmt(t, 'scriptsRunFailed', { message: batch.error })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Results: a floating window above the panel, never in the document flow. */}
      {resultsOpen ? (
        <OverlayWindow
          title={t('scriptsResultTitle')}
          closeLabel={t('scriptsResultClose')}
          onClose={() => setResultsOpen(false)}
        >
          <div ref={progressRef} style={S.resultBox} role="log" aria-label={t('scriptsRun')}>
            {lines.length === 0
              ? <div style={S.auditEmpty}>{t('scriptsProgressEmpty')}</div>
              : lines.map((line) => <ProgressRow key={line.key} line={line} t={t} />)}
          </div>
        </OverlayWindow>
      ) : null}
    </Sheet>
  )
}
