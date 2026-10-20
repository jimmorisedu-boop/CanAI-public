import test from 'node:test'
import assert from 'node:assert/strict'
import { descendantsOf, pickBaseline, type LineageItem } from './compareSelection'

const source: LineageItem = { id: 'src', kind: 'image' } // импорт: без промпта
const genA: LineageItem = { id: 'a', kind: 'image', prompt: 'p', referenceIds: ['src'] }
const genB: LineageItem = { id: 'b', kind: 'image', prompt: 'p', referenceIds: ['src'] }

test('исходник узнаётся по родословной, а не по порядку выбора', () => {
  // исходник выбран ПОСЛЕДНИМ — правило всё равно находит его
  const pick = pickBaseline([genA, genB, source])
  assert.equal(pick.baselineId, 'src')
  assert.deepEqual(pick.candidateIds, ['a', 'b'])
  assert.equal(pick.reason, 'lineage')
  assert.equal(pick.pulledIn, false)
})

test('родословной нет — исходником становится единственный импорт', () => {
  const foreign: LineageItem = { id: 'x', kind: 'image' }
  const gen: LineageItem = { id: 'g', kind: 'image', prompt: 'p', referenceIds: ['другой'] }
  const pick = pickBaseline([gen, foreign])
  assert.equal(pick.baselineId, 'x')
  assert.deepEqual(pick.candidateIds, ['g'])
  assert.equal(pick.reason, 'import')
})

test('два импорта — не угадываем, берём первый по порядку', () => {
  const pick = pickBaseline([
    { id: 'one', kind: 'image' },
    { id: 'two', kind: 'image' },
  ])
  assert.equal(pick.baselineId, 'one')
  assert.deepEqual(pick.candidateIds, ['two'])
  assert.equal(pick.reason, 'order')
})

test('выбрали только сёстер — общий родитель подтягивается сам', () => {
  const all = new Map([[source.id, source]])
  const pick = pickBaseline([genA, genB], (id) => all.get(id))
  assert.equal(pick.baselineId, 'src')
  assert.deepEqual(pick.candidateIds, ['a', 'b'])
  assert.equal(pick.reason, 'siblings')
  assert.equal(pick.pulledIn, true)
})

test('общий родитель удалён — не подтягиваем, работаем как есть', () => {
  const pick = pickBaseline([genA, genB], () => undefined)
  assert.equal(pick.reason, 'order')
  assert.equal(pick.baselineId, 'a')
  assert.equal(pick.pulledIn, false)
})

test('родитель общий только у части сёстер — правило молчит', () => {
  const other: LineageItem = { id: 'c', kind: 'image', prompt: 'p', referenceIds: ['иной'] }
  const all = new Map([[source.id, source]])
  const pick = pickBaseline([genA, other], (id) => all.get(id))
  assert.equal(pick.reason, 'order')
})

test('текстовые объекты в сравнение не попадают', () => {
  const note: LineageItem = { id: 'note', kind: 'text' }
  const pick = pickBaseline([note, source, genA])
  assert.equal(pick.baselineId, 'src')
  assert.deepEqual(pick.candidateIds, ['a'])

  assert.equal(pickBaseline([note]).reason, 'empty')
  assert.equal(pickBaseline([note]).baselineId, null)
})

test('видео сравнивается наравне с картинками', () => {
  const clip: LineageItem = { id: 'v', kind: 'video', prompt: 'p', referenceIds: ['src'] }
  const pick = pickBaseline([source, clip])
  assert.equal(pick.baselineId, 'src')
  assert.deepEqual(pick.candidateIds, ['v'])
})

test('все генерации исходника находятся по обратной ссылке', () => {
  const unrelated: LineageItem = { id: 'z', kind: 'image', prompt: 'p', referenceIds: ['иной'] }
  const note: LineageItem = { id: 'n', kind: 'text', referenceIds: ['src'] }
  assert.deepEqual(descendantsOf('src', [source, genA, genB, unrelated, note]), ['a', 'b'])
  assert.deepEqual(descendantsOf('нет-такого', [genA, genB]), [])
})
