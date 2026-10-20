import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canvasOwnsCopy } from './canvasCopyOwnership.js'

test('выделенный текст ответа помощника копируется браузером, а не холстом', () => {
  assert.equal(canvasOwnsCopy({ selectedCanvasItems: 1, selectedText: 'prompt text' }), false)
})

test('без выделенного текста Ctrl+C копирует выбранные объекты холста', () => {
  assert.equal(canvasOwnsCopy({ selectedCanvasItems: 1, selectedText: '' }), true)
  assert.equal(canvasOwnsCopy({ selectedCanvasItems: 0, selectedText: '' }), false)
})

test('контекстное меню оставляет одно действие копирования', () => {
  const menu = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(menu, /Копировать картинку/u)
})
