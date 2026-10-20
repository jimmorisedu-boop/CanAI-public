import assert from 'node:assert/strict'
import test from 'node:test'
import type { SelectionRef } from './konva/selection'
import {
  appendUniqueReferences,
  clampMentionIndex,
  detectReferenceMention,
  insertReferenceTag,
  mediaReferences,
  referenceMentionCandidates,
  replaceComposerReference,
  removeComposerReference,
  syncActiveReferences,
} from './referenceComposer'

function image(shapeId: string, src: string, label = shapeId): SelectionRef {
  return { shapeId, kind: 'image', label, src }
}

test('явные референсы сохраняют порядок и не дублируются по id или содержимому', () => {
  const first = image('one', '/media/a.png')
  const sameId = image('one', '/media/other.png')
  const sameSource = image('copy', '/media/a.png')
  const second = image('two', '/media/b.png')

  assert.deepEqual(
    appendUniqueReferences([first], [sameId, sameSource, second]).map(
      (ref) => ref.shapeId,
    ),
    ['one', 'two'],
  )
})

test('живые источники сохраняют хронологию и приоритет первого источника', () => {
  const selected = image('selected', '/media/shared.png')
  const manualDuplicate = image('asset:0', '/media/shared.png')
  const manual = image('asset:1', '/media/manual.png')

  const result = syncActiveReferences(
    ['asset:1', 'selected'],
    [[selected], [manualDuplicate, manual]],
  )

  assert.deepEqual(result.order, ['asset:1', 'selected'])
  assert.deepEqual(result.refs.map((ref) => ref.shapeId), ['asset:1', 'selected'])
})

test('дубликат из приоритетного источника занимает прежнее место того же контента', () => {
  const selectedDuplicate = image('canvas-a', '/media/a.png')
  const previousFirst = image('asset:0', '/media/a.png')
  const previousSecond = image('asset:1', '/media/b.png')

  const result = syncActiveReferences(
    ['asset:0', 'asset:1'],
    [[selectedDuplicate], [previousFirst, previousSecond]],
  )

  assert.deepEqual(result.order, ['canvas-a', 'asset:1'])
  assert.deepEqual(result.refs.map((ref) => ref.shapeId), [
    'canvas-a',
    'asset:1',
  ])
})

test('индекс mention ограничивается текущим списком кандидатов', () => {
  assert.equal(clampMentionIndex(2, 1), 0)
  assert.equal(clampMentionIndex(1, 3), 1)
  assert.equal(clampMentionIndex(-1, 3), 0)
})

test('текст не получает номер, а удаление медиа чистит и перенумеровывает теги', () => {
  const refs: SelectionRef[] = [
    image('one', '/media/a.png', 'Alpha'),
    { shapeId: 'text', kind: 'text', label: 'Контекст', text: 'Контекст' },
    image('two', '/media/b.png', 'Beta'),
    image('three', '/media/c.png', 'Gamma'),
  ]

  assert.deepEqual(mediaReferences(refs).map((ref) => ref.shapeId), [
    'one',
    'two',
    'three',
  ])

  const removed = removeComposerReference(
    refs,
    'Смешай @1, @2 и @3.',
    'two',
  )
  assert.deepEqual(removed.refs.map((ref) => ref.shapeId), [
    'one',
    'text',
    'three',
  ])
  assert.equal(removed.text, 'Смешай @1 и @2.')
})

test('точечная замена сохраняет слот и не допускает дубликаты', () => {
  const refs = [
    image('one', '/media/a.png'),
    image('two', '/media/b.png'),
    image('three', '/media/c.png'),
  ]

  const replaced = replaceComposerReference(
    refs,
    'one',
    image('asset:4', '/media/x.png'),
  )
  assert.equal(replaced.status, 'replaced')
  assert.deepEqual(replaced.refs.map((ref) => ref.shapeId), [
    'asset:4',
    'two',
    'three',
  ])

  const duplicate = replaceComposerReference(
    refs,
    'one',
    image('asset:2', '/media/b.png'),
  )
  assert.equal(duplicate.status, 'duplicate')
  assert.deepEqual(duplicate.refs, refs)
})

test('точечная замена не смешивает текстовые и номерные медиа-слоты', () => {
  const refs: SelectionRef[] = [
    image('one', '/media/a.png'),
    { shapeId: 'note', kind: 'text', label: 'Контекст', text: 'Контекст' },
  ]

  assert.equal(
    replaceComposerReference(refs, 'one', refs[1]).status,
    'kind-mismatch',
  )
  assert.equal(
    replaceComposerReference(refs, 'note', image('two', '/media/b.png')).status,
    'kind-mismatch',
  )
})

test('mention определяется у курсора и заменяется номером референса', () => {
  const mention = detectReferenceMention('Сравни @be', 10)
  assert.deepEqual(mention, { query: 'be', start: 7 })

  const refs = [
    image('alpha', '/media/a.png', 'Alpha'),
    image('beta', '/media/b.png', 'Beta'),
  ]
  assert.deepEqual(
    referenceMentionCandidates(refs, mention?.query ?? '').map(
      (ref) => ref.shapeId,
    ),
    ['beta'],
  )
  assert.deepEqual(
    insertReferenceTag('Сравни @be', 10, 10, 2, mention?.start),
    { text: 'Сравни @2 ', caret: 10 },
  )
})

test('клик по чипу вставляет тег в выделение, текстовый чип не меняет теги', () => {
  assert.deepEqual(
    insertReferenceTag('Смешай кадры', 7, 12, 2),
    { text: 'Смешай @2 ', caret: 10 },
  )

  const refs: SelectionRef[] = [
    image('one', '/media/a.png'),
    { shapeId: 'note', kind: 'text', label: 'Текст', text: 'Текст' },
  ]
  assert.deepEqual(
    removeComposerReference(refs, 'Оставь @1', 'note'),
    { refs: [refs[0]], text: 'Оставь @1' },
  )
})
