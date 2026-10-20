// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { placeContextBar } from './contextBarPlacement'

test('панель встаёт под объектом и центрируется', () => {
  assert.deepEqual(placeContextBar(
    { left: 300, right: 500, top: 200, bottom: 400 },
    { width: 280, height: 56 },
    { left: 0, top: 64, right: 1024, bottom: 760 },
  ), { left: 260, top: 412, side: 'below' })
})

test('у нижнего края панель переворачивается наверх', () => {
  assert.deepEqual(placeContextBar(
    { left: 300, right: 500, top: 680, bottom: 780 },
    { width: 280, height: 56 },
    { left: 0, top: 64, right: 1024, bottom: 800 },
  ), { left: 260, top: 612, side: 'above' })
})

test('панель не выходит за безопасные боковые края', () => {
  assert.equal(placeContextBar(
    { left: -30, right: 70, top: 200, bottom: 300 },
    { width: 280, height: 56 },
    { left: 16, top: 64, right: 1000, bottom: 760 },
  ).left, 16)
})

test('если места нет ни сверху ни снизу, панель становится нижним листом', () => {
  assert.equal(placeContextBar(
    { left: 200, right: 800, top: 90, bottom: 700 },
    { width: 500, height: 80 },
    { left: 12, top: 64, right: 1012, bottom: 760 },
  ).side, 'sheet')
})

test('плавающий док сверху не срезает безопасную нижнюю область', () => {
  assert.deepEqual(placeContextBar(
    { left: 300, right: 500, top: 300, bottom: 400 },
    { width: 280, height: 56 },
    { left: 0, top: 64, right: 1024, bottom: 760 },
    { left: 200, right: 824, top: 80, bottom: 260 },
  ), { left: 260, top: 412, side: 'below' })
})

test('плавающий док в центре обходится через свободную сторону', () => {
  const placement = placeContextBar(
    { left: 300, right: 500, top: 220, bottom: 280 },
    { width: 280, height: 56 },
    { left: 0, top: 64, right: 1024, bottom: 760 },
    { left: 200, right: 824, top: 300, bottom: 500 },
  )
  assert.deepEqual(placement, { left: 260, top: 152, side: 'above' })
})
