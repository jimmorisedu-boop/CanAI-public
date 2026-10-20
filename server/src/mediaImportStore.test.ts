import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MediaImportTask } from './mediaImportTypes.js'
import { MediaImportStore } from './mediaImportStore.js'

function task(id: string, updatedAt = 1): MediaImportTask {
  return {
    id,
    sourceUrl: `https://cdn.test/${id}.jpg`,
    provider: 'direct',
    status: 'queued',
    createdAt: 1,
    updatedAt,
    items: [{ id: `${id}-item`, kind: 'image', title: id, aspectRatio: 1, status: 'queued', downloadedBytes: 0 }],
  }
}

async function tempStore(run: (store: MediaImportStore, file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-import-store-'))
  const file = path.join(dir, 'media-imports.json')
  try {
    await run(new MediaImportStore(file), file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {})
  }
}

test('concurrent updates are serialized and keep both tasks', async () => {
  await tempStore(async (store) => {
    await Promise.all([store.upsert(task('a')), store.upsert(task('b'))])
    assert.deepEqual((await store.list()).map((item) => item.id).sort(), ['a', 'b'])
  })
})

test('malformed JSON refuses destructive overwrite on every call', async () => {
  await tempStore(async (store, file) => {
    await fs.writeFile(file, '{broken', 'utf8')
    await assert.rejects(store.load(), /повреждён|JSON/i)
    await assert.rejects(store.upsert(task('new')), /повреждён|JSON/i)
    assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  })
})

test('writes atomically and keeps active tasks while pruning old terminal tasks', async () => {
  const now = 10 * 24 * 60 * 60 * 1000
  await tempStore(async (_unused, file) => {
    const store = new MediaImportStore(file, { now: () => now, terminalLimit: 2 })
    const old = { ...task('old'), status: 'completed' as const, updatedAt: 1 }
    const terminalA = { ...task('done-a'), status: 'completed' as const, updatedAt: now - 1 }
    const terminalB = { ...task('done-b'), status: 'error' as const, updatedAt: now }
    await store.save([old, terminalA, terminalB, task('active')])
    assert.deepEqual((await store.list()).map((item) => item.id).sort(), ['active', 'done-a', 'done-b'])
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['media-imports.json'])
  })
})
