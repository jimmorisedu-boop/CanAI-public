import assert from 'node:assert/strict'
import test from 'node:test'
import type { Job } from '../../types'
import { createGenerationRegistry } from './generationRegistry'
import { CanvasStore } from './konva/canvasStore'
import { handleSettledCanvasGeneration, settleCanvasGeneration } from './canvasGenerationSettle'
import { DELIVERY_IMAGE_DIMENSIONS_FAILED } from './konva/mediaProbe'
import { restoreProjectGenerationTasks } from './projectSync'
import { ORPHANED_LAUNCH } from './pendingLaunchState'

function fixture(getJob: (id: string) => Job) {
  const reads: string[] = []
  const registry = createGenerationRegistry({
    getJob: async id => { reads.push(id); return getJob(id) },
    cancelJob: async () => {}, schedule: () => 1, unschedule() {},
  })
  return { registry, reads }
}

test('reload recovers an image delivery error from the same paid job without regenerating', async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const beforeImage = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 512
    naturalHeight = 1024
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  } })
  let reads = 0, paidSubmits = 0
  const registry = createGenerationRegistry({
    getJob: async id => { reads++; return { id, kind: 'image', prompt: '', status: 'done', result: { url: '/media/paid.png', mime: 'image/png' } } },
    cancelJob: async () => {},
    generate: async () => { paidSubmits++; return { jobId: 'must-not-submit' } },
    schedule: () => 1, unschedule() {},
  })
  try {
    const saved = new CanvasStore()
    const [id] = saved.addPendingRow(1, { kind: 'image', label: 'Готовая картинка' })
    saved.setPendingJob(id, 'existing-paid-image')
    saved.failPendingById(id, DELIVERY_IMAGE_DIMENSIONS_FAILED)
    const reopened = new CanvasStore()
    reopened.loadDoc(saved.toDoc())
    const deliveries: Promise<void>[] = []
    registry.registerGenerationSink('canvas', 'board', job => { deliveries.push(settleCanvasGeneration(job, reopened)) })
    restoreProjectGenerationTasks(reopened, 'board', registry)
    await registry.pollNow()
    await Promise.all(deliveries)
    assert.equal(reads, 1)
    assert.equal(paidSubmits, 0)
    assert.equal(reopened.getPending().length, 0)
    assert.equal(reopened.getItems().length, 1)
    assert.equal(reopened.getItems()[0].naturalWidth, 512)
    assert.equal(reopened.getItems()[0].naturalHeight, 1024)
  } finally {
    registry.dispose()
    for (const [key, descriptor] of [['window', beforeWindow], ['Image', beforeImage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('local loading после перезапуска становится ошибкой без опроса и повторной оплаты', async () => {
  const f = fixture(() => { throw new Error('local failure must not poll') })
  const store = new CanvasStore()
  const [id] = store.addPendingRow(1, { kind: 'image', label: 'Flare' })
  store.setPendingJob(id, 'local:failed-launch')
  restoreProjectGenerationTasks(store, 'board', f.registry)
  await f.registry.pollNow()
  assert.equal(store.getPending()[0].status, 'error')
  assert.equal(f.registry.getSnapshot()[0].state, 'error')
  assert.equal(f.registry.getSnapshot()[0].retry, undefined)
  assert.deepEqual(f.reads, [])
  f.registry.dispose()
})

test('чужой local pending показывается как сбой без записи от имени другого устройства', () => {
  const f = fixture(() => { throw new Error('must not poll') })
  const store = new CanvasStore()
  const [id] = store.addPendingRow(1, { kind: 'image', label: 'Flare' })
  store.setPendingJob(id, 'local:other-device')
  restoreProjectGenerationTasks(store, 'cloud-board', f.registry, { repairLocalFailures: false })
  assert.equal(store.getPending()[0].status, 'loading', 'сохраняем канонический документ другого устройства')
  assert.equal(f.registry.getSnapshot()[0].state, 'error')
  f.registry.dispose()
})

/**
 * ⚠️ «Отменена» — финал сервера команды, и центр задач его понимал, а карточка
 * на доске — нет: она крутилась дальше у всех, кто открывал доску (так на
 * сетевой доске висели две отменённые генерации от 23.09, найдено 26.09.2026).
 */
test('отменённая на сервере команды генерация перестаёт крутиться на доске', async () => {
  const f = fixture(id => ({ id, kind: 'image', prompt: '', status: 'cancelled' as Job['status'] }))
  const store = new CanvasStore()
  const [id] = store.addPendingRow(1, { kind: 'image', label: 'Seedream' })
  store.setPendingJob(id, 'cloud-job~prj_board~job_cancelled')
  f.registry.registerGenerationSink('canvas', 'board', job => handleSettledCanvasGeneration(job, store, () => {}))
  restoreProjectGenerationTasks(store, 'board', f.registry)
  await f.registry.pollNow()
  assert.equal(f.registry.getSnapshot()[0]?.state, 'cancelled')
  assert.equal(store.getPending()[0]?.status, 'error')
  assert.equal(store.getPending()[0]?.error, 'Cancelled')
  f.registry.dispose()
})

/**
 * ⚠️ Номер задачи карточке ставит запустившая её вкладка. Закрылась она раньше —
 * и карточка без номера крутится у всех вечно: спросить не о чем. Так на
 * сетевой доске висели десять карточек от 23.09 (найдено 26.09.2026).
 */
test('карточка без номера задачи через полчаса становится «Запуск прервался»', () => {
  const f = fixture(() => { throw new Error('опрашивать нечего') })
  const store = new CanvasStore()
  const [orphan, fresh] = store.addPendingRow(2, { kind: 'image', label: 'Seedream' })
  const startedAt = store.getPending().find((item) => item.id === orphan)!.startedAt
  const hourLater = startedAt + 60 * 60_000
  store.updatePending(fresh!, { startedAt: hourLater - 60_000 }, { system: true })

  restoreProjectGenerationTasks(store, 'board', f.registry, { now: hourLater })
  const byId = new Map(store.getPending().map((item) => [item.id, item]))
  assert.equal(byId.get(orphan!)?.status, 'error')
  assert.equal(byId.get(orphan!)?.error, ORPHANED_LAUNCH)
  assert.equal(byId.get(fresh!)?.status, 'loading', 'свежий запуск ещё ждёт свой номер')
  assert.deepEqual(f.registry.getSnapshot(), [], 'в «Задачи» чужое не попадает')
  f.registry.dispose()
})

test('на планшете брошенную карточку не правим — её показывает сбоем сама карточка', () => {
  const f = fixture(() => { throw new Error('опрашивать нечего') })
  const store = new CanvasStore()
  const [orphan] = store.addPendingRow(1, { kind: 'image', label: 'Seedream' })
  const startedAt = store.getPending()[0]!.startedAt
  restoreProjectGenerationTasks(store, 'board', f.registry, {
    now: startedAt + 60 * 60_000, repairLocalFailures: false,
  })
  assert.equal(store.getPending().find((item) => item.id === orphan)?.status, 'loading')
  f.registry.dispose()
})

test('all eleven offscreen errors replace loading placeholders when the board returns', async () => {
  const f = fixture(id => ({ id, kind: 'image', prompt: '', status: 'error', error: 'Provider failed' }))
  const original = new CanvasStore()
  original.addPendingRow(11, { kind: 'image', label: 'Image' })
    .forEach((id, index) => original.setPendingJob(id, `job-${index}`))
  const doc = original.toDoc()
  restoreProjectGenerationTasks(original, 'board', f.registry)
  await f.registry.pollNow()
  await f.registry.pollNow()
  assert.equal(f.reads.length, 11, 'no polling for a closed board after terminal responses')
  assert.equal(f.registry.getSnapshot().filter(task => task.state === 'error').length, 11)

  const reopened = new CanvasStore()
  reopened.loadDoc(doc)
  restoreProjectGenerationTasks(reopened, 'board', f.registry)
  const deliveries: string[] = []
  const sink = (job: Job) => {
    deliveries.push(job.id)
    handleSettledCanvasGeneration(job, reopened, () => {})
  }
  const unregister = f.registry.registerGenerationSink('canvas', 'board', sink)
  await f.registry.pollNow()
  assert.equal(reopened.getPending().filter(item => item.status === 'loading').length, 0)
  assert.equal(reopened.getPending().filter(item => item.status === 'error').length, 11)
  unregister()
  f.registry.registerGenerationSink('canvas', 'board', sink)
  await f.registry.pollNow()
  assert.equal(deliveries.length, 11)
  assert.equal(new Set(deliveries).size, 11)
  f.registry.dispose()
})

test('saved loading placeholder is completed by the existing server job once after reload', async () => {
  let reads = 0
  let paidSubmits = 0
  const registry = createGenerationRegistry({
    getJob: async (id) => {
      reads++
      return { id, kind: 'text', prompt: 'старый запрос', status: 'done', result: { text: 'готовый ответ' } }
    },
    cancelJob: async () => {},
    generate: async () => {
      paidSubmits++
      return { jobId: 'should-not-start' }
    },
    schedule: () => 1,
    unschedule: () => {},
  })
  const saved = new CanvasStore()
  const [pendingId] = saved.addPendingRow(1, {
    kind: 'text',
    label: 'Старая модель',
    prompt: 'старый запрос',
  })
  saved.setPendingJob(pendingId, 'existing-job')

  const reopened = new CanvasStore()
  reopened.loadDoc(saved.toDoc())
  const deliveries: string[] = []
  restoreProjectGenerationTasks(reopened, 'board-reload', registry)
  registry.registerGenerationSink('canvas', 'board-reload', (job) => {
    deliveries.push(job.id)
    handleSettledCanvasGeneration(job, reopened, () => {})
  })

  await registry.pollNow()
  assert.equal(reads, 1)
  assert.equal(paidSubmits, 0)
  assert.deepEqual(deliveries, ['existing-job'])
  assert.equal(reopened.getPending().length, 0)
  assert.deepEqual(reopened.getItems().map((item) => item.text), ['готовый ответ'])

  await registry.pollNow()
  assert.equal(reads, 1)
  assert.deepEqual(deliveries, ['existing-job'])
  registry.dispose()
})

test('evicted successful results are recovered once, even after dismissing their task-center rows', async () => {
  const f = fixture(id => ({ id, kind: 'text', prompt: '', status: 'done', result: { text: `Result ${id}` } }))
  const target = { kind: 'prompt-chat', projectId: 'chat-board', conversationId: 'c1', messageId: 'm1' } as const
  for (let i = 0; i < 12; i++) f.registry.trackGeneration({ ...target, messageId: `m${i}` }, `j${i}`, 'text')
  await f.registry.pollNow()
  f.registry.dismissTask('j0')
  const other: Job[] = []
  f.registry.registerGenerationSink('prompt-chat', 'another-board', job => other.push(job))
  await f.registry.pollNow()
  assert.equal(f.reads.length, 12)
  const delivered: string[] = []
  const unregister = f.registry.registerGenerationSink('prompt-chat', 'chat-board', job => delivered.push(job.result!.text!))
  await f.registry.pollNow()
  assert.deepEqual(delivered.toSorted(), Array.from({ length: 12 }, (_, i) => `Result j${i}`).toSorted())
  assert.deepEqual(other, [])
  unregister()
  f.registry.registerGenerationSink('prompt-chat', 'chat-board', job => delivered.push(job.id))
  await f.registry.pollNow()
  assert.equal(delivered.length, 12)
  f.registry.dispose()
})

test('delivery pruned after a day is recovered when its channel returns', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const f = fixture(id => ({ id, kind: 'text', prompt: '', status: 'done', result: { text: id } }))
  const target = { kind: 'canvas', projectId: 'day-old-board' } as const
  f.registry.trackGeneration(target, 'old', 'text')
  await f.registry.pollNow()
  now = 25 * 60 * 60 * 1000
  f.registry.trackGeneration(target, 'new', 'text')
  await f.registry.pollNow()
  const delivered: string[] = []
  f.registry.registerGenerationSink('canvas', target.projectId, job => delivered.push(job.id))
  await f.registry.pollNow()
  assert.deepEqual(delivered.toSorted(), ['new', 'old'])
  f.registry.dispose()
})
