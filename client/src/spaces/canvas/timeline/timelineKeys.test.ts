import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchTimelineKey, type TimelineKeyContext } from './timelineKeys'

function hit(code: string, key: string, over: Partial<TimelineKeyContext> = {}) {
  return dispatchTimelineKey({ code, key, context: over })
}

test('буквы — физическим event.code (EN и RU одинаково)', () => {
  // EN
  assert.deepEqual(hit('KeyS', 's'), { kind: 'cut' })
  assert.deepEqual(hit('KeyC', 'c'), { kind: 'toggleDrop' })
  assert.deepEqual(hit('KeyI', 'i'), { kind: 'in' })
  assert.deepEqual(hit('KeyO', 'o'), { kind: 'out' })
  assert.deepEqual(hit('KeyF', 'f'), { kind: 'capture' })
  assert.deepEqual(hit('KeyR', 'r'), { kind: 'crop' })
  assert.deepEqual(hit('KeyA', 'a'), { kind: 'audio' })
  assert.deepEqual(hit('KeyB', 'b'), { kind: 'drawer' })
  assert.deepEqual(hit('KeyG', 'g'), { kind: 'showOnCanvas' })
  assert.deepEqual(hit('KeyD', 'd'), { kind: 'downloadFrame' })
  assert.deepEqual(hit('Digit0', '0'), { kind: 'fit' })
  // RU: key меняется, но code тот же
  assert.deepEqual(hit('KeyS', 'ы'), { kind: 'cut' })
  assert.deepEqual(hit('KeyC', ' s'), { kind: 'toggleDrop' })
  assert.deepEqual(hit('KeyI', 'ш'), { kind: 'in' })
  assert.deepEqual(hit('KeyO', 'щ'), { kind: 'out' })
  assert.deepEqual(hit('KeyF', 'а'), { kind: 'capture' })
  assert.deepEqual(hit('KeyR', 'к'), { kind: 'crop' })
  assert.deepEqual(hit('KeyA', 'ф'), { kind: 'audio' })
  assert.deepEqual(hit('KeyB', 'и'), { kind: 'drawer' })
  assert.deepEqual(hit('KeyG', 'п'), { kind: 'showOnCanvas' })
  assert.deepEqual(hit('KeyD', ' to '), { kind: 'downloadFrame' })
})

test('Space — play, Enter — apply', () => {
  assert.deepEqual(hit('Space', ' '), { kind: 'play' })
  assert.deepEqual(hit('Enter', 'Enter'), { kind: 'apply' })
})

test('стрелки: кадр/секунда, повтор разрешён', () => {
  assert.deepEqual(hit('ArrowLeft', 'ArrowLeft'), { kind: 'seek', direction: -1, seconds: false })
  assert.deepEqual(hit('ArrowRight', 'ArrowRight'), { kind: 'seek', direction: 1, seconds: false })
  assert.deepEqual(hit('ArrowRight', 'ArrowRight', { shift: true }), { kind: 'seek', direction: 1, seconds: true })
})

test('ползунок (ARIA slider): PageUp/Down и Home/End', () => {
  assert.deepEqual(hit('PageUp', 'PageUp'), { kind: 'seek', direction: -1, seconds: false, page: true })
  assert.deepEqual(hit('PageDown', 'PageDown'), { kind: 'seek', direction: 1, seconds: false, page: true })
  assert.deepEqual(hit('Home', 'Home'), { kind: 'seek', direction: -1, seconds: false, edge: 'start' })
  assert.deepEqual(hit('End', 'End'), { kind: 'seek', direction: 1, seconds: false, edge: 'end' })
  // как стрелки, они живут ДО shift-отсечения буквенных: Shift не должен гасить
  assert.deepEqual(hit('PageDown', 'PageDown', { shift: true }), { kind: 'seek', direction: 1, seconds: false, page: true })
})

test('Escape — close, и он не крадётся модификаторами', () => {
  assert.deepEqual(hit('Escape', 'Escape'), { kind: 'close' })
})

test('native button не крадёт Space/Enter', () => {
  assert.equal(hit('Space', ' ', { onNativeButton: true }), null)
  assert.equal(hit('Enter', 'Enter', { onNativeButton: true }), null)
  // а вот S кнопка не съедает
  assert.deepEqual(hit('KeyS', 's', { onNativeButton: true }), { kind: 'cut' })
})

test('guard: ctrl/meta/alt гасит все буквы и стрелки', () => {
  for (const mod of [{ ctrl: true }, { meta: true }, { alt: true }]) {
    assert.equal(hit('KeyS', 's', mod), null, JSON.stringify(mod))
    assert.equal(hit('KeyC', 'c', mod), null)
    assert.equal(hit('Space', ' ', mod), null)
    assert.equal(hit('ArrowLeft', 'ArrowLeft', mod), null)
  }
})

test('defaultPrevented и поле ввода — ничего', () => {
  assert.equal(hit('KeyS', 's', { defaultPrevented: true }), null)
  assert.equal(hit('Space', ' ', { inInput: true }), null)
  assert.equal(hit('ArrowRight', 'ArrowRight', { inInput: true }), null)
})

test('shift после стрелок гасит буквы', () => {
  assert.equal(hit('KeyS', 's', { shift: true }), null)
  assert.equal(hit('KeyF', 'f', { shift: true }), null)
})

test('неизвестная клавиша — null (не preventDefault)', () => {
  assert.equal(hit('KeyQ', 'q'), null)
  assert.equal(hit('F5', 'F5'), null)
})

test('повтор: только движение (стрелки/ползунок), не буквы и не Enter', () => {
  // движение живёт на удержании
  assert.deepEqual(hit('ArrowLeft', 'ArrowLeft', { repeat: true }), { kind: 'seek', direction: -1, seconds: false })
  assert.deepEqual(hit('PageUp', 'PageUp', { repeat: true }), { kind: 'seek', direction: -1, seconds: false, page: true })
  // точные действия — единичные: зажатая клавиша не режет пачку кадров
  assert.equal(hit('KeyS', 's', { repeat: true }), null)
  assert.equal(hit('KeyF', 'f', { repeat: true }), null)
  assert.equal(hit('Enter', 'Enter', { repeat: true }), null)
  assert.equal(hit('Space', ' ', { repeat: true }), null)
})