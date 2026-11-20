/**
 * The rail chip's keyboard focus ring must never paint for a pointer press.
 *
 * Regression (user report): after switching sessions the tab that was selected
 * before kept a white box. The chip paints its ring on the wrapper, which is not
 * the element the Host's pointer-modality suppression reaches, and some browsers
 * report `:focus-visible` for a button focused during a click. The ring decision
 * therefore requires both the `:focus-visible` match and a non-pointer input
 * modality, and `useFocusRing` additionally clears on any pointer press.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { focusRingVisible } from '../client/focus.js'

test('a pointer press never paints the ring, even when the browser says focus-visible', () => {
  assert.equal(focusRingVisible(true, 'pointer'), false)
})

test('keyboard navigation paints the ring', () => {
  assert.equal(focusRingVisible(true, 'keyboard'), true)
})

test('a modality the Host has not published yet falls back to focus-visible', () => {
  assert.equal(focusRingVisible(true, undefined), true)
  assert.equal(focusRingVisible(true, ''), true)
})

test('a focus that is not focus-visible never paints the ring', () => {
  assert.equal(focusRingVisible(false, 'keyboard'), false)
  assert.equal(focusRingVisible(false, undefined), false)
  assert.equal(focusRingVisible(undefined, 'keyboard'), false)
})
