/**
 * Line-based macro syntax for saved scripts.
 *
 * The JSON step format is precise but hostile to authoring: nested arrays,
 * quoted keys, and a `send`/`enter`/`waitFor` shape to remember for every line.
 * This module offers the format people actually type — **one command per line** —
 * and compiles it to the same `ScriptStep[]` the Host already accepts, so the
 * stored format never changes and the Host needs no new code.
 *
 * Syntax:
 *
 * ```
 * # comment (whole line; ignored)
 * ls -l                       a plain line is sent, followed by Enter
 * @raw echo without newline   send without Enter
 * @wait 500                   pause 500 ms   (`0.5s` / `2s` / bare ms all work)
 * @set name = value           define a variable ({{name}} works everywhere)
 * @log something              write a line to the run log
 * @expect pattern             require the output to match (regex)
 * @expect continue pattern    same, but a mismatch does not stop the script
 * @python ... @end            send a Python heredoc to the remote shell
 * ```
 *
 * `@python` is sugar: it emits `{ send: "python3 - <<'PY'" }`, one `{ send }` per
 * body line, and `{ send: "PY" }`. Python therefore runs **on the remote host**
 * (through the terminal), never inside the Harness Host process — the script
 * format stays pure data.
 *
 * Structured steps (`if` / `loop`) have no macro spelling: {@link serializeMacro}
 * reports them as unsupported and the panel keeps such scripts in JSON mode.
 */

/** Directives recognised at the start of a line. */
const DIRECTIVES = new Set(['raw', 'wait', 'set', 'log', 'expect', 'python', 'end'])

/**
 * Parse a duration: bare numbers are milliseconds, `s`/`ms` suffixes are honoured.
 *
 * @param text - raw token, e.g. `500`, `0.5s`, `250ms`.
 * @returns milliseconds, or null when unparsable.
 */
function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(String(text || '').trim())
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0) return null
  const unit = (match[2] || 'ms').toLowerCase()
  return Math.round(unit === 's' ? value * 1000 : value)
}

/**
 * Compile macro text into script steps.
 *
 * @param text - macro source.
 * @param options - `{ waitAfterSend?: boolean, idleMs?: number, timeoutMs?: number }`;
 *   `waitAfterSend` adds a `waitFor` to each `send` so a script that types
 *   commands in a row behaves like a human (wait for the prompt) instead of
 *   firing every line into the pty at once.
 * @returns {{ ok: true, steps: object[] } | { ok: false, line: number, message: string }} result.
 */
export function parseMacro(text, options = {}) {
  const waitAfterSend = options.waitAfterSend === true
  const idleMs = Number.isInteger(options.idleMs) ? options.idleMs : 250
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 15000

  /** @type {object[]} */
  const steps = []
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  /** @type {{ indent: string, body: string[] } | null} */
  let python = null

  /** Build a send step, honouring the "wait for the command to finish" toggle. */
  const sendStep = (payload, enter) => {
    /** @type {Record<string, unknown>} */
    const step = { send: payload, enter }
    if (waitAfterSend && enter) step.waitFor = { idleMs, timeoutMs }
    return step
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    const lineNumber = index + 1

    // Inside a @python block everything is literal payload until @end.
    if (python !== null) {
      if (trimmed === '@end') {
        // Close the heredoc. Body lines were emitted as they were read.
        steps.push({ send: 'PY', enter: true })
        python = null
        continue
      }
      if (trimmed.length > 0) steps.push({ send: raw, enter: true })
      continue
    }

    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue

    if (!trimmed.startsWith('@')) {
      steps.push(sendStep(trimmed, true))
      continue
    }

    const match = /^@([a-zA-Z]+)\s*([\s\S]*)$/.exec(trimmed)
    const name = match ? match[1].toLowerCase() : ''
    const rest = match ? match[2].trim() : ''
    if (!DIRECTIVES.has(name)) {
      return { ok: false, line: lineNumber, message: `unknown directive @${name || '?'}` }
    }

    if (name === 'python') {
      // `python3 - <<'PY'` opens a heredoc; each body line is one send and
      // `@end` writes the closing delimiter. Python therefore runs on the
      // remote shell — the Harness never executes it.
      steps.push({ send: "python3 - <<'PY'", enter: true })
      python = { opened: true }
      continue
    }
    if (name === 'end') {
      return { ok: false, line: lineNumber, message: '@end without @python' }
    }
    if (name === 'raw') {
      if (rest.length === 0) return { ok: false, line: lineNumber, message: '@raw needs text' }
      steps.push({ send: rest, enter: false })
      continue
    }
    if (name === 'wait') {
      const ms = parseDuration(rest)
      if (ms === null) return { ok: false, line: lineNumber, message: '@wait needs a duration, e.g. @wait 500 or @wait 2s' }
      steps.push({ delay: ms })
      continue
    }
    if (name === 'set') {
      const assignment = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:=|\s)\s*([\s\S]*)$/.exec(rest)
      if (!assignment) return { ok: false, line: lineNumber, message: '@set needs "name = value"' }
      steps.push({ set: assignment[1], value: assignment[2].trim() })
      continue
    }
    if (name === 'log') {
      if (rest.length === 0) return { ok: false, line: lineNumber, message: '@log needs text' }
      steps.push({ log: rest })
      continue
    }
    // @expect [continue] pattern
    const expectMatch = /^(continue\s+)?([\s\S]+)$/.exec(rest)
    if (!expectMatch || expectMatch[2].trim().length === 0) {
      return { ok: false, line: lineNumber, message: '@expect needs a pattern' }
    }
    steps.push({
      expect: { match: expectMatch[2].trim() },
      onFail: expectMatch[1] ? 'continue' : 'stop',
    })
  }

  if (python !== null) {
    return { ok: false, line: lines.length, message: '@python block is missing @end' }
  }
  if (steps.length === 0) {
    return { ok: false, line: 1, message: 'the script has no steps' }
  }
  return { ok: true, steps }
}

/**
 * Render steps back into macro text.
 *
 * Best effort: the editor uses it to show an existing script in the friendly
 * format. Steps the macro syntax cannot express (`if` / `loop` / per-step
 * `waitFor` variants) make it report `unsupported` so the panel falls back to
 * JSON instead of silently dropping them.
 *
 * @param steps - normalized script steps.
 * @returns {{ ok: true, text: string, waitAfterSend: boolean } | { ok: false, reason: string }} result.
 */
export function serializeMacro(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'empty' }
  const lines = []
  /** @type {string | null} */
  let waitSignature = null
  let allSendWait = true

  for (const step of steps) {
    if (step === null || typeof step !== 'object') return { ok: false, reason: 'invalid' }
    if (typeof step.send === 'string') {
      const waitFor = step.waitFor
      if (waitFor === undefined) allSendWait = false
      else {
        const signature = `${waitFor.idleMs === undefined ? '' : waitFor.idleMs}/${waitFor.timeoutMs === undefined ? '' : waitFor.timeoutMs}`
        if (waitSignature === null) waitSignature = signature
        else if (waitSignature !== signature) return { ok: false, reason: 'mixedWait' }
      }
      if (step.read !== undefined && step.read !== 'delta') return { ok: false, reason: 'read' }
      if (step.capture !== undefined) return { ok: false, reason: 'capture' }
      lines.push(step.enter === false ? `@raw ${step.send}` : step.send)
      continue
    }
    if (Number.isInteger(step.delay)) {
      lines.push(`@wait ${step.delay}`)
      continue
    }
    if (typeof step.set === 'string') {
      lines.push(`@set ${step.set} = ${step.value === undefined ? '' : step.value}`)
      continue
    }
    if (typeof step.log === 'string') {
      lines.push(`@log ${step.log}`)
      continue
    }
    if (step.expect !== undefined) {
      if (typeof step.expect.match !== 'string') return { ok: false, reason: 'condition' }
      if (step.capture !== undefined) return { ok: false, reason: 'capture' }
      lines.push(`@expect ${step.onFail === 'continue' ? 'continue ' : ''}${step.expect.match}`)
      continue
    }
    // `if` / `loop` / anything else: JSON mode only.
    return { ok: false, reason: 'structured' }
  }

  const waitAfterSend = allSendWait && waitSignature !== null
  return { ok: true, text: lines.join('\n'), waitAfterSend }
}

/**
 * Macro-flavoured templates for the 模板 dropdown.
 *
 * The JSON skeletons in `scriptLang.js` carry `send`/`waitFor` objects, which are
 * noise in the per-line editor; these insert the line syntax instead. The
 * dropdown shows one set or the other depending on the script's dialect.
 */
export const MACRO_TEMPLATES = [
  { id: 'cmd', labelKey: 'scriptsTemplateCmd', lines: ['uname -a'] },
  { id: 'wait', labelKey: 'scriptsTemplateWait', lines: ['@wait 500'] },
  { id: 'set', labelKey: 'scriptsTemplateSet', lines: ['@set name = value'] },
  { id: 'log', labelKey: 'scriptsTemplateLog', lines: ['@log 说明'] },
  { id: 'expect', labelKey: 'scriptsTemplateExpect', lines: ['@expect ready'] },
  { id: 'python', labelKey: 'scriptsTemplatePython', lines: null },
]

/**
 * Append one macro template to the editor text.
 *
 * @param text - current macro source.
 * @param templateId - id from {@link MACRO_TEMPLATES}.
 * @returns the new source, or null when the id is unknown.
 */
export function insertMacroTemplate(text, templateId) {
  const template = MACRO_TEMPLATES.find((entry) => entry.id === templateId)
  if (!template) return null
  const lines = template.lines === null ? PYTHON_TEMPLATE.trimEnd().split('\n') : template.lines
  const base = typeof text === 'string' ? text : ''
  const head = base.length === 0 || base.endsWith('\n') ? base : base + '\n'
  return head + lines.join('\n') + '\n'
}

/** Python template body, shown by the 模板 dropdown in macro mode. */
export const PYTHON_TEMPLATE = [
  '# 用远端 shell 里的 python3 跑一段逻辑（脚本本身仍是纯数据）',
  'hostname',
  '@python',
  'import socket, os',
  'print("host:", socket.gethostname())',
  'print("cwd :", os.getcwd())',
  '@end',
  '@wait 500',
  '',
].join('\n')
