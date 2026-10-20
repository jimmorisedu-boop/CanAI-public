import assert from 'node:assert/strict'
import test from 'node:test'
import { planRefPick } from './assistantRefPick'
import type { SelectionRef } from './konva/selection'

// Клик по миниатюре в ленте помощника возвращает объект в работу (просьба
// 20.08.2026). Отдельного «добавить в референсы» не нужно: чипы промпт-бара —
// зеркало выделения канваса, поэтому достаточно выделить.

const ref = (patch: Partial<SelectionRef> = {}): SelectionRef => ({
  shapeId: 'item-1',
  kind: 'image',
  label: 'портрет.png',
  src: '/media/a.png',
  ...patch,
} as SelectionRef)

test('объект на доске — просто выделяем его', () => {
  const action = planRefPick(ref(), { onBoard: true, additive: false, selected: ['item-9'] })
  assert.deepEqual(action, { kind: 'select', ids: ['item-1'] })
})

test('с Ctrl добавляем к выделению, а повторный клик снимает', () => {
  // Тот же жест, что и на самом холсте: третьего поведения не заводим.
  const added = planRefPick(ref(), { onBoard: true, additive: true, selected: ['item-9'] })
  assert.deepEqual(added, { kind: 'select', ids: ['item-9', 'item-1'] })

  const removed = planRefPick(ref(), { onBoard: true, additive: true, selected: ['item-9', 'item-1'] })
  assert.deepEqual(removed, { kind: 'select', ids: ['item-9'] })
})

test('объекта на доске нет — референс всё равно даём, по ссылке', () => {
  // Его могли удалить или заархивировать. Человек кликнул по картинке,
  // которую видит, и обязан получить её в референсах.
  const action = planRefPick(ref(), { onBoard: false, additive: false, selected: [] })
  assert.deepEqual(action, { kind: 'manual', ref: ref() })
})

test('нет ни объекта, ни ссылки — молчим, а не выдумываем референс', () => {
  const action = planRefPick(
    ref({ src: undefined, text: undefined }),
    { onBoard: false, additive: false, selected: [] },
  )
  assert.deepEqual(action, { kind: 'none' })
})
