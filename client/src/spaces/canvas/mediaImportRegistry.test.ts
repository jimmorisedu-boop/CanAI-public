import assert from 'node:assert/strict'
import test from 'node:test'
import type { MediaImportTask } from './mediaImportTypes.js'
import { createMediaImportRegistry, type MediaImportRegistryDeps } from './mediaImportRegistry.js'

function task(status: MediaImportTask['status'], updatedAt: number, bytes = 0): MediaImportTask {
  return {
    id: 'task-1', sourceUrl: 'https://cdn.test/a.jpg', provider: 'direct', status,
    createdAt: 1, updatedAt,
    items: [{
      id: 'entry-1', kind: 'image', title: 'a.jpg', aspectRatio: 1,
      status, downloadedBytes: bytes,
    }],
  }
}

function fixture(overrides: Partial<MediaImportRegistryDeps> = {}) {
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  let visibilityListener: (() => void) | undefined
  let hidden = false
  const deps: MediaImportRegistryDeps = {
    getTask: async () => task('downloading', 2, 10),
    cancelTask: async () => task('cancelled', 3, 10),
    schedule: (callback, delay) => { const value = { callback, delay }; scheduled.push(value); return value },
    unschedule: () => undefined,
    visibility: {
      isHidden: () => hidden,
      subscribe: (listener) => { visibilityListener = listener; return () => { visibilityListener = undefined } },
    },
    now: () => 100,
    ...overrides,
  }
  const registry = createMediaImportRegistry(deps)
  return { registry, scheduled, setHidden: (value: boolean) => { hidden = value }, resume: () => visibilityListener?.() }
}

test('polls active task and sends every newer progress snapshot to mounted sink', async () => {
  const fresh = [task('downloading', 2, 10), task('downloading', 3, 20)]
  const context = fixture({ getTask: async () => fresh.shift()! })
  const delivered: MediaImportTask[] = []
  context.registry.registerMediaImportSink('project-1', (snapshot) => delivered.push(snapshot))
  context.registry.trackMediaImport('project-1', 'link-1', task('queued', 1))
  await context.registry.pollNow()
  await context.registry.pollNow()
  assert.deepEqual(delivered.map((snapshot) => snapshot.items[0].downloadedBytes), [10, 20])
  delivered[0].items[0].downloadedBytes = 999
  assert.equal(delivered[1].items[0].downloadedBytes, 20)
  context.registry.dispose()
})

test('parks terminal delivery while board is unmounted and delivers after registration', async () => {
  const context = fixture({ getTask: async () => task('completed', 2, 20) })
  context.registry.trackMediaImport('project-1', 'link-1', task('queued', 1))
  await context.registry.pollNow()
  const delivered: Array<{ task: MediaImportTask; linkId: string }> = []
  context.registry.registerMediaImportSink('project-1', (snapshot, target) => delivered.push({ task: snapshot, linkId: target.linkId }))
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].task.status, 'completed')
  assert.equal(delivered[0].linkId, 'link-1')
  context.registry.dispose()
})

test('404 becomes interrupted after one confirmed missing task', async () => {
  const missing = Object.assign(new Error('missing'), { status: 404 })
  const context = fixture({ getTask: async () => { throw missing } })
  const delivered: MediaImportTask[] = []
  context.registry.registerMediaImportSink('project-1', (snapshot) => delivered.push(snapshot))
  context.registry.trackMediaImport('project-1', 'link-1', task('downloading', 1, 5))
  await context.registry.pollNow()
  assert.equal(delivered[0].status, 'interrupted')
  assert.equal(delivered[0].items[0].status, 'interrupted')
  context.registry.dispose()
})

test('cancel keeps polling until server returns cancelled or completed', async () => {
  let polled = 0
  const context = fixture({
    cancelTask: async () => task('downloading', 2, 10),
    getTask: async () => { polled++; return task('cancelled', 3, 10) },
  })
  const delivered: MediaImportTask[] = []
  context.registry.registerMediaImportSink('project-1', (snapshot) => delivered.push(snapshot))
  context.registry.trackMediaImport('project-1', 'link-1', task('queued', 1))
  await context.registry.cancelMediaImport('task-1')
  assert.equal(delivered.at(-1)?.status, 'downloading')
  await context.registry.pollNow()
  assert.equal(polled, 1)
  assert.equal(delivered.at(-1)?.status, 'cancelled')
  context.registry.dispose()
})

test('visibility resume polls immediately and hidden polling uses five seconds', async () => {
  let polls = 0
  const context = fixture({ getTask: async () => { polls++; return task('downloading', polls + 1, polls) } })
  context.setHidden(true)
  context.registry.trackMediaImport('project-1', 'link-1', task('queued', 1))
  assert.equal(context.scheduled.at(-1)?.delay, 5_000)
  context.setHidden(false)
  context.resume()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(polls, 1)
  context.registry.dispose()
})
