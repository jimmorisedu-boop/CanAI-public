// @ts-nocheck — Node test globals are executed by tsx and are outside the browser tsconfig.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { SketchPalette } from './SketchPalette'

const motionCss = readFileSync(new URL('../../../styles/typography-motion.css', import.meta.url), 'utf8')

test('compact sketch toolbar exposes every essential action by name', () => {
  const html = renderToStaticMarkup(createElement(SketchPalette as any, {
    brush: { tool: 'draw', color: '#e0554e', size: 6 },
    onBrush: () => {},
    busy: false,
    canUndo: true,
    canRedo: false,
    onUndo: () => {},
    onRedo: () => {},
    onCancel: () => {},
    onDone: () => {},
  }))

  assert.match(html, /aria-label="Sketch tools"/)
  for (const label of [
    'Brush',
    'Eraser',
    'Undo stroke',
    'Redo stroke',
    'Cancel',
    'Apply',
  ]) {
    assert.match(html, new RegExp(`(?:aria-label|title)="${label}"`), label)
  }
  assert.doesNotMatch(html, /Готово \(Esc\)/)
})

test('sketch toolbar animation preserves horizontal centering', () => {
  assert.match(motionCss, /\.sketch-palette[\s\S]{0,120}animation:\s*palette-pop-in/)
  assert.match(motionCss, /@keyframes palette-pop-in[\s\S]{0,220}translateX\(-50%\)/)
})
