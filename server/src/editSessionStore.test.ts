import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  EditSessionStore,
  type StoredEditSessionV2,
} from './editSessionStore.js'

const DAY = 24 * 60 * 60 * 1000

async function fixture(now = 1_000_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-edit-store-'))
  const mediaDir = path.join(root, 'media')
  const file = path.join(root, 'edit-sessions.json')
  await fs.mkdir(mediaDir, { recursive: true })
  const store = new EditSessionStore({ file, mediaDir, now: () => now })
  return {
    root,
    mediaDir,
    file,
    store,
    cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }),
  }
}

function session(patch: Partial<StoredEditSessionV2> = {}): StoredEditSessionV2 {
  return {
    id: 'session-1',
    projectId: 'project-1',
    sourceItemId: 'source-1',
    sourceName: 'Фото',
    fileName: 'edit-session-1.png',
    createdAt: 1_000_000,
    expiresAt: 1_000_000 + 7 * DAY,
    lastMtime: 10,
    appliedMtime: 10,
    placedItemId: null,
    state: 'waiting',
    ...patch,
  }
}

test('v1 переносится в legacy roots без выдуманного проекта', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(f.file, JSON.stringify({
      version: 1,
      sessions: [{ id: 'legacy', fileName: 'edit-legacy.png', createdAt: 1_000_000 }],
    }))
    const store = new EditSessionStore({ file: f.file, mediaDir: f.mediaDir, now: () => 1_000_000 })
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(await store.activeFileNames(), ['edit-legacy.png'])
    const saved = JSON.parse(await fs.readFile(f.file, 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(saved.legacy[0].id, 'legacy')
  } finally {
    await f.cleanup()
  }
})

test('новая копия остаётся waiting до изменения mtime', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.mediaDir, 'edit-session-1.png'), 'first')
    const stat = await fs.stat(path.join(f.mediaDir, 'edit-session-1.png'))
    const created = await f.store.create(session({ lastMtime: stat.mtimeMs, appliedMtime: stat.mtimeMs }))
    assert.equal(created.state, 'waiting')
    assert.equal((await f.store.list())[0].state, 'waiting')
  } finally {
    await f.cleanup()
  }
})

test('новый mtime переводит сессию в ready', async () => {
  const f = await fixture()
  try {
    const target = path.join(f.mediaDir, 'edit-session-1.png')
    await fs.writeFile(target, 'first')
    await fs.utimes(target, new Date(10), new Date(10))
    await f.store.create(session())
    await fs.utimes(target, new Date(20), new Date(20))
    const [ready] = await f.store.list()
    assert.equal(ready.state, 'ready')
    assert.equal(ready.lastMtime, 20)
  } finally {
    await f.cleanup()
  }
})

test('пропавший edit-файл помечает сессию broken', async () => {
  const f = await fixture()
  try {
    await f.store.create(session())
    const [broken] = await f.store.list()
    assert.equal(broken.state, 'broken')
    assert.match(broken.error ?? '', /not found|не найден/i)
  } finally {
    await f.cleanup()
  }
})

test('ack монотонен и не может обогнать lastMtime', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.mediaDir, 'edit-session-1.png'), 'ready')
    await f.store.create(session({ lastMtime: 20, appliedMtime: 10, state: 'ready' }))
    const applied = await f.store.acknowledge('session-1', { appliedMtime: 20, placedItemId: 'placed' })
    assert.equal(applied?.state, 'applied')
    const stale = await f.store.acknowledge('session-1', { appliedMtime: 15, placedItemId: 'old' })
    assert.equal(stale?.appliedMtime, 20)
    assert.equal(stale?.placedItemId, 'placed')
    await assert.rejects(
      () => f.store.acknowledge('session-1', { appliedMtime: 21, placedItemId: 'future' }),
      /newer|новее/i,
    )
  } finally {
    await f.cleanup()
  }
})

test('параллельные операции не теряют чужие записи', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.mediaDir, 'edit-session-1.png'), 'one')
    await fs.writeFile(path.join(f.mediaDir, 'edit-session-2.png'), 'two')
    await Promise.all([
      f.store.create(session()),
      f.store.create(session({ id: 'session-2', fileName: 'edit-session-2.png' })),
    ])
    await Promise.all([
      f.store.acknowledge('session-1', { appliedMtime: 10, placedItemId: 'placed-1' }),
      f.store.remove('session-2'),
      f.store.markBroken('session-1', 'проверка'),
    ])
    const list = await f.store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'session-1')
  } finally {
    await f.cleanup()
  }
})

test('истёкшие v2 и legacy записи перестают защищать файлы', async () => {
  const now = 10 * DAY
  const f = await fixture(now)
  try {
    await fs.writeFile(f.file, JSON.stringify({
      version: 2,
      sessions: [session({ createdAt: 0, expiresAt: DAY })],
      legacy: [{ id: 'legacy', fileName: 'edit-legacy.png', createdAt: 0 }],
    }))
    const store = new EditSessionStore({ file: f.file, mediaDir: f.mediaDir, now: () => now })
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(await store.activeFileNames(), [])
  } finally {
    await f.cleanup()
  }
})

test('битый документ падает повторно и остаётся неизменным', async () => {
  const f = await fixture()
  try {
    const corrupt = Buffer.from('{ это не JSON')
    await fs.writeFile(f.file, corrupt)
    const store = new EditSessionStore({ file: f.file, mediaDir: f.mediaDir })
    await assert.rejects(() => store.list())
    await assert.rejects(() => store.activeFileNames())
    assert.deepEqual(await fs.readFile(f.file), corrupt)
  } finally {
    await f.cleanup()
  }
})
