import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchTimelineKey, type TimelineKeyContext } from './timelineKeys'

function hit(code: string, key: string, over: Partial<TimelineKeyContext> = {}) {
  return dispatchTimelineKey({ code, key, context: over })
}

test('буквы — физическим event.code (EN и RU одинаково)', () => {
  // EN
  assert.deepEqual(hit('KeyC', 'c'), { kind: 'cut' })
  assert.deepEqual(hit('KeyX', 'x'), { kind: 'toggleDrop' })
  assert.deepEqual(hit('KeyQ', 'q'), { kind: 'trimLeft' })
  assert.deepEqual(hit('KeyW', 'w'), { kind: 'trimRight' })
  assert.deepEqual(hit('KeyI', 'i'), { kind: 'in' })
  assert.deepEqual(hit('KeyO', 'o'), { kind: 'out' })
  assert.deepEqual(hit('KeyS', 's'), { kind: 'capture' })
  assert.deepEqual(hit('KeyF', 'f'), { kind: 'crop' })
  assert.deepEqual(hit('KeyA', 'a'), { kind: 'audio' })
  assert.deepEqual(hit('KeyB', 'b'), { kind: 'drawer' })
  assert.deepEqual(hit('KeyG', 'g'), { kind: 'showOnCanvas' })
  assert.deepEqual(hit('KeyD', 'd'), { kind: 'downloadFrame' })
  assert.deepEqual(hit('Digit0', '0'), { kind: 'fit' })
  // RU: key меняется, но code тот же
  assert.deepEqual(hit('KeyC', 'с'), { kind: 'cut' })
  assert.deepEqual(hit('KeyX', 'ч'), { kind: 'toggleDrop' })
  assert.deepEqual(hit('KeyQ', 'й'), { kind: 'trimLeft' })
  assert.deepEqual(hit('KeyW', 'ц'), { kind: 'trimRight' })
  assert.deepEqual(hit('KeyI', 'ш'), { kind: 'in' })
  assert.deepEqual(hit('KeyO', 'щ'), { kind: 'out' })
  assert.deepEqual(hit('KeyS', 'ы'), { kind: 'capture' })
  assert.deepEqual(hit('KeyF', 'а'), { kind: 'crop' })
  assert.deepEqual(hit('KeyA', 'ф'), { kind: 'audio' })
  assert.deepEqual(hit('KeyB', 'и'), { kind: 'drawer' })
  assert.deepEqual(hit('KeyG', 'п'), { kind: 'showOnCanvas' })
  assert.deepEqual(hit('KeyD', 'в'), { kind: 'downloadFrame' })
})

test('Space — play, Enter — apply', () => {
  assert.deepEqual(hit('Space', ' '), { kind: 'play' })
  assert.deepEqual(hit('Enter', 'Enter'), { kind: 'apply' })
})

test('стрелки влево/вправо: 1 кадр, с Shift — 10 кадров; вверх/вниз — к склейкам', () => {
  assert.deepEqual(hit('ArrowLeft', 'ArrowLeft'), { kind: 'seek', direction: -1, tenFrames: false })
  assert.deepEqual(hit('ArrowRight', 'ArrowRight'), { kind: 'seek', direction: 1, tenFrames: false })
  assert.deepEqual(hit('ArrowLeft', 'ArrowLeft', { shift: true }), { kind: 'seek', direction: -1, tenFrames: true })
  assert.deepEqual(hit('ArrowRight', 'ArrowRight', { shift: true }), { kind: 'seek', direction: 1, tenFrames: true })
  assert.deepEqual(hit('ArrowUp', 'ArrowUp'), { kind: 'jumpCut', direction: 1 })
  assert.deepEqual(hit('ArrowDown', 'ArrowDown'), { kind: 'jumpCut', direction: -1 })
})

test('ползунок (ARIA slider): PageUp/Down и Home/End', () => {
  assert.deepEqual(hit('PageUp', 'PageUp'), { kind: 'seek', direction: -1, tenFrames: false, page: true })
  assert.deepEqual(hit('PageDown', 'PageDown'), { kind: 'seek', direction: 1, tenFrames: false, page: true })
  assert.deepEqual(hit('Home', 'Home'), { kind: 'seek', direction: -1, tenFrames: false, edge: 'start' })
  assert.deepEqual(hit('End', 'End'), { kind: 'seek', direction: 1, tenFrames: false, edge: 'end' })
  // как стрелки, они живут ДО shift-отсечения буквенных: Shift не должен гасить
  assert.deepEqual(hit('PageDown', 'PageDown', { shift: true }), { kind: 'seek', direction: 1, tenFrames: false, page: true })
})

test('Escape — close, и он не крадётся модификаторами', () => {
  assert.deepEqual(hit('Escape', 'Escape'), { kind: 'close' })
})

test('native button не крадёт Space/Enter', () => {
  assert.equal(hit('Space', ' ', { onNativeButton: true }), null)
  assert.equal(hit('Enter', 'Enter', { onNativeButton: true }), null)
  // а вот C кнопка не съедает
  assert.deepEqual(hit('KeyC', 'c', { onNativeButton: true }), { kind: 'cut' })
})

test('guard: ctrl/meta/alt гасит все буквы и стрелки', () => {
  for (const mod of [{ ctrl: true }, { meta: true }, { alt: true }]) {
    assert.equal(hit('KeyC', 'c', mod), null, JSON.stringify(mod))
    assert.equal(hit('KeyX', 'x', mod), null)
    assert.equal(hit('Space', ' ', mod), null)
    assert.equal(hit('ArrowLeft', 'ArrowLeft', mod), null)
    assert.equal(hit('ArrowUp', 'ArrowUp', mod), null)
  }
})

test('defaultPrevented и поле ввода — ничего', () => {
  assert.equal(hit('KeyC', 'c', { defaultPrevented: true }), null)
  assert.equal(hit('Space', ' ', { inInput: true }), null)
  assert.equal(hit('ArrowRight', 'ArrowRight', { inInput: true }), null)
})

test('shift после стрелок гасит буквы', () => {
  assert.equal(hit('KeyC', 'c', { shift: true }), null)
  assert.equal(hit('KeyS', 's', { shift: true }), null)
  assert.equal(hit('KeyQ', 'q', { shift: true }), null)
})

test('неизвестная клавиша — null (не preventDefault)', () => {
  assert.equal(hit('KeyR', 'r'), null)
  assert.equal(hit('F5', 'F5'), null)
})

test('повтор: только движение (стрелки/склейки/ползунок), не буквы и не Enter', () => {
  // движение живёт на удержании
  assert.deepEqual(hit('ArrowLeft', 'ArrowLeft', { repeat: true }), { kind: 'seek', direction: -1, tenFrames: false })
  assert.deepEqual(hit('ArrowUp', 'ArrowUp', { repeat: true }), { kind: 'jumpCut', direction: 1 })
  assert.deepEqual(hit('ArrowDown', 'ArrowDown', { repeat: true }), { kind: 'jumpCut', direction: -1 })
  assert.deepEqual(hit('PageUp', 'PageUp', { repeat: true }), { kind: 'seek', direction: -1, tenFrames: false, page: true })
  // точные действия — единичные: зажатая клавиша не режет пачку кадров
  assert.equal(hit('KeyC', 'c', { repeat: true }), null)
  assert.equal(hit('KeyS', 's', { repeat: true }), null)
  assert.equal(hit('KeyQ', 'q', { repeat: true }), null)
  assert.equal(hit('KeyW', 'w', { repeat: true }), null)
  assert.equal(hit('Enter', 'Enter', { repeat: true }), null)
  assert.equal(hit('Space', ' ', { repeat: true }), null)
})