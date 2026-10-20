import assert from 'node:assert/strict'
import test from 'node:test'
import { api, ApiError } from '../api'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { LanTabletRuntime } from './lanRuntime'

test('LAN board forwards a save conflict to the tablet recovery surface', async () => {
  Object.assign(globalThis, {
    window: { setTimeout, clearTimeout },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  })
  const previousLoad = api.loadProject
  const previousSave = api.saveProject
  const document = {
    version: 1 as const,
    items: [{ id: 'seed', kind: 'text' as const, text: 'до', x: 0, y: 0, w: 100, h: 40 }],
    camera: { x: 0, y: 0, scale: 1 },
    assets: [],
    archive: [],
    pending: [],
  }
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  conflict.details = {
    serverRevision: 3,
    recoveryProject: { id: 'conflict-safe', name: 'Моя копия', revision: 0 },
  }
  const states: string[] = []
  const conflicts: Array<{ status: string }> = []

  api.loadProject = async () => ({ snapshot: document, revision: 1 })
  api.saveProject = async () => { throw conflict }
  try {
    const store = new CanvasStore()
    const runtime = new LanTabletRuntime()
    const session = await runtime.openBoard(
      'board-1',
      store,
      (state) => states.push(state),
      true,
      undefined,
      (value) => conflicts.push(value),
    )
    store.updateItem('seed', { text: 'локальная правка' })

    await assert.rejects(() => session.flushAndWait(), /conflict/u)
    assert.ok(states.includes('conflict-saving'))
    assert.ok(states.includes('conflict'))
    assert.equal(conflicts.at(-1)?.status, 'saved')
    assert.deepEqual(store.getItems().map((item) => item.text), ['локальная правка'])
    await session.dispose()
  } finally {
    api.loadProject = previousLoad
    api.saveProject = previousSave
  }
})
