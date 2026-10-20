// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import {
  canvasColorWithAlpha,
  overflowCueAppearance,
  overflowCueGeometry,
  overflowCueTone,
  textOverflowsFrame,
  transparentCanvasColor,
} from './textOverflow'

test('длинный текст с переносами не помещается в низкую карточку', () => {
  assert.equal(textOverflowsFrame({
    text: 'первая строка\nвторая строка\nтретья строка',
    w: 320,
    h: 90,
    fontSize: 32,
  }), true)
})

test('после увеличения высоты тот же текст помещается', () => {
  assert.equal(textOverflowsFrame({
    text: 'первая строка\nвторая строка\nтретья строка',
    w: 320,
    h: 240,
    fontSize: 32,
  }), false)
})

test('индикатор остаётся внутри даже маленькой карточки', () => {
  const cue = overflowCueGeometry({ w: 40, h: 40, fontSize: 20 }) as unknown as Record<string, number>
  assert.ok(cue.badgeSize <= 28)
  assert.ok(cue.badgeX >= 6)
  assert.ok(cue.badgeY >= 6)
  assert.ok(cue.badgeX + cue.badgeSize <= 34)
  assert.ok(cue.badgeY + cue.badgeSize <= 34)
})

test('обычная карточка получает заметный круг и усиленное затемнение', () => {
  const cue = overflowCueGeometry({ w: 320, h: 100, fontSize: 32 }) as unknown as Record<string, number>
  assert.equal(cue.badgeSize, 28)
  assert.ok(cue.fadeH >= 52)
  assert.ok(cue.badgeX + cue.badgeSize <= 320)
  assert.ok(cue.badgeY + cue.badgeSize <= 100)
})

test('изменение высоты сразу меняет видимость индикатора', () => {
  const base = { text: 'один\nдва\nтри', w: 180, fontSize: 28 }
  assert.equal(textOverflowsFrame({ ...base, h: 70 }), true)
  assert.equal(textOverflowsFrame({ ...base, h: 260 }), false)
})

test('индикатор приглушён обычно и становится акцентным при наведении или выделении', () => {
  assert.equal(overflowCueTone({ overflowing: false, selected: false, hovered: false }), 'hidden')
  assert.equal(overflowCueTone({ overflowing: true, selected: false, hovered: false }), 'muted')
  assert.equal(overflowCueTone({ overflowing: true, selected: true, hovered: false }), 'accent')
  assert.equal(overflowCueTone({ overflowing: true, selected: false, hovered: true }), 'accent')
})

test('круг заметен обычно и усиливается в акцентном состоянии', () => {
  assert.deepEqual(overflowCueAppearance('hidden'), { fillOpacity: 0.88, strokeWidth: 1, tintOpacity: 0 })
  assert.deepEqual(overflowCueAppearance('muted'), { fillOpacity: 0.88, strokeWidth: 1, tintOpacity: 0.12 })
  assert.deepEqual(overflowCueAppearance('accent'), { fillOpacity: 0.96, strokeWidth: 2, tintOpacity: 0.18 })
})

test('цветовой слой сохраняет RGB акцента и меняет только прозрачность', () => {
  assert.equal(canvasColorWithAlpha('#d33f21', 0.12), 'rgba(211,63,33,0.12)')
  assert.equal(canvasColorWithAlpha('rgb(211, 63, 33)', 0.18), 'rgba(211,63,33,0.18)')
})

test('прозрачный край fade сохраняет цвет карточки и не сереет', () => {
  assert.equal(transparentCanvasColor('#ffffff'), 'rgba(255,255,255,0)')
  assert.equal(transparentCanvasColor('rgb(18, 19, 22)'), 'rgba(18,19,22,0)')
})
