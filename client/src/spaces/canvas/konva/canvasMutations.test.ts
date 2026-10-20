import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore'
import { orderMovedIds, type CanvasMutationEnvelope } from './canvasMutations'

function image(id: string, x = 10) {
  return {
    id,
    kind: 'image' as const,
    x,
    y: 20,
    w: 300,
    h: 200,
    src: `/media/${id}.png`,
  }
}

test('semantic order выделяет перемещённый объект, сохраняя порядок остальных', () => {
  assert.deepEqual(orderMovedIds(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']), ['a'])
  assert.deepEqual(orderMovedIds(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), ['d'])
  const moved = orderMovedIds(['a', 'b', 'c'], ['b', 'a', 'c'])
  assert.equal(moved.length, 1)
})

test('локальное добавление испускает ровно одну mutation с inverse', () => {
  const store = new CanvasStore()
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.addItem(image('item_1'))

  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    origin: 'local',
    mutation: { type: 'item.add', objectId: 'item_1', payload: image('item_1') },
    inverse: { type: 'item.delete', objectId: 'item_1', payload: {} },
  })
})

test('patch содержит точную обратную операцию', () => {
  const store = new CanvasStore()
  store.addItem(image('item_1'))
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.updateItem('item_1', { x: 90, name: 'Новая версия' })

  assert.deepEqual(events, [{
    origin: 'local',
    mutation: {
      type: 'item.patch', objectId: 'item_1',
      payload: { values: { x: 90, name: 'Новая версия' }, unset: [] },
    },
    inverse: {
      type: 'item.patch', objectId: 'item_1',
      payload: { values: { x: 10 }, unset: ['name'] },
    },
  }])
})

test('remote apply меняет документ, но не публикует echo', () => {
  const store = new CanvasStore()
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.applyRemote({ type: 'item.add', objectId: 'remote_1', payload: image('remote_1', 50) })

  assert.equal(store.getItem('remote_1')?.x, 50)
  assert.deepEqual(events, [])
})

test('массовое перемещение публикуется одной транзакцией', () => {
  const store = new CanvasStore()
  store.addItem(image('one'))
  store.addItem(image('two', 400))
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.updatePositions([
    { id: 'one', x: 100, y: 120 },
    { id: 'two', x: 490, y: 120 },
  ])

  assert.equal(events.length, 1)
  assert.equal(events[0]?.batch?.length, 2)
  assert.deepEqual(events[0]?.batch?.map((entry) => entry.mutation.objectId), ['one', 'two'])
})

test('удалённая транзакция уведомляет контент один раз', () => {
  const store = new CanvasStore()
  let notifications = 0
  store.subscribeContent(() => { notifications += 1 })

  store.applyRemoteBatch([
    { type: 'item.add', objectId: 'one', payload: image('one') },
    { type: 'item.add', objectId: 'two', payload: image('two', 400) },
  ])

  assert.equal(notifications, 1)
  assert.deepEqual(store.getItems().map((item) => item.id), ['one', 'two'])
})

test('камера, selection и loadDoc не испускают shared mutation', () => {
  const store = new CanvasStore()
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.setCamera({ x: 100, y: 50, scale: 2 })
  store.setSelection(['missing'])
  store.loadDoc({
    version: 1,
    items: [image('loaded')],
    camera: { x: 0, y: 0, scale: 1 },
  })

  assert.deepEqual(events, [])
})

test('удаление, порядок и архив имеют переносимые inverse operations', () => {
  const store = new CanvasStore()
  store.addItem(image('one'))
  store.addItem(image('two', 400))
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.bringToFront(['one'])
  store.removeItems(['two'])
  store.archiveItems(['one'])

  assert.equal(events[0]?.mutation.type, 'item.order')
  assert.deepEqual(events[0]?.inverse, {
    type: 'item.order', objectId: 'board-order', payload: { ids: ['one', 'two'], movedIds: ['one'] },
  })
  assert.deepEqual(events[1], {
    origin: 'local',
    mutation: { type: 'item.delete', objectId: 'two', payload: {} },
    inverse: { type: 'item.add', objectId: 'two', payload: image('two', 400) },
  })
  assert.equal(events[2]?.mutation.type, 'archive.add')
  assert.equal(events[2]?.inverse?.type, 'archive.restore')
})

test('полка и pending публикуют add, patch и delete', () => {
  const store = new CanvasStore()
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.pinAsset({ slot: 0, kind: 'image', src: '/media/pin.png', name: 'Пин' })
  store.unpinAsset(0)
  const [pendingId] = store.addPendingRow(1, { kind: 'image', label: 'Генерация' })
  store.updatePending(pendingId!, { status: 'error', error: 'Сеть' })
  store.dismissPendingById(pendingId!)

  assert.deepEqual(events.map((event) => event.mutation.type), [
    'asset.pin', 'asset.unpin', 'pending.add', 'pending.patch', 'pending.delete',
  ])
  assert.equal(events.every((event) => event.inverse != null), true)
})

test('remote archive и pending mutations сходятся без локальных событий', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, items: [image('item_1')], camera: { x: 0, y: 0, scale: 1 } })
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))
  const archived = { ...image('item_1'), archivedAt: 100 }
  store.applyRemote({ type: 'archive.add', objectId: 'item_1', payload: archived })
  store.applyRemote({
    type: 'pending.add',
    objectId: 'pending_1',
    payload: {
      id: 'pending_1', x: 0, y: 0, w: 100, h: 100, kind: 'image',
      label: 'Ждём', status: 'loading', startedAt: 100,
    },
  })

  assert.equal(store.getItem('item_1'), undefined)
  assert.equal(store.getArchivedItem('item_1')?.archivedAt, 100)
  assert.equal(store.getPending()[0]?.id, 'pending_1')
  assert.deepEqual(events, [])
})

test('pending completion keeps the pending id, selection and current geometry', async () => {
  const store = new CanvasStore()
  const [pendingId] = store.addPendingRow(1, { kind: 'video', label: 'Видео' })
  const jobId = 'job-complete'
  store.setPendingJob(pendingId!, jobId)
  store.setSelection([pendingId!])
  store.updatePositions([{ id: pendingId!, x: 720, y: 460 }])

  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  await store.resolveJob(jobId, {
    url: '/media/result.mp4', mime: 'video/mp4', width: 1600, height: 900,
  }, 'Видео')

  const item = store.getItem(pendingId!)
  assert.equal(item?.id, pendingId)
  assert.equal(item?.x, 720)
  assert.equal(item?.y, 460 + 440 - item!.h)
  assert.deepEqual([...store.getSelectedIds()], [pendingId])
  assert.equal(store.getPending().length, 0)
  assert.deepEqual(events.map((event) => event.mutation.type), ['pending.complete'])
  assert.equal(events[0]?.mutation.objectId, pendingId)
})

test('remote pending completion is atomic and a late completion cannot resurrect a deleted row', () => {
  const store = new CanvasStore()
  const pending = {
    id: 'pending-remote', x: 10, y: 20, w: 440, h: 300, kind: 'image' as const,
    label: 'Модель', status: 'loading' as const, startedAt: 1, jobId: 'job-remote',
  }
  const item = {
    id: pending.id, kind: 'image' as const, x: 10, y: 80, w: 440, h: 240,
    src: '/media/remote.png', sourceJobId: pending.jobId,
  }

  store.applyRemote({ type: 'pending.add', objectId: pending.id, payload: pending })
  store.setSelection([pending.id])
  store.applyRemote({
    type: 'pending.complete',
    objectId: pending.id,
    payload: { pendingId: pending.id, jobId: pending.jobId, item },
  })

  assert.equal(store.getPending().length, 0)
  assert.deepEqual(store.getItem(pending.id), item)
  assert.deepEqual([...store.getSelectedIds()], [pending.id])

  store.applyRemote({ type: 'pending.add', objectId: pending.id, payload: pending })
  store.applyRemote({ type: 'pending.delete', objectId: pending.id, payload: {} })
  store.applyRemote({
    type: 'pending.complete',
    objectId: pending.id,
    payload: { pendingId: pending.id, jobId: pending.jobId, item },
  })
  assert.equal(store.getPending().length, 0)
  assert.equal(store.getItems().length, 1)
  assert.equal(store.getItem(pending.id)?.src, '/media/remote.png')
})

/**
 * ⚠️ Изменение размера группы звало updateItem на каждый объект: трансформер
 * завершает жест по объекту за раз, и каждое завершение становилось своим
 * шагом отмены — и на своей доске, и на сетевой.
 */
test('изменение размера нескольких объектов — одна правка и один шаг отмены', () => {
  const store = new CanvasStore()
  store.addItem(image('one'))
  store.addItem(image('two', 400))
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  store.updateItems([
    { id: 'one', patch: { w: 600, h: 400 } },
    { id: 'two', patch: { x: 700, w: 600, h: 400 } },
    { id: 'missing', patch: { w: 1 } },
  ])

  assert.equal(events.length, 1)
  assert.deepEqual(events[0]?.batch?.map((entry) => entry.mutation.objectId), ['one', 'two'])
  assert.equal(store.getItem('two')?.x, 700)
  store.undo()
  assert.equal(store.getItem('one')?.w, 300)
  assert.equal(store.getItem('two')?.w, 300, 'одним Ctrl+Z возвращаются обе')
  assert.equal(store.getItem('two')?.x, 400)
})
