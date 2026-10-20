import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCrop, applyCropInBackground } from './cropApply.js'
import { CanvasStore } from './canvasStore.js'
import type { BoardCollaborationPort } from '../collaboration/types.js'
import type { CanvasItem } from './types.js'

// DOM-порты заменены потому, что Node не предоставляет HTMLImageElement/canvas.
// Проверяется настоящий applyCrop: декодирование → выбор кодека → upload → undo.
for (const mime of ['image/png', 'image/webp', 'image/gif', 'image/avif', 'image/jpeg']) {
  test(`кроп ${mime} сохраняет кодек с alpha, а JPEG остаётся JPEG`, async (t) => {
    class ImageStub {
      naturalWidth = 64
      naturalHeight = 48
      onload: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    }
    const drawn: unknown[][] = []
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => drawn.push(args) }),
      toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['crop'], { type })),
    }
    for (const [key, value] of Object.entries({ Image: ImageStub, document: { createElement: () => canvas } })) {
      const before = Object.getOwnPropertyDescriptor(globalThis, key)
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      t.after(() => {
        if (before) Object.defineProperty(globalThis, key, before)
        else Reflect.deleteProperty(globalThis, key)
      })
    }
    const store = new CanvasStore()
    store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
      { id: 'source', kind: 'image', src: '/media/source', mime, x: 10, y: 20, w: 128, h: 96 },
    ] })
    let uploaded: File | undefined
    await applyCrop(store, store.getItem('source')!, { x: 0, y: 0, w: 64, h: 96 }, async (file) => {
      uploaded = file
      return { url: '/media/cropped', mime: file.type }
    })
    const expected = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    assert.equal(uploaded?.type, expected, 'альфа-канал нельзя отправлять в JPEG')
    assert.equal(store.getItem('source')?.mime, expected)
    assert.equal(store.getItem('source')?.naturalWidth, 32)
    assert.equal(store.getItem('source')?.naturalHeight, 48)
    assert.equal(drawn.length, 1)
    store.undo()
    assert.equal(store.getItem('source')?.src, '/media/source')
  })
}

function installCropDom(t: { after(callback: () => void): void }, naturalWidth = 64, naturalHeight = 48): void {
  class ImageStub {
    naturalWidth = naturalWidth
    naturalHeight = naturalHeight
    onload: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['crop'], { type })),
  }
  for (const [key, value] of Object.entries({ Image: ImageStub, document: { createElement: () => canvas } })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
}

function imageStore(item: CanvasItem): CanvasStore {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [item] })
  return store
}

function collaborationPort(
  canMutate: () => boolean,
  withSelection: BoardCollaborationPort['withSelection'],
): BoardCollaborationPort {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => ({
      state: 'ready',
      selfSessionId: 'self',
      ownedIds: [],
      requestedIds: [],
      conflicts: [],
      participants: [],
      locks: [],
      previews: [],
    }),
    requestSelection: async () => canMutate(),
    canMutate,
    withSelection,
    setCursor: () => undefined,
    setPreview: () => undefined,
  }
}

function baseImage(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'source',
    kind: 'image',
    src: '/media/source',
    mime: 'image/png',
    x: 10,
    y: 20,
    w: 128,
    h: 96,
    ...overrides,
  }
}

test('истёкшая аренда во время upload не применяет кроп и объясняет отказ', async (t) => {
  installCropDom(t)
  const store = imageStore(baseImage())
  let leaseLive = true
  store.setCollaboration(collaborationPort(
    () => leaseLive,
    async (_ids, work) => {
      if (!leaseLive) return false
      await work()
      return true
    },
  ))

  await assert.rejects(
    applyCrop(store, store.getItem('source')!, { x: 8, y: 6, w: 64, h: 48 }, async (file) => {
      leaseLive = false
      return { url: '/media/cropped', mime: file.type }
    }),
    /Someone else is editing this object/u,
  )
  assert.equal(store.getItem('source')?.src, '/media/source')
})

test('явный отказ финальной аренды не оставляет загруженный кроп на доске', async (t) => {
  installCropDom(t)
  const store = imageStore(baseImage())
  store.setCollaboration(collaborationPort(
    () => true,
    async () => false,
  ))

  await assert.rejects(
    applyCrop(store, store.getItem('source')!, { x: 8, y: 6, w: 64, h: 48 }, async (file) => ({
      url: '/media/cropped',
      mime: file.type,
    })),
    /Someone else is editing this object/u,
  )
  assert.equal(store.getItem('source')?.src, '/media/source')
})

for (const remoteAction of ['изменения', 'удаления'] as const) {
  test(`кроп не перезаписывает объект после удалённого ${remoteAction} во время upload`, async (t) => {
    installCropDom(t)
    const store = imageStore(baseImage())
    await assert.rejects(
      applyCrop(store, store.getItem('source')!, { x: 8, y: 6, w: 64, h: 48 }, async (file) => {
        if (remoteAction === 'изменения') {
          store.applyRemote({
            type: 'item.patch',
            objectId: 'source',
            payload: { values: { w: 99 }, unset: [] },
          })
        } else {
          store.applyRemote({ type: 'item.delete', objectId: 'source', payload: {} })
        }
        return { url: '/media/cropped', mime: file.type }
      }),
      /Image changed or was deleted/u,
    )
    if (remoteAction === 'изменения') {
      assert.equal(store.getItem('source')?.w, 99)
      assert.equal(store.getItem('source')?.src, '/media/source')
    } else {
      assert.equal(store.getItem('source'), undefined)
    }
  })
}

test('переезд картинки во время загрузки кроп не отменяет: результат едет вместе с ней (3.6)', async (t) => {
  // Режим обрезки закрывается сразу, как вырезан кусок, и хвататься за
  // картинку можно тут же. Переезд — не повод терять обрезку, но и не повод
  // вернуть картинку на старое место: результат сдвигается вместе с ней.
  installCropDom(t)
  const store = imageStore(baseImage())
  const before = store.getItem('source')!
  await applyCrop(store, before, { x: 8, y: 6, w: 64, h: 48 }, async (file) => {
    store.applyRemote({
      type: 'item.patch',
      objectId: 'source',
      payload: { values: { x: before.x + 100, y: before.y + 50 }, unset: [] },
    })
    return { url: '/media/cropped', mime: file.type }
  })
  const after = store.getItem('source')!
  assert.equal(after.src, '/media/cropped')
  assert.equal(after.x, before.x + 100 + 8)
  assert.equal(after.y, before.y + 50 + 6)
})

test('обрезка фоном: режим свободен сразу, карточка с самим результатом держится до загрузки (3.6)', async (t) => {
  installCropDom(t)
  const store = imageStore(baseImage())
  let finishUpload!: () => void
  const uploadGate = new Promise<void>((resolve) => { finishUpload = resolve })
  let reportProgress: ((loaded: number, total: number) => void) | undefined
  const failures: unknown[] = []

  await applyCropInBackground(store, store.getItem('source')!, { x: 8, y: 6, w: 64, h: 48 }, async (file, _signal, onProgress) => {
    reportProgress = onProgress
    await uploadGate
    return { url: '/media/cropped', mime: file.type }
  }, (error) => failures.push(error))

  // Кусок вырезан — обещание выполнено, хотя файл ещё едет.
  const card = store.getPending().find((pending) => pending.transient && pending.label === 'Crop')
  assert.ok(card, 'на месте результата стоит карточка')
  assert.equal(card.x, 10 + 8)
  assert.equal(card.y, 20 + 6)
  assert.equal(card.previewSrc, '/media/source', 'карточка показывает сам результат, а не спиннер')
  assert.ok(card.previewCrop)
  assert.equal(store.getItem('source')?.src, '/media/source', 'объект меняется только после загрузки')

  reportProgress?.(50, 100)
  assert.equal(store.getPending().find((pending) => pending.id === card.id)?.percent, 50)

  finishUpload()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(store.getItem('source')?.src, '/media/cropped')
  assert.equal(store.getPending().length, 0, 'карточка ушла вместе с загрузкой')
  assert.deepEqual(failures, [])
})

test('сорванная загрузка обрезки убирает карточку и объясняет, не трогая картинку', async (t) => {
  installCropDom(t)
  const store = imageStore(baseImage())
  const failures: unknown[] = []
  await applyCropInBackground(store, store.getItem('source')!, { x: 8, y: 6, w: 64, h: 48 }, async () => {
    throw new Error('Сервер команды не принял файл')
  }, (error) => failures.push(error))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(store.getPending().length, 0)
  assert.equal(store.getItem('source')?.src, '/media/source')
  assert.match(String(failures[0]), /не принял файл/u)
})
