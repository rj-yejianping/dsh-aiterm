/**
 * System-prompt guidance for the `aiterm_*` tools.
 *
 * Registered once the `systemPrompt` service exists, at the terminal-tool order
 * so it sits next to the other terminal guidance. Kept short: it ships with
 * every request, so it is registered only in `full` mode. `progressive` mode
 * folds the same rules into the always-resident `aiterm_discover` description
 * (`DISCOVER_TOOL_DESCRIPTION` in `./tools.js`): a separate section there would
 * duplicate guidance the model already receives with the tool schema.
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
 * Register the prompt section once the systemPrompt service exists.
 * @param {any} ctx plugin context.
 * @returns {void}
 */
export function registerPrompt(ctx) {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: promptCtx.systemPrompt.getSectionOrder('TOOL_PTY'),
          text: PROMPT_TEXT,
        }),
      'aiterm: prompt section',
    )
  })
}
