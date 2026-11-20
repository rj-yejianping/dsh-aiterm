/**
 * Keyboard-focus ring decision for the hand-written controls.
 *
 * The ring exists for keyboard navigation only. `:focus-visible` is the first
 * gate, but it is not enough on its own:
 *
 * - a chip paints the ring on its *wrapper*, while `:focus-visible` is matched
 *   on the inner `<button>`; the Host's
 *   `html[data-input-modality='pointer'] ... :focus-visible` suppression writes
 *   `--dsw-focus-ring-color: transparent` on the focused element itself, so it
 *   never reaches the ancestor that draws the box;
 * - browsers disagree about a pointer press (a button focused during a click is
 *   reported as `:focus-visible` by some Safari / Chromium builds).
 *
 * The Host publishes `data-input-modality` on `<html>`: `pointer` after every
 * pointer press, `keyboard` after Tab / Home / End / PageUp / PageDown / arrow
 * navigation. Requiring the keyboard modality means a mouse click can never
 * leave a white box behind on a tab.
 *
 * @param matchesFocusVisible - result of `element.matches(':focus-visible')`.
 * @param modality - `document.documentElement.dataset.inputModality`, if any.
 * @returns whether the ring should be painted.
 */
export function focusRingVisible(matchesFocusVisible, modality) {
  return matchesFocusVisible === true && modality !== 'pointer'
}
