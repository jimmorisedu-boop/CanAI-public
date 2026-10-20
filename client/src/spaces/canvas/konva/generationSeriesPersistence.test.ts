import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore'

test('legacy doc загружается без durable launch ids', () => {
  const store = new CanvasStore()
  store.markGenerationLaunchHandled('before-legacy-load')

  store.loadDoc({ version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } })

  assert.deepEqual(store.getHandledGenerationLaunchIds(), [])
})

test('загрузка оставляет последние 100 уникальных валидных launch ids', () => {
  const store = new CanvasStore()

  store.loadDoc({
    version: 1,
    items: [],
    camera: { x: 0, y: 0, scale: 1 },
    handledGenerationLaunchIds: [
      'earlier-duplicate',
      '',
      ...Array.from({ length: 101 }, (_, index) => `launch-${index}`),
      'earlier-duplicate',
      'x'.repeat(101),
    ],
  })

  assert.deepEqual(
    store.getHandledGenerationLaunchIds(),
    Array.from({ length: 99 }, (_, index) => `launch-${index + 2}`).concat('earlier-duplicate'),
  )
})

test('хранит только 100 последних уникальных launch ids', () => {
  const store = new CanvasStore()

  for (let index = 0; index < 105; index++) store.markGenerationLaunchHandled(`launch-${index}`)

  assert.deepEqual(
    store.toDoc().handledGenerationLaunchIds,
    Array.from({ length: 100 }, (_, index) => `launch-${index + 5}`),
  )
  assert.equal(store.markGenerationLaunchHandled('launch-104'), false)
})

test('документ не содержит пустое поле и не отдаёт state launch ids по ссылке', () => {
  const store = new CanvasStore()

  assert.equal('handledGenerationLaunchIds' in store.toDoc(), false)
  store.markGenerationLaunchHandled('launch-cloned')
  const doc = store.toDoc()
  doc.handledGenerationLaunchIds?.push('injected-into-snapshot')

  assert.equal(store.hasHandledGenerationLaunch('injected-into-snapshot'), false)
})

test('новая отметка будит документ один раз, а дубль и невалидные ids — нет', () => {
  const store = new CanvasStore()
  let documentChanges = 0
  const unsubscribe = store.subscribeDocument(() => documentChanges++)

  assert.equal(store.markGenerationLaunchHandled('launch-once'), true)
  assert.equal(documentChanges, 1)
  assert.equal(store.markGenerationLaunchHandled('launch-once'), false)
  assert.equal(store.markGenerationLaunchHandled(''), false)
  assert.equal(store.markGenerationLaunchHandled('x'.repeat(101)), false)
  assert.equal(documentChanges, 1)
  unsubscribe()
})

test('undo не удаляет durable отметку серии', () => {
  const store = new CanvasStore()
  const itemId = store.addItem({ kind: 'text', x: 0, y: 0, w: 160, h: 80, text: 'Исторический шаг' })

  store.markGenerationLaunchHandled('launch-outside-history')
  assert.equal(store.undo(), true)

  assert.equal(store.getItem(itemId), undefined)
  assert.equal(store.hasHandledGenerationLaunch('launch-outside-history'), true)
})
