import assert from 'node:assert/strict'
import test from 'node:test'
import type { SelectionRef } from './konva/selection'
import {
  actionBatchIsSeparate,
  leadBatchRefs,
  logicalBatchRefs,
  missingBatchSource,
  planActionBatch,
} from './actionDockBatch'

const image = (shapeId: string, src = `/media/${shapeId}.png`): SelectionRef => ({
  shapeId,
  kind: 'image',
  label: shapeId,
  src,
  w: 100,
  h: 100,
})

const note: SelectionRef = { shapeId: 'note', kind: 'text', label: 'note', text: 'свет слева' }
const clip: SelectionRef = { shapeId: 'clip', kind: 'video', label: 'clip', src: '/media/clip.mp4' }

test('each mode freezes one image per group and shares text context', () => {
  const plan = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b'), note],
    prompt: 'замени фон',
    count: 3,
  })

  assert.equal(plan.error, null)
  assert.equal(plan.jobs, 6)
  assert.equal(plan.groups.length, 2)
  assert.equal(plan.groups[0]?.imageRef?.shapeId, 'a')
  assert.deepEqual(plan.groups[0]?.refs.map((ref) => ref.shapeId), ['a', 'note'])
  assert.deepEqual(plan.groups[1]?.refs.map((ref) => ref.shapeId), ['b', 'note'])
  assert.equal(actionBatchIsSeparate(plan), true)
})

test('together mode keeps the original combined refs and job count', () => {
  const plan = planActionBatch({
    kind: 'image',
    mode: 'together',
    refs: [image('a'), image('b')],
    prompt: 'собери сцену',
    count: 4,
  })

  assert.equal(plan.error, null)
  assert.equal(plan.jobs, 4)
  assert.deepEqual(plan.groups[0]?.refs.map((ref) => ref.shapeId), ['a', 'b'])
  assert.equal(actionBatchIsSeparate(plan), false)
})

test('incompatible media and explicit @1/@2 ambiguity are rejected', () => {
  const mixed = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b'), clip],
    prompt: 'замени фон',
    count: 1,
  })
  assert.match(mixed.error ?? '', /only works with images/i)

  const ambiguous = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b')],
    prompt: 'сделай @1 похожим на @2',
    count: 1,
  })
  assert.match(ambiguous.error ?? '', /@1.*@2|несколько референсов/i)
})

// «Изменить каждое» стоит по умолчанию, а переключатель режима виден только
// при двух картинках и больше. С одной картинкой делить нечего — запрос один и
// ролик из него не выпадает, — но отказ «только с изображениями» срабатывал и
// тут: «картинка + ролик» не запускалась, и выйти из отказа было нечем.
test('одна картинка и ролик уходят одним запросом в любом режиме', () => {
  for (const mode of ['each', 'together'] as const) {
    const plan = planActionBatch({ kind: 'image', mode, refs: [image('a'), clip, note], prompt: 'сведи', count: 2 })
    assert.equal(plan.error, null)
    assert.equal(plan.groups.length, 1)
    assert.equal(plan.jobs, 2)
    assert.deepEqual(plan.groups[0]?.refs.map((ref) => ref.shapeId), ['a', 'clip', 'note'])
  }
  const onlyClip = planActionBatch({ kind: 'image', mode: 'each', refs: [clip], prompt: 'кадр', count: 1 })
  assert.equal(onlyClip.error, null)
  assert.deepEqual(onlyClip.groups[0]?.refs.map((ref) => ref.shapeId), ['clip'])
})

test('single @1 is remapped per source, while @2 alone is rejected', () => {
  const single = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b')],
    prompt: 'сохрани @1',
    count: 1,
  })
  assert.equal(single.error, null)

  const wrongSlot = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b')],
    prompt: 'сохрани @2',
    count: 1,
  })
  assert.match(wrongSlot.error ?? '', /@1.*@2|несколько референсов/i)
})

test('numeric tags remain unambiguous when punctuation touches them', () => {
  const ambiguous = planActionBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('a'), image('b')],
    prompt: 'сделай @1,@2 в одной сцене',
    count: 1,
  })
  assert.match(ambiguous.error ?? '', /@1.*@2|несколько референсов/i)
})

test('video and audio never split image selections or count variants', () => {
  const video = planActionBatch({
    kind: 'video',
    mode: 'each',
    refs: [image('a'), image('b')],
    prompt: 'анимация',
    count: 4,
  })
  assert.equal(video.jobs, 1)
  assert.equal(video.groups.length, 1)
  assert.deepEqual(video.groups[0]?.refs.map((ref) => ref.shapeId), ['a', 'b'])
})

// Пределы модели здесь больше не проверяются: берёт ли модель набор, решает
// подбор модели по тому, что запрос реально отправит (скетч — одна склейка,
// ролик для картинки — кадр). Правило «предел модели отказывает до того, как
// допущена хоть одна группа» закреплено в actionDockBatchPlanning.test.ts.
test('допуск набора не зависит от модели: это только структура запросов', () => {
  const plan = planActionBatch({
    kind: 'image',
    mode: 'together',
    refs: Array.from({ length: 20 }, (_, index) => image(`ref-${index}`)),
    prompt: 'собери',
    count: 1,
  })
  assert.equal(plan.error, null)
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.imageCount, 20)
})

test('референсы первого запроса совпадают с первой группой плана', () => {
  const cases: Array<[SelectionRef[], 'image' | 'video' | 'audio', 'each' | 'together']> = [
    [[image('a'), image('b'), note], 'image', 'each'],
    [[image('a'), image('b'), note], 'image', 'together'],
    [[image('a'), note], 'image', 'each'],
    [[image('a'), clip], 'image', 'each'],
    [[image('a'), image('b')], 'video', 'each'],
    [[], 'image', 'each'],
  ]
  for (const [refs, kind, mode] of cases) {
    const plan = planActionBatch({ kind, mode, refs, prompt: 'p', count: 1 })
    assert.deepEqual(
      leadBatchRefs(kind, mode, refs).map((ref) => ref.shapeId),
      plan.groups[0]?.refs.map((ref) => ref.shapeId),
    )
  }
  // в «Изменить каждое» первый запрос несёт одну картинку и общий текст
  assert.deepEqual(
    leadBatchRefs('image', 'each', [image('a'), image('b'), note]).map((ref) => ref.shapeId),
    ['a', 'note'],
  )
})

test('две карточки с одним файлом — один логический референс, текст не трогаем', () => {
  const refs = [image('a', '/media/same.png'), image('b', '/media/same.png'), note, { ...note, shapeId: 'note-2' }]
  assert.deepEqual(logicalBatchRefs(refs).map((ref) => ref.shapeId), ['a', 'note', 'note-2'])
})

test('медиа-референс без адреса файла называется до запуска', () => {
  assert.equal(missingBatchSource([image('a'), note]), null)
  assert.match(missingBatchSource([{ shapeId: 'broken', kind: 'image', label: 'broken' }]) ?? '', /Select it again/u)
})
