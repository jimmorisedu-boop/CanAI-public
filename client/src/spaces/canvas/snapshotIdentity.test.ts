import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryWorthSending, sameSnapshot } from './snapshotIdentity'

const doc = {
  version: 1,
  items: [{ id: 'a', kind: 'image', x: 10, y: 20, w: 100, h: 100, src: '/media/a.png' }],
  camera: { x: 0, y: 0, scale: 1 },
}

test('совпадающий отложенный снимок на сервер НЕ отправляется', () => {
  // Это и есть случай «просто запустила после обновления»: работа уже
  // сохранена, восстанавливать нечего, а отправка со старым номером ревизии
  // рождала конфликтную копию и вторую доску в галерее.
  assert.equal(recoveryWorthSending(structuredClone(doc) as never, doc), false)
})

test('настоящая несохранённая правка отправляется как раньше', () => {
  const edited = structuredClone(doc)
  edited.items[0].x = 999
  assert.equal(recoveryWorthSending(edited as never, doc), true)
  assert.equal(recoveryWorthSending(null, doc), false)
})

test('порядок ключей не делает снимки разными', () => {
  // Снимок проходит через JSON туда и обратно в разных местах; порядок полей
  // не гарантирован, и считать его различием значило бы плодить копии зря.
  assert(sameSnapshot({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }))
})

test('отсутствующее поле и undefined — одно и то же', () => {
  // В JSON undefined не попадает вовсе, значит на сервере такого поля просто нет.
  assert(sameSnapshot({ a: 1, b: undefined }, { a: 1 }))
})

test('порядок объектов в списке — это РАЗНИЦА, а не мелочь', () => {
  // Порядок объектов на доске виден человеку (слои), и терять его нельзя.
  assert.equal(sameSnapshot({ items: [1, 2] }, { items: [2, 1] }), false)
})

test('снимок, который нельзя сравнить, считается отличным', () => {
  // Молча проглотить отличие хуже, чем лишний раз отправить: пусть работает
  // прежний путь с конфликтной копией.
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  assert.equal(sameSnapshot(cyclic, { a: 1 }), false)
  assert.equal(sameSnapshot(null, null), true)
  assert.equal(sameSnapshot(null, { a: 1 }), false)
})
