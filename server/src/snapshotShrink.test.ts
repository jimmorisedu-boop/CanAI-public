import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSnapshotShrink, snapshotShrinkMessage } from './snapshotShrink.js'

const doc = (items: unknown[], archive: unknown[] = []) => JSON.stringify({ version: 1, items, archive })
const img = (id: string, file: string) => ({ id, kind: 'image', src: `/media/${file}`, x: 0, y: 0, w: 10, h: 10 })

test('обычное сохранение молчит', () => {
  const before = doc([img('a', 'one.png')])
  assert.equal(describeSnapshotShrink(before, JSON.parse(doc([img('a', 'one.png')]))), null)
  assert.equal(describeSnapshotShrink(before, JSON.parse(doc([img('a', 'one.png'), img('b', 'two.png')]))), null)
})

test('первое сохранение доски терять нечего', () => {
  assert.equal(describeSnapshotShrink(null, JSON.parse(doc([img('a', 'one.png')]))), null)
})

test('пропавший объект вместе со ссылкой на файл попадает в запись', () => {
  const before = doc([img('a', 'one.png'), img('b', 'two.png')])
  const shrink = describeSnapshotShrink(before, JSON.parse(doc([img('a', 'one.png')])))
  assert.ok(shrink)
  assert.equal(shrink.before, 2)
  assert.equal(shrink.after, 1)
  assert.deepEqual(shrink.lostFiles, ['two.png'])
  const line = snapshotShrinkMessage('доска-1', shrink)
  assert.match(line, /objects 2 → 1/)
  assert.match(line, /two\.png/)
})

test('отправка в архив тревогу не поднимает: материал никуда не делся', () => {
  const before = doc([img('a', 'one.png'), img('b', 'two.png')])
  const after = JSON.parse(doc([img('a', 'one.png')], [img('b', 'two.png')]))
  assert.equal(describeSnapshotShrink(before, after), null)
})

test('битую прошлую запись не разбираем и в лог не пишем', () => {
  assert.equal(describeSnapshotShrink('это не json {{{', JSON.parse(doc([]))), null)
})

test('число объектов прежнее, а файл подменён — это тоже потеря', () => {
  const before = doc([img('a', 'one.png')])
  const after = JSON.parse(doc([img('a', 'другой.png')]))
  const shrink = describeSnapshotShrink(before, after)
  assert.ok(shrink)
  assert.deepEqual(shrink.lostFiles, ['one.png'])
})

test('в строке лога перечислено не больше шести имён', () => {
  const many = Array.from({ length: 10 }, (_, i) => `f${i}.png`)
  const line = snapshotShrinkMessage('доска-2', { before: 10, after: 0, lostFiles: many })
  assert.match(line, /and 4/)
  assert.equal(line.includes('f7.png'), false)
})
