/**
 * xterm palette and container CSS for the embedded terminal.
 *
 * This is the one place allowed to use literal colors: a terminal needs a fixed
 * ANSI palette. The canvas background and foreground still adapt to the host
 * theme when readable `--dsw-alias-*` tokens resolve to concrete colors; the
 * literals remain the fallback.
 */

const PALETTE = {
  background: '#17191d',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#17191d',
  selectionBackground: 'rgba(77, 107, 254, 0.35)',
  black: '#1f2125',
  red: '#e5484d',
  green: '#2fbf71',
  yellow: '#d9a300',
  blue: '#4d8bff',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ff6b70',
  brightGreen: '#5ad68f',
  brightYellow: '#f0c040',
  brightBlue: '#7aa7ff',
  brightMagenta: '#e39ff6',
  brightCyan: '#7fd4de',
  brightWhite: '#ffffff',
}

const COLOR_PATTERN = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]*\)|hsla?\([^)]*\))$/i

/**
 * Read one theme token as a concrete color.
 *
 * @param name - CSS custom property name.
 * @returns the color, or undefined when it is not a concrete color.
 */
function readColorToken(name) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name)
    if (typeof raw !== 'string') return undefined
    const value = raw.trim()
    if (!value || value.includes('var(')) return undefined
    return COLOR_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the xterm theme, preferring the host surface colors when available.
 *
 * @returns a fresh theme object.
 */
export function buildTerminalTheme() {
  const theme = { ...PALETTE }
  const background = readColorToken('--dsw-alias-bg-layer-1') || readColorToken('--dsw-alias-bg-base')
  const foreground = readColorToken('--dsw-alias-label-primary')
  if (background) {
    theme.background = background
    theme.cursorAccent = background
  }
  if (foreground) {
    theme.foreground = foreground
    theme.cursor = foreground
  }
  return theme
}

/** Monospace stack for terminal cells. */
export const TERMINAL_FONT_FAMILY = 'Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, "Courier New", monospace'

/**
 * xterm terminal options for this panel.
 *
 * @param overrides - values that depend on the session (cols/rows, disableStdin).
 * @returns xterm Terminal options.
 */
export function terminalOptions(overrides) {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 1.18,
    scrollback: 4000,
    scrollSensitivity: 1.4,
    theme: buildTerminalTheme(),
    ...overrides,
  }
}

/**
 * CSS overrides applied inside the panel's own `<style>` element.
 *
 * The vendor stylesheet is bundled as text and rendered by the component, so no
 * style tag is ever appended to `document.head`.
 */
export const TERMINAL_CSS_OVERRIDES = `
.dsst-term-host {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.dsst-term-host .xterm {
  height: 100%;
  width: 100%;
}
.dsst-term-host .xterm .xterm-viewport {
  background-color: transparent !important;
  scrollbar-width: thin;
}
.dsst-term-host .xterm .xterm-viewport::-webkit-scrollbar {
  width: 6px;
}
.dsst-term-host .xterm .xterm-viewport::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2);
  border-radius: 3px;
}
.dsst-term-host .xterm .composition-view {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.dsst-term-host .xterm.xterm-focus .xterm-cursor-layer {
  opacity: 1;
}
`
