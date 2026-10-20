import assert from 'node:assert/strict'
import test from 'node:test'
import { readingOrder, type OrderedBox } from './readingOrder.js'

const box = (id: string, x: number, y: number, w = 100, h = 100): OrderedBox => ({ id, x, y, w, h })
const ids = (items: OrderedBox[]) => items.map((item) => item.id)

// ⚠️ Ровно та жалоба: два кадра рядом, а референсы приходят наоборот, потому
// что рамка брала их в порядке создания.
test('ряд выстраивается слева направо, а не в порядке создания', () => {
  const порядокСоздания = [box('правый', 600, 0), box('левый', 0, 0)]
  assert.deepEqual(ids(readingOrder(порядокСоздания)), ['левый', 'правый'])
})

test('несколько рядов читаются сверху вниз', () => {
  const items = [
    box('низ-право', 600, 400), box('верх-право', 600, 0),
    box('низ-лево', 0, 400), box('верх-лево', 0, 0),
  ]
  assert.deepEqual(ids(readingOrder(items)), ['верх-лево', 'верх-право', 'низ-лево', 'низ-право'])
})

// Материал на доске разноразмерный — ряд не должен рассыпаться от того, что
// соседи стоят не идеально по одной линии.
test('небольшая разница по высоте не разбивает ряд', () => {
  const items = [
    box(' to ', 800, 12, 100, 90),
    box('б', 400, 0, 100, 140),
    box('а', 0, 6, 100, 110),
  ]
  assert.deepEqual(ids(readingOrder(items)), ['а', 'б', ' to '])
})

test('объект заметно ниже начинает новый ряд', () => {
  const items = [box('верх', 500, 0), box('низ', 0, 300)]
  assert.deepEqual(ids(readingOrder(items)), ['верх', 'низ'])
})

test('порядок устойчив: одинаковые координаты не тасуются', () => {
  const items = [box('а', 0, 0), box('б', 0, 0)]
  assert.deepEqual(ids(readingOrder(items)), ids(readingOrder(items)))
})

test('пустой и одиночный набор не ломаются', () => {
  assert.deepEqual(readingOrder([]), [])
  assert.deepEqual(ids(readingOrder([box('один', 5, 5)])), ['один'])
})

test('исходный массив не меняется', () => {
  const items = [box('правый', 600, 0), box('левый', 0, 0)]
  readingOrder(items)
  assert.deepEqual(ids(items), ['правый', 'левый'])
})
