import assert from 'node:assert/strict'
import test from 'node:test'
import { macroShortLabel } from './macroShortLabel'

test('square macro slot shows at most five letters without a number', () => {
  assert.equal(macroShortLabel('Кожа лица'), 'Кожа')
  assert.equal(macroShortLabel('Нарезка видео'), 'Нарез')
  assert.equal(macroShortLabel('  рефайн   фото  '), 'рефай')
  assert.equal(macroShortLabel('Лицо'), 'Лицо')
})

test('technical default and symbol-only names keep a readable letter fallback', () => {
  assert.equal(macroShortLabel('Макрос 5'), 'Макро')
  assert.equal(macroShortLabel('123 ✨'), 'Macro')
})
