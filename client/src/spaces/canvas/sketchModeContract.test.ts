// @ts-nocheck — Node test globals are executed by tsx and are outside the browser tsconfig.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const canvasSpace = readFileSync(new URL('./CanvasSpace.tsx', import.meta.url), 'utf8')
const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')

test('Escape cancels sketch instead of applying it and typing fields keep the shortcut', () => {
  assert.doesNotMatch(canvasSpace, /if \(e\.key === 'Escape'\) void finishSketch\(\)/)
  assert.match(canvasSpace, /if \(e\.key === 'Escape'\)[\s\S]{0,160}cancelSketch\(\)/)
  assert.match(canvasSpace, /isTypingTarget\(e\.target\)/)
})

test('apply keeps the sketch open when no stroke intersects the target', () => {
  const finish = canvasSpace.match(/async function finishSketch[\s\S]*?\n  }/)?.[0] ?? ''
  assert.match(finish, /const (?:baked|saved) = await bakeSketchToNewImage/)
  assert.match(finish, /if \(!(?:baked|saved)\)/)
  assert.match(finish, /Draw at least one stroke|strokes.*selected picture/i)
})

test('clearing the prompt does not secretly close the sketch mode', () => {
  const clear = promptBar.match(/function handleClearAll\(\)[\s\S]*?\n  }/)?.[0] ?? ''
  const permanent = promptBar.match(/function handleClearAllPermanent[\s\S]*?\n  }/)?.[0] ?? ''
  assert.doesNotMatch(clear, /setSketchTarget\(null\)/)
  assert.doesNotMatch(permanent, /setSketchTarget\(null\)/)
})
