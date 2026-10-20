import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore.js'
import type { BoardCollaborationPort, BoardCollaborationSnapshot } from '../collaboration/types.js'

function item(id: string, x = 0, y = 0) {
  return { id, kind: 'image' as const, x, y, w: 100, h: 60, src: `/media/${id}.png`, mime: 'image/png' }
}

function collaboration(canMutate: boolean): BoardCollaborationPort {
  const snapshot: BoardCollaborationSnapshot = {
    state: 'ready',
    selfSessionId: 'self',
    ownedIds: [],
    requestedIds: [],
    conflicts: [],
    participants: [],
    locks: [],
    previews: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    requestSelection: async () => canMutate,
    canMutate: () => canMutate,
    withSelection: async (ids, work) => {
      if (ids.length > 0 && !canMutate) return false
      await work()
      return true
    },
    setCursor: () => undefined,
    setPreview: () => undefined,
  }
}

test('arrange mutation is visible before the local batch listener and undoes as one step', () => {
  const store = new CanvasStore()
  const first = store.addItem(item('first', 0, 0))
  const second = store.addItem(item('second', 320, 240))
  const before = store.getItems().map(({ id, x, y }) => ({ id, x, y }))
  const events: Array<{ batch?: readonly unknown[] }> = []
  let sawLocalState = false
  store.subscribeMutations((event) => {
    events.push(event)
    sawLocalState = store.getItem(first)!.y !== before[0]!.y || store.getItem(second)!.y !== before[1]!.y
  })

  store.arrangeInColumn([first, second], { gap: 24 })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.batch?.length, 2)
  assert.equal(sawLocalState, true)
  assert.notDeepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)

  store.undo()
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)
})

test('blocked collaboration prevents alignment and emits no local mutation', () => {
  const store = new CanvasStore()
  const first = store.addItem(item('first', 0, 0))
  const second = store.addItem(item('second', 320, 240))
  store.setCollaboration(collaboration(false))
  const before = store.getItems().map(({ id, x, y }) => ({ id, x, y }))
  const events: unknown[] = []
  store.subscribeMutations((event) => events.push(event))

  store.alignSelection([first, second], 'left')

  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)
  assert.equal(events.length, 0)
})

test('repeated alignment previews compose while durable state stays at the original snapshot', () => {
  const store = new CanvasStore()
  const first = store.addItem(item('first', 40, 80))
  const second = store.addItem(item('second', 320, 240))
  const before = store.getItems().map(({ id, x, y }) => ({ id, x, y }))
  store.setSelection([first, second])

  store.previewAlignSelection([first, second], 'left')
  const leftPreview = store.getRenderableSelectedItems()
  assert.equal(leftPreview[1]!.x, leftPreview[0]!.x)
  store.previewAlignSelection([first, second], 'top')
  const combinedPreview = store.getRenderableSelectedItems()
  assert.equal(combinedPreview[1]!.x, leftPreview[1]!.x, 'Top keeps the preceding Left alignment')
  assert.equal(combinedPreview[1]!.y, combinedPreview[0]!.y)
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)

  store.finalizeArrangePreview()
  assert.equal(store.canUndo(), true)
  store.undo()
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)
})

test('a peer position update is preserved when the arrange draft closes', () => {
  const store = new CanvasStore()
  const first = store.addItem(item('first', 0, 0))
  const second = store.addItem(item('second', 320, 240))
  store.setSelection([first, second])
  store.previewArrangeInRow([first, second], { gap: 24 })
  store.applyRemote({
    type: 'item.patch',
    objectId: second,
    payload: { values: { x: 900 }, unset: [] },
  })
  store.finalizeArrangePreview()
  assert.equal(store.getItem(second)?.x, 900)
})

test('finalizing an arrange draft twice records one step and redo restores it', () => {
  const store = new CanvasStore()
  const first = store.addItem(item('first', 0, 0))
  const second = store.addItem(item('second', 300, 180))
  store.setSelection([first, second])
  const events: unknown[] = []
  store.subscribeMutations((event) => events.push(event))
  store.previewArrangeInRow([first, second], { gap: 24 })
  assert.equal(store.finalizeArrangePreview(), true)
  assert.equal(store.finalizeArrangePreview(), false)
  assert.equal(events.length, 1)
  const arranged = store.getItems().map(({ id, x, y }) => ({ id, x, y }))
  assert.equal(store.undo(), true)
  assert.equal(store.redo(), undefined)
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), arranged)
})

test('permission loss while previewing discards the draft without history or mutation', () => {
  let permitted = true
  const store = new CanvasStore()
  const first = 'first'
  const second = 'second'
  store.loadDoc({ ...store.toDoc(), items: [item(first, 0, 0), item(second, 300, 180)] })
  store.setCollaboration({
    ...collaboration(true),
    canMutate: () => permitted,
    withSelection: async (_ids, work) => { if (!permitted) return false; await work(); return true },
  })
  store.setSelection([first, second])
  const before = store.getItems().map(({ id, x, y }) => ({ id, x, y }))
  const events: unknown[] = []
  store.subscribeMutations((event) => events.push(event))
  store.previewArrangeInRow([first, second], { gap: 24 })
  permitted = false
  assert.equal(store.finalizeArrangePreview(), false)
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id, x, y })), before)
  assert.equal(store.canUndo(), false)
  assert.equal(events.length, 0)
})
