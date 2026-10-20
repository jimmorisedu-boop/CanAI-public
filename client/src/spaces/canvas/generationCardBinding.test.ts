import assert from 'node:assert/strict'
import test from 'node:test'
import type { Job } from '../../types.js'
import { handleSettledCanvasGeneration } from './canvasGenerationSettle.js'
import { createGenerationRegistry, type GenerationTarget } from './generationRegistry.js'
import { CanvasStore } from './konva/canvasStore.js'
import { restoreProjectGenerationTasks } from './projectSync.js'

// These checks keep the local generation card attached to the local job that
// created it. A result that arrives while a file is being measured must not
// become a second canvas item, and reopening a board must restore its cards to
// the local delivery registry.

test('an errored local job marks its card even without a separate toast', () => {
  const store = new CanvasStore()
  const [slot] = store.addPendingRow(1, { kind: 'image', label: 'Проба' })
  const errors: string[] = []
  const failed: Job = { id: 'local-job', kind: 'image', prompt: 'кот', status: 'error', error: 'нет денег' }
  handleSettledCanvasGeneration(failed, store, (message) => errors.push(message), { placeholderId: slot })
  const card = store.getPending()[0]
  assert.equal(card?.status, 'error')
  assert.equal(card?.error, 'нет денег')
  assert.equal(card?.jobId, 'local-job', 'the local job id keeps the Retry action attached')
  assert.deepEqual(errors, [], 'the card already contains the useful error')
})

test('a result without a card keeps its prompt and model instead of a macro label', async () => {
  const store = new CanvasStore()
  await store.resolveJob('job-1', { url: '/media/r.mp4', mime: 'video/mp4', width: 1280, height: 720 }, 'кот', {
    prompt: 'кот в шляпе', modelId: 'seedance-2',
  })
  const [item] = store.getItems()
  assert.equal(item?.prompt, 'кот в шляпе')
  assert.equal(item?.modelId, 'seedance-2')

  await store.resolveJob('job-2', { url: '/media/r.mp4', mime: 'video/mp4', width: 1280, height: 720 }, 'кот')
  assert.equal(store.getItems()[1]?.prompt, undefined, 'unknown prompt stays empty')
})

test('a local result arriving while its file is measured does not create a duplicate item', async (t) => {
  const loads: Array<() => void> = []
  class ImageStub {
    naturalWidth = 600
    naturalHeight = 900
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_: string) { loads.push(() => this.onload?.()) }
  }
  const windowStub = { setTimeout: () => 1, clearTimeout: () => {} }
  for (const [key, value] of Object.entries({ Image: ImageStub, window: windowStub })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  const store = new CanvasStore()
  const placing = store.resolveJob('local-job', { url: '/media/r.png', mime: 'image/png' }, 'кот')
  // The board snapshot can arrive while the local result is still measured.
  store.loadDoc({
    version: 1, camera: { x: 0, y: 0, scale: 1 },
    items: [{ id: 'card', kind: 'image', x: 0, y: 0, w: 400, h: 600, src: '/media/r.png', sourceJobId: 'local-job' }],
  })
  await Promise.resolve()
  loads.splice(0).forEach((load) => load())
  await placing
  assert.deepEqual(store.getItems().map((item) => item.id), ['card'])
})

test('a restored local pending card keeps its canvas target', () => {
  const store = new CanvasStore()
  const [slot] = store.addPendingRow(1, { kind: 'image', label: 'Проба' })
  store.setPendingJob(slot!, 'local-job')
  const targets: GenerationTarget[] = []
  restoreProjectGenerationTasks(store, 'prj_1', {
    trackGeneration: (target) => { targets.push(target) },
    restoreGenerationTask: () => {},
  })
  assert.deepEqual(targets, [{ kind: 'canvas', projectId: 'prj_1', placeholderId: slot }])
})

test('a card owned by another local job is not stolen during a retry', () => {
  const store = new CanvasStore()
  const [retried] = store.addPendingRow(1, { kind: 'image', label: 'Проба' })
  store.setPendingJob(retried!, 'new-local-job')
  store.updatePendingJobId('old-local-job', 'replacement-job', retried)
  assert.equal(store.getPending().find((card) => card.id === retried)?.jobId, 'new-local-job')

  const local = store.addTransientUploadPending({ x: 0, y: 0, w: 10, h: 10 }, 'image', 'Обрезка')
  store.updatePendingJobId('old-local-job', 'replacement-job', local)
  assert.equal(store.getPending().find((card) => card.id === local)?.jobId, undefined)
})
