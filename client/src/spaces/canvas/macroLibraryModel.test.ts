import assert from 'node:assert/strict'
import test from 'node:test'
import { MENU_HEIGHT, MENU_WIDTH, describeMacro, freeMacroSlots, menuPosition } from './macroLibraryModel'
import { NODES } from './macroLibraryModel'

const viewport = { width: 1280, height: 720 }

test('меню верхней строки раскрывается вниз', () => {
  const at = menuPosition({ top: 200, bottom: 226, right: 700 }, viewport)
  assert.equal(at.top, 230)
  assert.equal(at.left, 700 - MENU_WIDTH)
})

test('у нижней строки меню разворачивается ВВЕРХ, а не за край экрана', () => {
  const at = menuPosition({ top: 660, bottom: 686, right: 700 }, viewport)
  assert.ok(at.top < 660, 'меню должно уйти выше кнопки')
  assert.ok(at.top + MENU_HEIGHT <= viewport.height, 'меню не вылезает за нижний край')
})

test('меню не уезжает за правый и левый край', () => {
  const right = menuPosition({ top: 100, bottom: 126, right: 1279 }, viewport)
  assert.ok(right.left + MENU_WIDTH <= viewport.width)
  const left = menuPosition({ top: 100, bottom: 126, right: 20 }, viewport)
  assert.ok(left.left >= 0)
})

test('свободные номера идут после занятых', () => {
  const macros = [
    { slot: 0 },
    { slot: 1 },
  ] as Parameters<typeof freeMacroSlots>[0]
  assert.deepEqual(freeMacroSlots(macros), [2, 3, 4, 5, 6, 7, 8])
})

test('node count uses natural English forms', () => {
  const of = (n: number) =>
    describeMacro({ orphan: false, ready: true, nodeCount: n, unit: NODES })
  assert.equal(of(1), '1 node · ready')
  assert.equal(of(2), '2 nodes · ready')
  assert.equal(of(8), '8 nodes · ready')
})
