/**
 * System-prompt guidance for the `aiterm_*` tools.
 *
 * Registered once the `systemPrompt` service exists, at the terminal-tool order
 * so it sits next to the other terminal guidance. Kept short: it ships with
 * every request. The text follows the configured disclosure mode: full keeps
 * the historical guidance, progressive explains discovery and the next-step
 * rule without naming any tool that another restriction may hide.
 */

/** Stable prompt section name. */
export const PROMPT_SECTION_NAME = 'tool:aiterm'

/** Guidance text shown to the model in `full` mode. */
export const PROMPT_TEXT = [
  'SSH/Telnet sessions opened in the user\'s SSH/Telnet panel are shared with the user: `aiterm_list` shows them with their connection state and the AI permission the user granted.',
  'Each session has its own AI permission: read-only (只读) lets you read output but never send input; write-only (只写) lets you send input but never read output; read-write (读写) allows both. Only the user can change it — a refusal is a policy decision, so report it instead of retrying or working around it.',
  'While you send input, you hold control of the session and the user\'s typing is blocked until you go idle or call `aiterm_release_control`; call it as soon as you finish a multi-step operation so the user can type again.',
  'If the user takes over control, your writes are refused until they release it. Use `aiterm_status` to see the current owner and `aiterm_read`/`aiterm_screenshot` to inspect the screen before acting.',
  'Prefer reading the screen before and after a command, send a newline with a trailing "\\r" (or enter:true), and never assume a command finished without checking its output.',
].join(' ')

/**
 * Guidance text shown to the model in `progressive` mode.
 *
 * Only the always-resident discovery entry is named: naming any other tool
 * could disclose one that another restriction hides from this Agent.
 */
export const PROGRESSIVE_PROMPT_TEXT = [
  'SSH/Telnet tools are disclosed progressively. Only the discovery entry `aiterm_discover` is available at first: call it with no arguments to list the available groups (session, history, automation, management), the tools this Agent may see, and the groups already expanded; call it again with one group to expand it.',
  'Expansion affects the next model step only: a tool expanded during this step is not callable until the next step, so expand first and call the tool afterwards.',
  'Expansion never grants permission. Each session keeps its own AI permission: read-only (只读) lets you read output but never send input; write-only (只写) lets you send input but never read output; read-write (读写) allows both. Only the user can change it — a refusal is a policy decision, so report it instead of retrying or working around it.',
  'Start with the session group and list sessions: the other groups need an existing session id. While you send input, you hold control of the session and the user\'s typing is blocked until you go idle or use the release-control tool; call it as soon as you finish a multi-step operation so the user can type again.',
  'If the user takes over control, your writes are refused until they release it. Use the status tool to see the current owner and the read/screen tools to inspect the screen before acting.',
  'Prefer reading the screen before and after a command, send a newline with a trailing "\\r" (or enter:true), and never assume a command finished without checking its output.',
].join(' ')

/**
 * Register the prompt section once the systemPrompt service exists.
 * @param {any} ctx plugin context.
 * @param {unknown} [toolDisclosure] configured `toolDisclosure` value; only the
 *   exact `progressive` string selects the progressive guidance.
 * @returns {void}
 */
export function registerPrompt(ctx, toolDisclosure) {
  const text = toolDisclosure === 'progressive' ? PROGRESSIVE_PROMPT_TEXT : PROMPT_TEXT
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: promptCtx.systemPrompt.getSectionOrder('TOOL_PTY'),
          text,
        }),
      'aiterm: prompt section',
    )
  })
}
