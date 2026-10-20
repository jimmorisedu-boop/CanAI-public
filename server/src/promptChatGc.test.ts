import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

test('GC сохраняет медиа активных и удалённых диалогов и останавливается на битом чанке', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-gc-'))
  process.env.CANAI_DATA_DIR = dataDir
  t.after(async () => {
    delete process.env.CANAI_DATA_DIR
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  const mediaDir = path.join(dataDir, 'media')
  const activeChunk = path.join(
    dataDir,
    'prompt-chats',
    'project1',
    'conversations',
    'active1',
    'messages',
    '000001.json',
  )
  const trashedChunk = path.join(
    dataDir,
    'trash',
    'project2',
    'prompt-chat',
    'conversations',
    'deleted1',
    'messages',
    '000001.json',
  )
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.mkdir(path.dirname(activeChunk), { recursive: true })
  await fs.mkdir(path.dirname(trashedChunk), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'projects.json'), '[]')
  await fs.writeFile(activeChunk, JSON.stringify([{ src: '/media/active.png' }]))
  await fs.writeFile(trashedChunk, JSON.stringify([{ src: '/media/trashed.png' }]))
  for (const name of ['active.png', 'trashed.png', 'orphan.png']) {
    await fs.writeFile(path.join(mediaDir, name), name)
  }

  const { gcMedia } = await import('./gc.js')
  const result = await gcMedia(0)
  assert.equal(await exists(path.join(mediaDir, 'active.png')), true)
  assert.equal(await exists(path.join(mediaDir, 'trashed.png')), true)
  assert.equal(await exists(path.join(mediaDir, 'orphan.png')), false)
  assert.equal(result.removed, 1)

  await fs.writeFile(activeChunk, '{"broken":')
  await fs.writeFile(path.join(mediaDir, 'orphan-after-corruption.png'), 'x')
  const protectedResult = await gcMedia(0)
  assert.deepEqual(protectedResult, { removed: 0, kept: 0 })
  assert.equal(await exists(path.join(mediaDir, 'orphan-after-corruption.png')), true)
})
