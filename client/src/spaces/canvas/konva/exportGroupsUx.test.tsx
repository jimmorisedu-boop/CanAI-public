import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportButton } from './ExportButton.js'

const selectionToolbarSource = readFileSync(
  new URL('./SelectionToolbar.tsx', import.meta.url),
  'utf8',
)
const exportButtonSource = readFileSync(
  new URL('./ExportButton.tsx', import.meta.url),
  'utf8',
)
const shortcutsSource = readFileSync(
  // справка строится из реестра — проверяем ЕГО, а не разметку модалки
  new URL('../../../ui/hotkeys.ts', import.meta.url),
  'utf8',
)

test('группы назначаются только горячими клавишами', () => {
  assert.doesNotMatch(selectionToolbarSource, /window\.prompt|>\s*Группа\s*</)
  assert.doesNotMatch(exportButtonSource, /setMarks|Новая группа из выделения/)
})

test('экспорт кратко объясняет горячие клавиши', () => {
  const html = renderToStaticMarkup(<ExportButton items={[]} project={{ source: 'local', id: 'доска-1' }} />)
  assert.match(html, /role="tooltip"/)
  assert.match(html, /aria-describedby=/)
  assert.match(html, /1–999/)
  assert.match(html, /0 removes the label/)
  assert.doesNotMatch(html, /title="/)
})

test('справка показывает полный диапазон групп', () => {
  assert.match(shortcutsSource, /Numbers 1–999/)
  assert.match(shortcutsSource, /0 removes the marker/)
})
