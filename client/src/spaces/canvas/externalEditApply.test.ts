import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicEditSession } from '../../api.js'
import { applyExternalEditSession, deliverExternalEditSession } from './externalEditApply.js'
import { CanvasStore } from './konva/canvasStore.js'
import type { CanvasDoc, CanvasItem } from './konva/types.js'

const probe = async () => ({ width: 1200, height: 800 })

function ready(patch: Partial<PublicEditSession> = {}): PublicEditSession {
  return {
    id: 'session-1', projectId: 'board-1', sourceItemId: 'source-1', sourceName: 'Фото',
    fileName: 'edit-session-1.png', url: '/media/edit-session-1.png', createdAt: 1,
    expiresAt: 999_999, lastMtime: 20, appliedMtime: 10, placedItemId: null,
    state: 'ready', projectName: 'Доска', projectStatus: 'active', ...patch,
  }
}

function image(patch: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'source-1', kind: 'image', x: 100, y: 120, w: 320, h: 240,
    src: '/media/source.png', mime: 'image/png', naturalWidth: 800, naturalHeight: 600,
    name: 'Фото', ...patch,
  }
}

function storeWith(items: CanvasItem[]): CanvasStore {
  const store = new CanvasStore()
  const doc: CanvasDoc = { version: 1, items, camera: { x: 0, y: 0, scale: 1 } }
  store.loadDoc(doc)
  return store
}

test('save-before-ack retry recognizes the exact tagged version without reloading it', async () => {
  const tagged = image({
    id: 'placed-1',
    src: '/media/edit-session-1.png?v=20',
    externalEditSessionId: 'session-1',
  })
  const store = storeWith([tagged])
  const result = await applyExternalEditSession(
    store,
    ready({ placedItemId: null }),
    async () => { throw new Error('the already-saved image must not be probed again') },
  )
  assert.deepEqual(result, { placedItemId: 'placed-1', outcome: 'updated' })
  assert.equal(store.undo(), false)
})

test('повтор той же версии обновляет один tagged item без дубля', async () => {
  const store = storeWith([image()])
  const first = await applyExternalEditSession(store, ready(), probe)
  const second = await applyExternalEditSession(store, ready({ placedItemId: first.placedItemId }), probe)
  assert.equal(store.getItems().filter((item) => item.externalEditSessionId === 'session-1').length, 1)
  assert.equal(second.placedItemId, first.placedItemId)
  assert.equal(second.outcome, 'updated')
})

test('первый результат появляется рядом с исходником', async () => {
  const source = image()
  const store = storeWith([source])
  const result = await applyExternalEditSession(store, ready(), probe)
  const placed = store.getItem(result.placedItemId)!
  assert.equal(result.outcome, 'created')
  assert.ok(placed.x >= source.x + source.w)
  assert.equal(placed.y, source.y)
  assert.equal(placed.externalEditSessionId, 'session-1')
})

test('новая версия обновляет тот же item и сохраняет выбранную ширину', async () => {
  const edited = image({ id: 'placed-1', x: 500, w: 500, h: 500,
    src: '/media/edit-session-1.png?v=20', externalEditSessionId: 'session-1' })
  const store = storeWith([image(), edited])
  const result = await applyExternalEditSession(
    store, ready({ lastMtime: 30, placedItemId: 'placed-1' }),
    async () => ({ width: 2000, height: 1000 }),
  )
  const updated = store.getItem(result.placedItemId)!
  assert.equal(updated.w, 500)
  assert.equal(updated.h, 250)
  assert.equal(updated.src, '/media/edit-session-1.png?v=30')
})

test('удалённый результат создаётся заново с тем же session tag', async () => {
  const store = storeWith([image()])
  const result = await applyExternalEditSession(store, ready({ placedItemId: 'deleted-result', lastMtime: 30 }), probe)
  assert.equal(result.outcome, 'recreated')
  assert.equal(store.getItem(result.placedItemId)?.externalEditSessionId, 'session-1')
})

test('без исходника результат ставится в центр текущего viewport', async () => {
  const store = storeWith([])
  store.setContainerSize(1000, 800)
  store.setCamera({ x: 100, y: 50, scale: 2 })
  const center = store.getViewportCenter()
  const result = await applyExternalEditSession(store, ready(), probe)
  const placed = store.getItem(result.placedItemId)!
  assert.equal(result.outcome, 'source-missing')
  assert.equal(placed.x + placed.w / 2, center.x)
  assert.equal(placed.y + placed.h / 2, center.y)
})

test('устаревший placedItemId не меняет чужой объект', async () => {
  const unrelated = image({ id: 'stale-id', src: '/media/unrelated.png', name: 'Чужая' })
  const store = storeWith([image(), unrelated])
  const result = await applyExternalEditSession(store, ready({ placedItemId: 'stale-id' }), probe)
  assert.equal(store.getItem('stale-id')?.src, '/media/unrelated.png')
  assert.notEqual(result.placedItemId, 'stale-id')
})

test('сохраняет только локальный URL с точным cache-buster mtime', async () => {
  const store = storeWith([image()])
  const result = await applyExternalEditSession(
    store, ready({ url: '/media/edit-session-1.png?old=1', lastMtime: 42 }), probe,
  )
  assert.equal(store.getItem(result.placedItemId)?.src, '/media/edit-session-1.png?v=42')
  await assert.rejects(
    () => applyExternalEditSession(store, ready({ id: 'bad', url: 'https://example.com/a.png' }), probe),
    /local media file/i,
  )
})

test('каждое применение занимает ровно один шаг истории', async () => {
  const store = storeWith([image()])
  const result = await applyExternalEditSession(store, ready(), probe)
  assert.equal(store.undo(), true)
  assert.equal(store.getItem(result.placedItemId), undefined)
  assert.equal(store.undo(), false)

  const tagged = image({ id: 'placed-1', src: '/media/edit-session-1.png?v=20',
    externalEditSessionId: 'session-1' })
  const updateStore = storeWith([image(), tagged])
  await applyExternalEditSession(updateStore, ready({ lastMtime: 30, placedItemId: 'placed-1' }), probe)
  assert.equal(updateStore.undo(), true)
  assert.equal(updateStore.getItem('placed-1')?.src, '/media/edit-session-1.png?v=20')
  assert.equal(updateStore.undo(), false)
})

test('ручной дубль результата становится независимым от сессии', async () => {
  const store = storeWith([image()])
  const result = await applyExternalEditSession(store, ready(), probe)
  store.setSelection([result.placedItemId])
  store.duplicateSelected()
  assert.equal(store.getItems().filter((item) => item.externalEditSessionId === 'session-1').length, 1)
})

test('доставка завершается только после сохранения применённой мутации', async () => {
  const store = storeWith([image()])
  let savedTaggedItem = false
  const delivery = await deliverExternalEditSession(
    store,
    ready(),
    {
      flushAndWait: async () => {
        savedTaggedItem = store.getItems().some((item) => item.externalEditSessionId === 'session-1')
        return { revision: 2 }
      },
      dispose: async () => {},
    },
    probe,
  )
  assert.equal(savedTaggedItem, true)
  assert.equal(delivery.placedItemId, store.getItems().find((item) => item.externalEditSessionId === 'session-1')?.id)
  assert.match(delivery.message, /added next to source/i)
})
