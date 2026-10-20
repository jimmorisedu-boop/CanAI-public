import assert from 'node:assert/strict'
import test from 'node:test'
import { fadeEdges, wheelShift } from './scrollFade'

test('строка помещается — ни один край не тает', () => {
  assert.equal(fadeEdges(0, 700, 700), 'none')
  assert.equal(fadeEdges(0, 700, 640), 'none')
})

test('доля пикселя при дробном масштабе — ещё не переполнение', () => {
  assert.equal(fadeEdges(0, 700, 700.6), 'none')
  assert.equal(fadeEdges(0, 700, 701), 'none')
})

test('тает тот край, за которым осталось содержимое', () => {
  assert.equal(fadeEdges(0, 560, 640), 'end', 'строка в начале — спрятано справа')
  assert.equal(fadeEdges(40, 560, 640), 'both', 'посередине — спрятано с обеих сторон')
  assert.equal(fadeEdges(80, 560, 640), 'start', 'докрутили до конца — спрятано слева')
  // Браузер отдаёт дробную прокрутку: «почти до конца» — это до конца.
  assert.equal(fadeEdges(79.4, 560, 640), 'start')
  assert.equal(fadeEdges(0.5, 560, 640), 'end')
})

const wheel = (patch: Partial<{ deltaX: number; deltaY: number; ctrlKey: boolean; shiftKey: boolean }>) => (
  { deltaX: 0, deltaY: 0, ctrlKey: false, shiftKey: false, ...patch }
)

test('обычное колесо возит строку вбок, только когда ей есть куда ехать', () => {
  assert.equal(wheelShift(wheel({ deltaY: 100 }), 80), 100)
  assert.equal(wheelShift(wheel({ deltaY: -100 }), 80), -100)
  // Строка помещается — колесо не трогаем: иначе над рядом настроек перестала
  // бы прокручиваться лента помощника.
  assert.equal(wheelShift(wheel({ deltaY: 100 }), 0), null)
  assert.equal(wheelShift(wheel({ deltaY: 100 }), 0.6), null)
})

test('то, с чем браузер справляется сам, не перехватываем', () => {
  assert.equal(wheelShift(wheel({ deltaX: 60, deltaY: 4 }), 80), null, 'тачпад вбок')
  assert.equal(wheelShift(wheel({ deltaY: 100, shiftKey: true }), 80), null, 'Shift+колесо')
  assert.equal(wheelShift(wheel({ deltaY: 100, ctrlKey: true }), 80), null, 'Ctrl+колесо — масштаб страницы')
  assert.equal(wheelShift(wheel({}), 80), null)
})
