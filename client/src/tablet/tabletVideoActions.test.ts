// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { TABLET_VIDEO_ACTIONS_EDGE, tabletVideoActionsStyle } from './tabletVideoActions'

test('отступ панели видео от края одинаков на экране при любом масштабе доски', () => {
  // Панель держит экранный размер; отступ в единицах доски таял при
  // отдалении — на масштабе 0.5 панель стояла в 4 пикселях от края клипа.
  for (const scale of [0.15, 0.5, 1, 2.5]) {
    const style = tabletVideoActionsStyle(scale)
    assert.equal(Math.round(Number(style.top) * scale * 1000) / 1000, TABLET_VIDEO_ACTIONS_EDGE)
    assert.equal(Math.round(Number(style.left) * scale * 1000) / 1000, TABLET_VIDEO_ACTIONS_EDGE)
    assert.equal(style.transform, `scale(${1 / scale})`)
  }
  assert.ok(TABLET_VIDEO_ACTIONS_EDGE > 8, 'чуть дальше прежних восьми')
})

test('мусорный масштаб не роняет раскладку', () => {
  for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const style = tabletVideoActionsStyle(scale)
    assert.equal(style.top, TABLET_VIDEO_ACTIONS_EDGE)
    assert.equal(style.transform, 'scale(1)')
  }
})

