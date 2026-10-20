import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { terminateProcessTree } from './terminateProcessTree.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MediaImportTask } from './mediaImportTypes.js'
import { MediaImportManager, type MediaImportStoreLike } from './mediaImportManager.js'
import type { ResolvedMediaLink } from './mediaLinkResolver.js'

function resolved(ids = ['one']): ResolvedMediaLink {
  const entries = ids.map((id, index) => ({
    id,
    kind: 'image' as const,
    title: id,
    aspectRatio: 1,
    download: { type: 'remote' as const, url: `https://cdn.test/${id}.png` },
  }))
  return {
    public: {
      normalizedUrl: 'https://cdn.test/post', provider: 'direct', sourceLabel: 'Ссылка',
      title: 'Пост', entries: entries.map(({ download: _download, ...entry }) => entry),
    },
    entries,
  }
}

class MemoryStore implements MediaImportStoreLike {
  tasks = new Map<string, MediaImportTask>()
  writes: MediaImportTask[] = []
  async load(): Promise<MediaImportTask[]> { return this.list() }
  async list(): Promise<MediaImportTask[]> { return [...this.tasks.values()].map((task) => structuredClone(task)) }
  async get(id: string): Promise<MediaImportTask | null> { return structuredClone(this.tasks.get(id) ?? null) }
  async upsert(task: MediaImportTask): Promise<void> {
    const copy = structuredClone(task)
    this.tasks.set(task.id, copy)
    this.writes.push(copy)
  }
}

async function waitUntil(check: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('условие теста не наступило')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function setup(
  overrides: Partial<ConstructorParameters<typeof MediaImportManager>[0]>,
): Promise<{ manager: MediaImportManager; store: MemoryStore; mediaDir: string; cleanup: () => Promise<void> }> {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-import-manager-'))
  const store = overrides.store instanceof MemoryStore ? overrides.store : new MemoryStore()
  const manager = new MediaImportManager({
    store,
    mediaDir,
    resolve: async () => resolved(),
    downloadRemote: async (input) => ({ url: `/media/${input.baseName}.png`, mime: 'image/png', bytes: 4 }),
    ...overrides,
  })
  return { manager, store, mediaDir, cleanup: async () => { await manager.dispose(); await fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}) } }
}

test('preview and immediate create share one in-flight provider resolution', async () => {
  let calls = 0
  let release!: (value: ResolvedMediaLink) => void
  const gate = new Promise<ResolvedMediaLink>((resolve) => { release = resolve })
  const context = await setup({
    resolve: async () => {
      calls++
      return gate
    },
  })
  try {
    const previewPromise = context.manager.preview('https://cdn.test/post')
    const createPromise = context.manager.create({ url: 'https://cdn.test/post' })
    assert.equal(calls, 1)
    release(resolved())
    await Promise.all([previewPromise, createPromise])
    assert.equal(calls, 1)
  } finally {
    await context.cleanup()
  }
})

test('runs at most two tasks concurrently', async () => {
  let active = 0
  let peak = 0
  const releases: Array<() => void> = []
  const context = await setup({
    downloadRemote: async (input) => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve)
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      active--
      return { url: `/media/${input.baseName}.png`, mime: 'image/png', bytes: 4 }
    },
  })
  try {
    await Promise.all([context.manager.create({ url: 'https://cdn.test/1' }), context.manager.create({ url: 'https://cdn.test/2' }), context.manager.create({ url: 'https://cdn.test/3' })])
    await waitUntil(() => releases.length === 2)
    assert.equal(peak, 2)
    releases.shift()?.()
    await waitUntil(() => releases.length === 2)
    releases.splice(0).forEach((release) => release())
    await context.manager.waitForIdle()
    assert.equal(peak, 2)
  } finally { await context.cleanup() }
})

test('progress is monotonic and byte-only writes are throttled', async () => {
  const context = await setup({
    downloadRemote: async (input) => {
      for (let value = 1; value <= 20; value++) input.onProgress?.(value, 20)
      return { url: `/media/${input.baseName}.png`, mime: 'image/png', bytes: 20 }
    },
  })
  try {
    const task = await context.manager.create({ url: 'https://cdn.test/progress' })
    await context.manager.waitForIdle()
    const snapshots = context.store.writes.filter((write) => write.id === task.id)
    const bytes = snapshots.map((write) => write.items[0].downloadedBytes)
    assert.deepEqual(bytes, [...bytes].sort((a, b) => a - b))
    assert(bytes.at(-1) === 20)
    assert(snapshots.length < 12, `слишком много записей: ${snapshots.length}`)
  } finally { await context.cleanup() }
})

test('one carousel item may fail while successful siblings complete', async () => {
  const context = await setup({
    resolve: async () => resolved(['good', 'bad']),
    downloadRemote: async (input) => {
      if (input.baseName.includes('bad')) throw new Error('CDN недоступен')
      return { url: `/media/${input.baseName}.png`, mime: 'image/png', bytes: 4 }
    },
  })
  try {
    const created = await context.manager.create({ url: 'https://cdn.test/carousel' })
    await context.manager.waitForIdle()
    const task = await context.manager.get(created.id)
    assert.equal(task?.status, 'completed')
    assert.deepEqual(task?.items.map((item) => item.status), ['completed', 'error'])
  } finally { await context.cleanup() }
})

test('cancel aborts network and removes task part files', async () => {
  let aborted = false
  const context = await setup({
    downloadRemote: async (input) => await new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }),
  })
  try {
    const task = await context.manager.create({ url: 'https://cdn.test/slow' })
    await waitUntil(() => context.store.tasks.get(task.id)?.status === 'downloading')
    await fs.writeFile(path.join(context.mediaDir, `${task.id}-one.part.mp4`), 'partial')
    await context.manager.cancel(task.id)
    await context.manager.waitForIdle()
    assert.equal(aborted, true)
    assert.equal((await context.manager.get(task.id))?.status, 'cancelled')
    assert.deepEqual(await fs.readdir(context.mediaDir), [])
  } finally { await context.cleanup() }
})

test('startup marks queued and running tasks interrupted without restart', async () => {
  const store = new MemoryStore()
  for (const [id, status] of [['queued', 'queued'], ['active', 'downloading']] as const) {
    const base = resolved().public.entries[0]
    store.tasks.set(id, {
      id, sourceUrl: 'https://cdn.test/post', provider: 'direct', status,
      createdAt: 1, updatedAt: 1,
      items: [{ ...base, status, downloadedBytes: 0 }],
    })
  }
  let resolvedCalls = 0
  const context = await setup({ store, resolve: async () => { resolvedCalls++; return resolved() } })
  try {
    await context.manager.recoverInterrupted()
    assert.deepEqual((await store.list()).map((task) => task.status), ['interrupted', 'interrupted'])
    assert.equal(resolvedCalls, 0)
  } finally { await context.cleanup() }
})

test('entryIds retries only selected stable entries', async () => {
  const downloaded: string[] = []
  const context = await setup({
    resolve: async () => resolved(['one', 'two', 'three']),
    downloadRemote: async (input) => {
      downloaded.push(input.baseName)
      return { url: `/media/${input.baseName}.png`, mime: 'image/png', bytes: 4 }
    },
  })
  try {
    const task = await context.manager.create({ url: 'https://cdn.test/retry', entryIds: ['two'] })
    await context.manager.waitForIdle()
    assert.deepEqual(task.items.map((item) => item.id), ['two'])
    assert.equal(downloaded.length, 1)
    assert(downloaded[0].endsWith('-two'))
  } finally { await context.cleanup() }
})

test('Vimeo yt-dlp failures persist a stable public error without extractor details', async () => {
  const source = resolved()
  source.public = {
    ...source.public,
    normalizedUrl: 'https://vimeo.com/12345',
    provider: 'vimeo',
    sourceLabel: 'Vimeo',
  }
  source.public.entries = source.public.entries.map((entry) => ({ ...entry, title: 'Vimeo ролик' }))
  source.entries[0].download = { type: 'yt-dlp', url: 'https://vimeo.com/12345' }
  const secret = 'C:\\Users\\alice\\runtime\\yt-dlp.exe: Private video COOKIE=secret-token'
  const context = await setup({
    resolve: async () => source,
    locateTool: async () => 'C:/runtime/yt-dlp.exe',
    runYtDlp: async () => { throw new Error(secret) },
  })
  try {
    const created = await context.manager.create({ url: 'https://vimeo.com/12345' })
    await context.manager.waitForIdle()
    const task = await context.manager.get(created.id)
    assert.equal(task?.status, 'error')
    assert.equal(task?.items[0]?.error, 'Could not download the Vimeo video')
    assert.equal(JSON.stringify(task).includes('COOKIE'), false)
    assert.equal(JSON.stringify(task).includes('C:\\Users\\alice'), false)
    assert.equal(JSON.stringify(task).includes('secret-token'), false)
  } finally {
    await context.cleanup()
  }
})

test('отмена при поиске загрузчика не запускает процесс после завершения поиска', async (t) => {
  let release!: (executable: string) => void
  let locating = false
  const executable = new Promise<string>((resolve) => { release = resolve })
  const source = resolved()
  source.entries[0].download = { type: 'yt-dlp', url: 'https://youtu.be/cancelled' }
  const context = await setup({
    resolve: async () => source,
    locateTool: async () => { locating = true; return executable },
  })
  const originalSpawn = childProcess.spawn
  const launched: number[] = []
  // Наблюдаем реальные процессы, не подменяя исполнение: отменённая работа
  // не должна запускать даже короткоживущий обработчик после locateTool.
  const observed = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args)
    if (child.pid) launched.push(child.pid)
    return child
  })
  syncBuiltinESMExports()
  try {
    const task = await context.manager.create({ url: 'https://youtu.be/cancelled' })
    await waitUntil(() => locating)
    const cancellation = context.manager.cancel(task.id)
    await waitUntil(() => context.store.tasks.get(task.id)?.status === 'cancelled')
    // При регрессии Node отвергает аргументы yt-dlp и сразу завершается:
    // ни сети, ни долгоживущего дочернего процесса в этом тесте нет.
    release(process.execPath)
    await cancellation
    await context.manager.waitForIdle()
    assert.equal((await context.manager.get(task.id))?.status, 'cancelled')
    assert.deepEqual(launched, [], 'после отмены запущен новый процесс загрузчика')
  } finally {
    release(process.execPath)
    observed.mock.restore()
    syncBuiltinESMExports()
    await context.cleanup()
  }
})

test('Windows: отмена ждёт освобождения настоящего заблокированного part-файла', { skip: process.platform !== 'win32', timeout: 20_000 }, async (t) => {
  const source = resolved()
  source.entries[0].download = { type: 'yt-dlp', url: 'https://youtu.be/cancel-locked' }
  const context = await setup({ resolve: async () => source, locateTool: async () => process.execPath, id: () => 'audit' })
  const part = path.join(context.mediaDir, 'audit-one.part.mp4')
  const script = `$stream=[IO.File]::Open('${part.replace(/'/g, "''")}',[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None); [Console]::Out.WriteLine('LOCKED'); [Threading.Thread]::Sleep(15000); $stream.Dispose()`
  const originalSpawn = childProcess.spawn
  let downloader: childProcess.ChildProcess | undefined
  let locked = false
  const observed = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] !== process.execPath) return originalSpawn(...args)
    downloader = originalSpawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    downloader.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('LOCKED')) locked = true })
    return downloader
  })
  syncBuiltinESMExports()
  try {
    const task = await context.manager.create({ url: 'https://youtu.be/cancel-locked' })
    await waitUntil(() => locked, 5_000)
    const cancelled = await context.manager.cancel(task.id)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(downloader?.exitCode !== null || downloader?.signalCode !== null, true)
    assert.deepEqual(await fs.readdir(context.mediaDir), [])
  } finally {
    if (downloader) await terminateProcessTree(downloader).catch(() => undefined)
    await context.manager.waitForIdle()
    observed.mock.restore()
    syncBuiltinESMExports()
    await context.cleanup()
  }
})

test('отмена ждёт только свою задачу, а dispose дожидается оставшейся очистки', async () => {
  const workers = new Map<string, { signal: AbortSignal; finish: () => void }>()
  let nextId = 0
  const context = await setup({
    id: () => `cancel-${++nextId}`,
    downloadRemote: async ({ baseName, signal }) => await new Promise((_resolve, reject) => {
      workers.set(baseName, { signal: signal!, finish: () => reject(new Error('Скачивание отменено')) })
    }),
  })
  try {
    const first = await context.manager.create({ url: 'https://cdn.test/first' })
    const second = await context.manager.create({ url: 'https://cdn.test/second' })
    const queued = await context.manager.create({ url: 'https://cdn.test/queued' })
    await waitUntil(() => workers.size === 2)
    assert.equal((await context.manager.cancel(queued.id)).status, 'cancelled')
    assert.equal(workers.size, 2)
    const firstWorker = workers.get(`media-import-${first.id}-one`)!
    const secondWorker = workers.get(`media-import-${second.id}-one`)!
    const cancellation = context.manager.cancel(first.id)
    await waitUntil(() => firstWorker.signal.aborted)
    firstWorker.finish()
    await Promise.race([
      cancellation,
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Отмена ждёт чужую задачу')), 1_000); timer.unref() }),
    ])
    assert.equal(secondWorker.signal.aborted, false)
    const disposal = context.manager.dispose()
    await waitUntil(() => secondWorker.signal.aborted)
    secondWorker.finish()
    await disposal
    await context.manager.waitForIdle()
    assert.equal((await context.manager.get(second.id))?.status, 'cancelled')
    assert.equal(workers.size, 2)
  } finally {
    for (const worker of workers.values()) worker.finish()
    await context.cleanup()
  }
})
