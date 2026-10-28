import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../api.js'
import { CanvasStore } from './konva/canvasStore.js'
import type { CanvasDoc } from './konva/types.js'
import type { ProjectConflictSnapshot } from './projectConflict.js'
import {
  initProjectSync,
  type ProjectLoadState,
  type ProjectSyncDeps,
  type ProjectSyncHandle,
} from './projectSync.js'
import { createProjectRecoveryStorage, type ProjectRecoveryStorage } from './projectRecoveryStorage.js'
import { getSaveStatus, setSaveStatus } from './saveStatusBus.js'

const CONFLICT_KEY = '9b2ca32f-c155-4c5e-b5db-8273070710de'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await tick()
  return done
}

function durableStorage(
  backing: Map<string, string>,
  hooks: { onSet?(): void } = {},
): Storage {
  return {
    get length() { return backing.size },
    clear() { backing.clear() },
    getItem(key) { return backing.get(key) ?? null },
    key(index) { return [...backing.keys()][index] ?? null },
    removeItem(key) { backing.delete(key) },
    setItem(key, value) { hooks.onSet?.(); backing.set(key, value) },
  }
}

function fixture(
  saveProject: ProjectSyncDeps['saveProject'],
  recoveryStorage?: ProjectRecoveryStorage,
) {
  const activeRecoveryStorage = recoveryStorage ?? createProjectRecoveryStorage(durableStorage(new Map()))
  const timers: Array<() => void> = []
  const deps: ProjectSyncDeps = {
    loadProject: async () => ({ snapshot: null, revision: 1 }),
    saveProject,
    schedule: (callback) => {
      timers.push(callback)
      return callback
    },
    unschedule: (timer) => {
      const index = timers.indexOf(timer as () => void)
      if (index >= 0) timers.splice(index, 1)
    },
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => CONFLICT_KEY,
    recoveryStorage: activeRecoveryStorage,
  }
  return { store: new CanvasStore(), deps, timers }
}

async function readyHandle(
  saveProject: ProjectSyncDeps['saveProject'],
): Promise<{ store: CanvasStore; handle: ProjectSyncHandle; timers: Array<() => void> }> {
  const f = fixture(saveProject)
  const handle = await initProjectSync(f.store, 'board-1', undefined, undefined, f.deps)
  return { store: f.store, handle, timers: f.timers }
}

test('flushAndWait ждёт сохранения снимка с целевой мутацией', async () => {
  const save = deferred<{ ok: boolean; revision: number }>()
  const { store, handle } = await readyHandle(async () => save.promise)
  store.placeText('правка')
  const receipt = handle.flushAndWait()
  assert.equal(await settled(receipt), false)
  save.resolve({ ok: true, revision: 2 })
  assert.deepEqual(await receipt, { revision: 2 })
  await handle.dispose()
})

test('локальная нарезка сохраняет все клипы при немедленном выходе и повторном открытии доски', async () => {
  const source = { id: 'original', kind: 'video' as const, src: '/media/source.mp4',
    mime: 'video/mp4', name: 'source', x: 0, y: 0, w: 160, h: 90 }
  let persisted: CanvasDoc = { version: 1, items: [source], camera: { x: 0, y: 0, scale: 1 }, assets: [], archive: [] }
  let revision = 1
  const open = async () => {
    const f = fixture(async (_id, snapshot) => {
      persisted = structuredClone(snapshot)
      return { ok: true, revision: ++revision }
    })
    f.deps.loadProject = async () => ({ snapshot: structuredClone(persisted), revision })
    const handle = await initProjectSync(f.store, 'local-video', undefined, undefined, f.deps)
    return { store: f.store, handle }
  }
  const first = await open()
  const ids = first.store.placeVideoPieces(source, [
    { url: '/media/part-1.mp4', mime: 'video/mp4', duration: 2 },
    { url: '/media/part-2.mp4', mime: 'video/mp4', duration: 3 },
  ])
  // Не ждём debounce автосохранения: выход обязан дописать оба новых клипа.
  await first.handle.dispose()
  const reopened = await open()
  assert.deepEqual(reopened.store.getItems().map(item => item.id), ['original', ...ids])
  assert.equal(reopened.store.getItem(ids[0]!)?.src, '/media/part-1.mp4')
  assert.equal(reopened.store.getItem(ids[1]!)?.src, '/media/part-2.mp4')
  await reopened.handle.dispose()
})

test('старый in-flight save не закрывает waiter более поздней мутации', async () => {
  const first = deferred<{ ok: boolean; revision: number }>()
  const second = deferred<{ ok: boolean; revision: number }>()
  let saves = 0
  const { store, handle } = await readyHandle(async () => (++saves === 1 ? first.promise : second.promise))
  store.placeText('первая')
  const firstReceipt = handle.flushAndWait()
  store.placeText('вторая')
  const secondReceipt = handle.flushAndWait()
  first.resolve({ ok: true, revision: 2 })
  assert.deepEqual(await firstReceipt, { revision: 2 })
  assert.equal(await settled(secondReceipt), false)
  second.resolve({ ok: true, revision: 3 })
  assert.deepEqual(await secondReceipt, { revision: 3 })
  await handle.dispose()
})

test('все сохранения одной вкладки используют один конфликтный ключ', async () => {
  const keys: Array<string | undefined> = []
  const { store, handle } = await readyHandle(async (_projectId, _snapshot, revision, conflictKey) => {
    keys.push(conflictKey)
    return { ok: true, revision: revision + 1 }
  })

  store.placeText('первая')
  await handle.flushAndWait()
  store.placeText('вторая')
  await handle.flushAndWait()

  assert.deepEqual(keys, [CONFLICT_KEY, CONFLICT_KEY])
  await handle.dispose()
})

test('invalid snapshot keeps durable JSON and can be repaired without a permanent lock', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const states: ProjectLoadState[] = []
  const conflicts: Array<ProjectConflictSnapshot | null> = []
  const invalid = {
    version: 1 as const,
    items: [{ id: 'cloud-ref', kind: 'image' as const, x: 0, y: 0, w: 100, h: 100, src: '/api/cloud-assets/assets/ast_missing' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  let saves = 0
  const f = fixture(async (_projectId, snapshot, revision) => {
    saves++
    assert.deepEqual(snapshot.items, [], 'после удаления проблемного объекта сохраняется отремонтированный снимок')
    return { ok: true, revision: revision + 1 }
  }, recoveryStorage)
  f.deps.loadProject = async () => ({ snapshot: invalid, revision: 4 })
  const handle = await initProjectSync(
    f.store,
    'board-invalid',
    (state) => states.push(state),
    (conflict) => conflicts.push(conflict),
    f.deps,
  )

  assert.equal(conflicts.at(-1)?.reason, 'invalid-snapshot')
  assert.ok(recoveryStorage.load('board-invalid'), 'JSON-копия переживает закрытие вкладки')
  assert.equal(f.store.getItems()[0]?.src, '/api/cloud-assets/assets/ast_missing')

  handle.resumeInvalidSnapshot()
  f.store.removeItems(['cloud-ref'])
  assert.deepEqual(await handle.flushAndWait(), { revision: 5 })
  assert.equal(saves, 1)
  assert.equal(conflicts.at(-1), null, 'после ремонта баннер конфликта снимается')
  assert.equal(states.at(-1), 'ready')
  assert.equal(recoveryStorage.load('board-invalid'), null, 'JSON удаляется только после подтверждённого save')
  await handle.dispose()
})

test('server ENOENT metadata turns a local /media snapshot into an explicit recovery state', async () => {
  const f = fixture(async () => ({ ok: true, revision: 2 }))
  f.deps.loadProject = async () => ({
    snapshot: {
      version: 1,
      items: [{ id: 'missing', kind: 'image', x: 0, y: 0, w: 10, h: 10, src: '/media/missing.png' }],
      camera: { x: 0, y: 0, scale: 1 },
    },
    revision: 1,
    missingMedia: ['/media/missing.png'],
  })
  const conflicts: Array<ProjectConflictSnapshot | null> = []
  const handle = await initProjectSync(f.store, 'board-enoent', undefined, (value) => conflicts.push(value), f.deps)
  assert.equal(conflicts.at(-1)?.reason, 'invalid-snapshot')
  assert.match(conflicts.at(-1)?.local.items[0]?.src ?? '', /missing\.png/)
  assert.equal(f.store.getItems()[0]?.src, '/media/missing.png')
  handle.resumeInvalidSnapshot()
  f.store.removeItems(['missing'])
  assert.deepEqual(await handle.flushAndWait(), { revision: 2 })
  await handle.dispose()
})

test('временная ошибка оставляет waiter в ожидании, повтор его завершает', async () => {
  let saves = 0
  const { store, handle, timers } = await readyHandle(async () => {
    saves++
    if (saves === 1) throw new Error('сеть')
    return { ok: true, revision: 2 }
  })
  store.placeText('правка')
  const receipt = handle.flushAndWait()
  await tick()
  assert.equal(await settled(receipt), false)
  assert.equal(timers.length, 1)
  timers.shift()!()
  assert.deepEqual(await receipt, { revision: 2 })
  await handle.dispose()
})

test('конфликт дописывает изменения из in-flight окна в сохранённую копию', async () => {
  const firstSave = deferred<{ ok: boolean; revision: number }>()
  const states: string[] = []
  const conflicts: ProjectConflictSnapshot[] = []
  const saves: Array<{ projectId: string; snapshot: CanvasDoc; conflictKey?: string }> = []
  const f = fixture(async (projectId, snapshot, _revision, conflictKey) => {
    saves.push({ projectId, snapshot, conflictKey })
    if (saves.length === 1) return firstSave.promise
    return { ok: true, revision: 1 }
  })
  const handle = await initProjectSync(
    f.store,
    'board-1',
    (state) => states.push(state),
    (conflict) => conflicts.push(conflict),
    f.deps,
  )

  f.store.placeText('первая')
  const receipt = handle.flushAndWait()
  f.store.placeText('вторая')
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  conflict.details = {
    serverRevision: 3,
    recoveryProject: { id: `conflict-${CONFLICT_KEY}`, name: 'Моя копия', revision: 0 },
  }
  firstSave.reject(conflict)

  await assert.rejects(() => receipt, /conflict/)
  await tick()
  assert.equal(saves.length, 2)
  assert.equal(saves[1].projectId, `conflict-${CONFLICT_KEY}`)
  assert.equal(saves[1].conflictKey, CONFLICT_KEY)
  assert.deepEqual(
    saves[1].snapshot.items.filter((item) => item.kind === 'text').map((item) => item.text),
    ['первая', 'вторая'],
  )
  assert.ok(states.includes('conflict-saving'))
  assert.equal(conflicts.at(-1)?.status, 'saved')
  assert.equal(conflicts.at(-1)?.recoveryProject?.revision, 1)
  await handle.dispose()
})

test('конфликтная копия очищает recovery после изменения камеры в in-flight save', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const firstSave = deferred<{ ok: boolean; revision: number }>()
  const conflicts: ProjectConflictSnapshot[] = []
  let saves = 0
  const f = fixture(async (projectId, snapshot, _revision, conflictKey) => {
    saves++
    if (saves === 1) return firstSave.promise
    assert.equal(projectId, `conflict-${conflictKey}`)
    assert.equal(snapshot.camera.x, 99)
    return { ok: true, revision: 1 }
  }, recoveryStorage)
  const handle = await initProjectSync(
    f.store,
    'board-1',
    undefined,
    (conflict) => conflicts.push(conflict),
    f.deps,
  )

  f.store.placeText('первая')
  const receipt = handle.flushAndWait()
  // Camera changes use the long debounce and therefore do not refresh the
  // durable recovery snapshot while the first save is in flight.
  f.store.setCamera({ x: 99, y: 0, scale: 1 })
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  conflict.details = {
    serverRevision: 3,
    recoveryProject: { id: `conflict-${CONFLICT_KEY}`, name: 'Моя копия', revision: 0 },
  }
  firstSave.reject(conflict)

  await assert.rejects(() => receipt, /conflict/)
  await tick()
  assert.equal(conflicts.at(-1)?.status, 'saved')
  assert.equal(
    recoveryStorage.load('board-1'),
    null,
    'после сохранения актуальной конфликтной копии устаревший recovery не должен вызвать новый конфликт',
  )
  await handle.dispose()
})

test('конфликт не очищает запись другой вкладки при одинаковом времени recovery', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const firstSave = deferred<{ ok: boolean; revision: number }>()
  let saves = 0
  const f = fixture(async (projectId, snapshot, _revision, conflictKey) => {
    saves++
    if (saves === 1) return firstSave.promise
    assert.equal(projectId, `conflict-${conflictKey}`)
    assert.equal(snapshot.camera.x, 99)
    return { ok: true, revision: 1 }
  }, recoveryStorage)
  const conflicts: ProjectConflictSnapshot[] = []
  const handle = await initProjectSync(
    f.store,
    'board-same-timestamp',
    undefined,
    (conflict) => conflicts.push(conflict),
    f.deps,
  )

  f.store.placeText('первая')
  const receipt = handle.flushAndWait()
  f.store.setCamera({ x: 99, y: 0, scale: 1 })
  const ownRecovery = recoveryStorage.load('board-same-timestamp')!
  const otherSnapshot = { ...ownRecovery.snapshot, camera: { x: 777, y: 0, scale: 1 } }
  // Simulate another tab writing during the same millisecond. The timestamp is
  // equal, so ownership must also compare the snapshot that we originally wrote.
  recoveryStorage.save({
    projectId: 'board-same-timestamp',
    snapshot: otherSnapshot,
    revision: ownRecovery.revision,
    updatedAt: ownRecovery.updatedAt,
  })
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  conflict.details = {
    serverRevision: 3,
    recoveryProject: { id: `conflict-${CONFLICT_KEY}`, name: 'Моя копия', revision: 0 },
  }
  firstSave.reject(conflict)

  await assert.rejects(() => receipt, /conflict/)
  await tick()
  assert.equal(conflicts.at(-1)?.status, 'saved')
  assert.deepEqual(recoveryStorage.load('board-same-timestamp')?.snapshot.camera, otherSnapshot.camera)
  await handle.dispose()
})

test('поздняя ошибка другой доски не затирает статус подтверждённой конфликтной копии', async () => {
  setSaveStatus('idle')
  const oldSave = deferred<{ ok: boolean; revision: number }>()
  let oldSaves = 0
  const old = fixture(async () => {
    oldSaves++
    if (oldSaves === 1) return oldSave.promise
    return { ok: true, revision: 2 }
  })
  const oldHandle = await initProjectSync(old.store, 'old-board', undefined, undefined, old.deps)
  old.store.placeText('старая правка')
  oldHandle.flushAndWait()

  const conflicts: ProjectConflictSnapshot[] = []
  let currentSaves = 0
  const current = fixture(async (projectId, _snapshot, _revision, conflictKey) => {
    currentSaves++
    if (currentSaves === 1) {
      const error = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
      error.details = {
        serverRevision: 3,
        recoveryProject: { id: `conflict-${conflictKey}`, name: 'Моя копия', revision: 0 },
      }
      throw error
    }
    assert.equal(projectId, `conflict-${conflictKey}`)
    return { ok: true, revision: 1 }
  })
  const currentHandle = await initProjectSync(
    current.store,
    'current-board',
    undefined,
    (conflict) => conflicts.push(conflict),
    current.deps,
  )
  current.store.placeText('текущая правка')
  await assert.rejects(() => currentHandle.flushAndWait(), /conflict/)
  await tick()
  assert.equal(conflicts.at(-1)?.status, 'saved')
  assert.equal(getSaveStatus(), 'saved')

  // The old board is already superseded, but its in-flight request can still
  // reject during cleanup. That late error must not replace the current board's
  // confirmed status in the global top-bar indicator.
  oldSave.reject(new Error('сеть пропала'))
  await tick()
  assert.equal(getSaveStatus(), 'saved')

  await oldHandle.dispose()
  await currentHandle.dispose()
})

test('неудачную финальную запись конфликтной копии можно повторить', async () => {
  const firstSave = deferred<{ ok: boolean; revision: number }>()
  const conflicts: ProjectConflictSnapshot[] = []
  let saves = 0
  let retryAllowed = false
  const f = fixture(async () => {
    saves++
    if (saves === 1) return firstSave.promise
    if (!retryAllowed) throw new Error('сеть пропала')
    return { ok: true, revision: 2 }
  })
  const handle = await initProjectSync(
    f.store,
    'board-1',
    undefined,
    (conflict) => conflicts.push(conflict),
    f.deps,
  )

  f.store.placeText('первая')
  const receipt = handle.flushAndWait()
  f.store.placeText('вторая')
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  conflict.details = {
    serverRevision: 3,
    recoveryProject: { id: `conflict-${CONFLICT_KEY}`, name: 'Моя копия', revision: 0 },
  }
  firstSave.reject(conflict)

  await assert.rejects(() => receipt, /conflict/)
  await tick()
  assert.equal(conflicts.at(-1)?.status, 'needs-retry')
  assert.ok(f.deps.recoveryStorage!.load('board-1'), 'неподтверждённая копия остаётся в recovery')
  retryAllowed = true
  const recovered = await handle.retryConflictRecovery()
  assert.equal(recovered.status, 'saved')
  assert.equal(recovered.recoveryProject?.revision, 2)
  assert.equal(conflicts.at(-1)?.status, 'saved')
  assert.equal(f.deps.recoveryStorage!.load('board-1'), null, 'подтверждённый повтор очищает recovery')
  await handle.dispose()
})

test('подтверждённая конфликтная копия не вызывает новый конфликт после продолжения с последней версией', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const projectId = 'board-continue-latest'
  const firstKey = 'd8d0f0e1-8a8d-4d69-9c1a-4a9d74d5a111'
  const secondKey = 'd8d0f0e1-8a8d-4d69-9c1a-4a9d74d5a222'
  const serverSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'server', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'серверная ветка' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const saves: Array<{ projectId: string; revision: number }> = []
  let loads = 0
  const conflictFor = (key: string): ApiError => {
    const error = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
    error.details = {
      serverRevision: 2,
      recoveryProject: {
        id: `conflict-${key}`,
        name: 'Моя копия',
        revision: 0,
      },
    }
    return error
  }
  const deps: ProjectSyncDeps = {
    loadProject: async (id) => {
      assert.equal(id, projectId)
      loads++
      return { snapshot: serverSnapshot, revision: loads === 1 ? 1 : 2 }
    },
    saveProject: async (id, _snapshot, revision, key) => {
      saves.push({ projectId: id, revision })
      if (id === projectId && revision !== 2) throw conflictFor(key)
      throw new Error(`неожиданная запись ${id}`)
    },
    schedule: (callback) => callback,
    unschedule: () => {},
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => loads === 0 ? firstKey : secondKey,
    recoveryStorage,
  }

  const firstStates: ProjectLoadState[] = []
  const firstStore = new CanvasStore()
  const firstHandle = await initProjectSync(
    firstStore,
    projectId,
    (state) => firstStates.push(state),
    undefined,
    deps,
  )
  firstStore.placeText('локальная ветка')
  await assert.rejects(() => firstHandle.flushAndWait(), /conflict/)
  await firstHandle.dispose()

  assert.equal(
    recoveryStorage.load(projectId),
    null,
    'после подтверждённого сохранения копии recovery должен быть очищен',
  )

  const secondStates: ProjectLoadState[] = []
  const secondHandle = await initProjectSync(
    new CanvasStore(),
    projectId,
    (state) => secondStates.push(state),
    undefined,
    deps,
  )
  assert.deepEqual(secondStates, ['loading', 'ready'])
  assert.deepEqual(saves, [{ projectId, revision: 1 }])
  await secondHandle.dispose()
  assert.deepEqual(firstStates, ['loading', 'ready', 'conflict-saving', 'conflict'])
})

test('dispose дописывает мутацию и закрывает покрытый waiter', async () => {
  const { store, handle } = await readyHandle(async () => ({ ok: true, revision: 2 }))
  store.placeText('правка перед уходом')
  const receipt = handle.flushAndWait()
  await handle.dispose()
  assert.deepEqual(await receipt, { revision: 2 })
})

test('ошибка загрузки возвращает отказной handle и не сохраняет пустой store', async () => {
  let saves = 0
  const deps: ProjectSyncDeps = {
    loadProject: async () => { throw new Error('load failed') },
    saveProject: async () => {
      saves++
      return { ok: true, revision: 1 }
    },
    schedule: () => 1,
    unschedule: () => {},
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => CONFLICT_KEY,
  }
  const handle = await initProjectSync(new CanvasStore(), 'board-1', undefined, undefined, deps)
  await assert.rejects(() => handle.flushAndWait(), /load failed/)
  await handle.dispose()
  assert.equal(saves, 0)
})

test('повтор после неудачного чтения сохраняет прежнюю доску до успешной загрузки', async () => {
  let saves = 0
  const previous: CanvasDoc = {
    version: 1,
    items: [{ id: 'previous', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'сохранённая доска' }],
    camera: { x: 12, y: 24, scale: 1.5 },
  }
  const loaded: CanvasDoc = {
    version: 1,
    items: [{ id: 'loaded', kind: 'text', x: 10, y: 20, w: 100, h: 40, text: 'повтор удался' }],
    camera: { x: 50, y: 60, scale: 0.75 },
  }
  const store = new CanvasStore()
  store.loadDoc(previous)
  const base = fixture(async () => {
    saves++
    return { ok: true, revision: 2 }
  })
  base.deps.loadProject = async () => { throw new Error('временная сеть') }

  const failed = await initProjectSync(store, 'board-retry', undefined, undefined, base.deps)
  assert.deepEqual(store.getItems(), previous.items, 'ошибка чтения не должна очистить прежний документ')
  assert.deepEqual(store.getCamera(), previous.camera)
  assert.equal(saves, 0, 'до успешного чтения автосейв не должен стартовать')
  await failed.dispose()

  const retryDeps = { ...base.deps, loadProject: async () => ({ snapshot: loaded, revision: 2 }) }
  const recovered = await initProjectSync(store, 'board-retry', undefined, undefined, retryDeps)
  assert.deepEqual(store.getItems(), loaded.items)
  assert.deepEqual(store.getCamera(), loaded.camera)
  assert.equal(saves, 0, 'сама повторная загрузка не создаёт запись')
  await recovered.dispose()
})

test('ответ устаревшей попытки не заменяет документ текущей попытки', async () => {
  const oldLoad = deferred<{ snapshot: CanvasDoc; revision: number }>()
  const currentLoad = deferred<{ snapshot: CanvasDoc; revision: number }>()
  const oldStates: ProjectLoadState[] = []
  const currentStates: ProjectLoadState[] = []
  const store = new CanvasStore()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(new Map()))
  const oldSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'old', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'старая доска' }],
    camera: { x: 1, y: 2, scale: 1 },
  }
  const currentSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'current', kind: 'text', x: 10, y: 20, w: 100, h: 40, text: 'текущая доска' }],
    camera: { x: 30, y: 40, scale: 1.25 },
  }
  const deps: ProjectSyncDeps = {
    loadProject: async (projectId) => projectId === 'old-board' ? oldLoad.promise : currentLoad.promise,
    saveProject: async () => ({ ok: true, revision: 1 }),
    schedule: (callback) => callback,
    unschedule: () => {},
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => CONFLICT_KEY,
    recoveryStorage,
  }

  const staleAttempt = initProjectSync(store, 'old-board', (state) => oldStates.push(state), undefined, deps)
  const currentAttempt = initProjectSync(store, 'current-board', (state) => currentStates.push(state), undefined, deps)
  currentLoad.resolve({ snapshot: currentSnapshot, revision: 2 })
  const currentHandle = await currentAttempt
  assert.deepEqual(store.getItems(), currentSnapshot.items)
  assert.deepEqual(store.getCamera(), currentSnapshot.camera)
  assert.deepEqual(currentStates, ['loading', 'ready'])

  oldLoad.resolve({ snapshot: oldSnapshot, revision: 1 })
  const staleHandle = await staleAttempt
  assert.deepEqual(store.getItems(), currentSnapshot.items, 'поздний ответ не должен откатить текущую доску')
  assert.deepEqual(store.getCamera(), currentSnapshot.camera)
  assert.deepEqual(oldStates, ['loading'], 'устаревшая попытка не сообщает ложный ready/error')

  await staleHandle.dispose()
  await currentHandle.dispose()
})

test('ошибка записи устаревшей попытки закрывает её receipt', async () => {
  const oldSave = deferred<{ ok: boolean; revision: number }>()
  const oldSnapshot: CanvasDoc = {
    version: 1,
    items: [],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const currentSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'current', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'текущая доска' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const store = new CanvasStore()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(new Map()))
  const deps: ProjectSyncDeps = {
    loadProject: async (projectId) => ({
      snapshot: projectId === 'old-board' ? oldSnapshot : currentSnapshot,
      revision: 1,
    }),
    saveProject: async (projectId) => {
      if (projectId === 'old-board') return oldSave.promise
      return { ok: true, revision: 2 }
    },
    schedule: (callback) => callback,
    unschedule: () => {},
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => CONFLICT_KEY,
    recoveryStorage,
  }

  const oldHandle = await initProjectSync(store, 'old-board', undefined, undefined, deps)
  store.placeText('несохранённая правка')
  const receipt = oldHandle.flushAndWait()
  await tick()

  const currentHandle = await initProjectSync(store, 'current-board', undefined, undefined, deps)
  oldSave.reject(new Error('сеть пропала'))
  await assert.rejects(() => receipt, /Board load is stale/)

  await oldHandle.dispose()
  await currentHandle.dispose()
})

test('неудачная финальная запись сохраняет снимок для следующего открытия доски', async () => {
  const backing = new Map<string, string>()
  const saves: CanvasDoc[] = []
  let allowRecovery = false
  const firstStorage = createProjectRecoveryStorage(durableStorage(backing))
  const f = fixture(async (_projectId, snapshot) => {
    saves.push(snapshot)
    if (!allowRecovery) throw new Error('сеть пропала')
    return { ok: true, revision: 2 }
  }, firstStorage)
  const handle = await initProjectSync(f.store, 'board-recovery-1', undefined, undefined, f.deps)
  f.store.placeText('правка перед обрывом')
  await assert.rejects(() => handle.dispose(), /Failed to save the board after several attempts/u)
  assert.equal(backing.size, 1, 'снимок записан в durable storage до ухода со страницы')

  allowRecovery = true
  const reopened = new CanvasStore()
  const reopenedDeps = { ...f.deps, recoveryStorage: createProjectRecoveryStorage(durableStorage(backing)) }
  const reopenedHandle = await initProjectSync(reopened, 'board-recovery-1', undefined, undefined, reopenedDeps)

  assert.equal(saves.length, 6)
  assert.deepEqual(reopened.getItems().filter((item) => item.kind === 'text').map((item) => item.text), ['правка перед обрывом'])
  assert.equal(backing.size, 0, 'recovery очищается только после успешного server save')
  await reopenedHandle.dispose()

  const openedAgain = new CanvasStore()
  const openedAgainDeps = { ...f.deps, recoveryStorage: createProjectRecoveryStorage(durableStorage(backing)) }
  const openedAgainHandle = await initProjectSync(openedAgain, 'board-recovery-1', undefined, undefined, openedAgainDeps)
  assert.equal(saves.length, 6, 'успешно восстановленный снимок больше не отправляется повторно')
  await openedAgainHandle.dispose()
})

test('storage failure оставляет recovery в памяти и не маскируется под durable save', async () => {
  const storage: Storage = {
    get length() { return 0 },
    clear() {},
    getItem() { throw new Error('storage blocked') },
    key() { return null },
    removeItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage blocked') },
  }
  const recoveryStorage = createProjectRecoveryStorage(storage)
  const f = fixture(async () => { throw new Error('сеть пропала') }, recoveryStorage)
  const handle = await initProjectSync(f.store, 'board-memory-recovery', undefined, undefined, f.deps)
  f.store.placeText('правка только в памяти')

  const stored = recoveryStorage.load('board-memory-recovery')
  assert.equal(stored?.snapshot.items[0]?.text, 'правка только в памяти')
  assert.equal(recoveryStorage.save({
    projectId: 'board-memory-recovery', snapshot: stored!.snapshot, revision: 1, updatedAt: 1,
  }).durable, false)
  await assert.rejects(() => handle.dispose(), /Failed to save the board after several attempts/u)
})

test('memory recovery wins over an older durable record after quota failure', () => {
  const backing = new Map<string, string>()
  let failWrites = false
  const storage = durableStorage(backing, {
    onSet: () => {
      if (failWrites) throw new Error('quota')
    },
  })
  const recoveryStorage = createProjectRecoveryStorage(storage)
  const snapshot = (text: string): CanvasDoc => ({
    version: 1,
    items: [{ id: text, kind: 'text', x: 0, y: 0, w: 100, h: 40, text }],
    camera: { x: 0, y: 0, scale: 1 },
  })

  assert.equal(recoveryStorage.save({
    projectId: 'board-quota', snapshot: snapshot('durable A'), revision: 1, updatedAt: 1,
  }).durable, true)
  failWrites = true
  assert.equal(recoveryStorage.save({
    projectId: 'board-quota', snapshot: snapshot('memory B'), revision: 1, updatedAt: 2,
  }).durable, false)
  assert.equal(recoveryStorage.load('board-quota')?.snapshot.items[0]?.text, 'memory B')
})

test('camera debounce avoids recovery writes on every tick but persists before save', async () => {
  const backing = new Map<string, string>()
  let writes = 0
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing, { onSet: () => { writes += 1 } }))
  let saves = 0
  const f = fixture(async () => ({ ok: true, revision: ++saves + 1 }), recoveryStorage)
  const handle = await initProjectSync(f.store, 'board-camera', undefined, undefined, f.deps)

  f.store.setCamera({ x: 1, y: 0, scale: 1 })
  f.store.setCamera({ x: 2, y: 0, scale: 1 })
  assert.equal(writes, 0)
  assert.equal(f.timers.length, 1)
  f.timers.shift()!()
  await tick()

  assert.equal(writes, 1)
  assert.equal(saves, 1)
  await handle.dispose()
})

test('recovery с устаревшей revision не перезаписывает более новую серверную доску', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const localSnapshot: CanvasDoc = {
    version: 1,
    items: [{
      id: 'local', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'локальная правка',
    }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const serverSnapshot: CanvasDoc = {
    version: 1,
    items: [{
      id: 'server', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'новая правка сервера',
    }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  recoveryStorage.save({ projectId: 'board-revision-safe', snapshot: localSnapshot, revision: 1, updatedAt: 1 })
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  const f = fixture(async (_projectId, _snapshot, revision) => {
    assert.equal(revision, 1, 'recovery отправляется с revision неудачной попытки')
    throw conflict
  }, recoveryStorage)
  f.deps.loadProject = async () => ({ snapshot: serverSnapshot, revision: 2 })

  const store = new CanvasStore()
  const handle = await initProjectSync(store, 'board-revision-safe', undefined, undefined, f.deps)

  assert.equal(store.getItems()[0]?.text, 'новая правка сервера')
  assert.equal(backing.size, 1, 'конфликт оставляет recovery для явного повторения')
  await assert.rejects(() => handle.dispose(), /Board version conflict/u)
})

test('неудачный bootstrap recovery блокирует новые edits и сохраняет старый snapshot', async () => {
  const backing = new Map<string, string>()
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(backing))
  const localSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'local', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'локальная правка' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const serverSnapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'server', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'серверная правка' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  recoveryStorage.save({ projectId: 'board-bootstrap-conflict', snapshot: localSnapshot, revision: 1, updatedAt: 1 })
  const conflict = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  const states: ProjectLoadState[] = []
  const f = fixture(async () => { throw conflict }, recoveryStorage)
  f.deps.loadProject = async () => ({ snapshot: serverSnapshot, revision: 2 })
  const store = new CanvasStore()
  const handle = await initProjectSync(store, 'board-bootstrap-conflict', (state) => states.push(state), undefined, f.deps)

  assert.ok(states.includes('conflict'))
  store.placeText('новая правка после отказа')
  assert.equal(recoveryStorage.load('board-bootstrap-conflict')?.snapshot.items[0]?.text, 'локальная правка')
  await assert.rejects(() => handle.dispose(), /Board version conflict/u)
})

test('сохранённая при загрузке конфликтная копия не отправляется вновь при следующем входе', async () => {
  const recovery = createProjectRecoveryStorage(durableStorage(new Map()))
  const snapshot: CanvasDoc = { version: 1, items: [], camera: { x: 10, y: 20, scale: 1 } }
  recovery.save({ projectId: 'bootstrap-copy', snapshot, revision: 1, updatedAt: 1 })
  let attempts = 0
  const f = fixture(async () => {
    attempts++
    const error = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
    error.details = { serverRevision: 2, recoveryProject: { id: 'safe-copy', name: 'Копия', revision: 0 } }
    throw error
  }, recovery)
  f.deps.loadProject = async () => ({ snapshot: null, revision: 2 })
  const first = await initProjectSync(f.store, 'bootstrap-copy', undefined, undefined, f.deps)
  await first.dispose()
  const states: ProjectLoadState[] = []
  const second = await initProjectSync(new CanvasStore(), 'bootstrap-copy', state => states.push(state), undefined, f.deps)
  assert.equal(attempts, 1, 'уже сохранённая копия не создаётся повторно')
  assert.equal(states.at(-1), 'ready')
  await second.dispose()
})

test('подтверждение старой конфликтной копии не стирает более свежий recovery другой вкладки', async () => {
  const recovery = createProjectRecoveryStorage(durableStorage(new Map()))
  const old: CanvasDoc = { version: 1, items: [], camera: { x: 10, y: 20, scale: 1 } }
  const newer: CanvasDoc = { ...old, camera: { x: 99, y: 20, scale: 1 } }
  recovery.save({ projectId: 'shared-recovery', snapshot: old, revision: 1, updatedAt: 1 })
  const f = fixture(async () => {
    recovery.save({ projectId: 'shared-recovery', snapshot: newer, revision: 2, updatedAt: 2 })
    const error = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
    error.details = { serverRevision: 2, recoveryProject: { id: 'safe-copy', name: 'Копия', revision: 0 } }
    throw error
  }, recovery)
  const handle = await initProjectSync(f.store, 'shared-recovery', undefined, undefined, f.deps)
  assert.deepEqual(recovery.load('shared-recovery')?.snapshot, newer)
  await handle.dispose()
})

test('успешное bootstrap-восстановление не стирает recovery другой вкладки при одинаковом времени', async () => {
  const backing = new Map<string, string>()
  const recovery = createProjectRecoveryStorage(durableStorage(backing))
  const projectId = 'bootstrap-same-timestamp'
  const old: CanvasDoc = {
    version: 1,
    items: [{ id: 'old', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'старая правка' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const newer: CanvasDoc = {
    version: 1,
    items: [{ id: 'newer', kind: 'text', x: 99, y: 0, w: 100, h: 40, text: 'правка другой вкладки' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  recovery.save({ projectId, snapshot: old, revision: 1, updatedAt: 10 })
  let saves = 0
  const f = fixture(async (_id, _snapshot, revision) => {
    saves++
    assert.equal(revision, 1)
    // Another tab wins the storage slot immediately before this tab clears its
    // confirmed bootstrap recovery. Keep the same timestamp to exercise the
    // snapshot half of the ownership check.
    recovery.save({ projectId, snapshot: newer, revision: 2, updatedAt: 10 })
    return { ok: true, revision: 2 }
  }, recovery)
  f.deps.loadProject = async () => ({ snapshot: { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, revision: 1 })

  const handle = await initProjectSync(new CanvasStore(), projectId, undefined, undefined, f.deps)
  assert.equal(saves, 1)
  assert.deepEqual(recovery.load(projectId)?.snapshot, newer)
  await handle.dispose()
})

test('после перезагрузки несохранённое досылается под прежним ключом вкладки', async () => {
  // Сервер записал правку и упал, не ответив. Вкладка перезагружается и
  // досылает несохранённое со старым номером ревизии. Под прежним ключом
  // сервер узнаёт свои же записи; под новым — видел бы «другую вкладку» и
  // делал конфликтную копию на ровном месте.
  const recoveryStorage = createProjectRecoveryStorage(durableStorage(new Map()))
  const projectId = 'board-reload-after-crash'
  const firstKey = 'd8d0f0e1-8a8d-4d69-9c1a-4a9d74d5b111'
  const secondKey = 'd8d0f0e1-8a8d-4d69-9c1a-4a9d74d5b222'
  const empty: CanvasDoc = { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }
  const saves: Array<{ revision: number; key: string }> = []
  let serverUp = false
  let keys = 0
  const deps: ProjectSyncDeps = {
    loadProject: async () => ({ snapshot: empty, revision: 1 }),
    saveProject: async (_id, _snapshot, revision, key) => {
      saves.push({ revision, key })
      if (!serverUp) throw new Error('сервер недоступен')
      return { ok: true, revision: 3 }
    },
    schedule: (callback) => callback,
    unschedule: () => {},
    sleep: async () => {},
    onHidden: () => () => {},
    createConflictKey: () => (keys++ === 0 ? firstKey : secondKey),
    recoveryStorage,
  }

  const firstStore = new CanvasStore()
  const first = await initProjectSync(firstStore, projectId, undefined, undefined, deps)
  firstStore.placeText('несохранённое')
  await assert.rejects(() => first.dispose())
  assert.equal(recoveryStorage.load(projectId)?.conflictKey, firstKey, 'ключ живёт рядом со снимком')

  serverUp = true
  saves.length = 0
  const second = await initProjectSync(new CanvasStore(), projectId, undefined, undefined, deps)
  assert.deepEqual(saves[0], { revision: 1, key: firstKey })
  await second.dispose()
})
