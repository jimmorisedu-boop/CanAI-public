import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('GC protects agent media while review, paused, or recovery state is durable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-gc-'))
  const previous = {
    mock: process.env.CANAI_MOCK,
    data: process.env.CANAI_DATA_DIR,
    envFile: process.env.CANAI_ENV_FILE,
  }
  process.env.CANAI_MOCK = '1'
  process.env.CANAI_DATA_DIR = root
  process.env.CANAI_ENV_FILE = path.join(root, 'missing.env')
  try {
    const media = path.join(root, 'media', 'общее', 'картинки')
    await fs.mkdir(media, { recursive: true })
    const retained = ['awaiting-review.png', 'paused.png', 'recovering.png']
    for (const name of [...retained, 'orphan.png']) await fs.writeFile(path.join(media, name), name)
    await fs.writeFile(path.join(root, 'agent-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [
        { state: 'awaiting_review', artifacts: [{ mediaSrc: '/media/awaiting-review.png' }] },
        { state: 'paused', artifacts: [{ mediaSrc: '/media/paused.png' }] },
        // `uncertain` is the persisted recovery state for an in-flight paid
        // request whose provider outcome must still be reconciled.
        { state: 'uncertain', artifacts: [{ mediaSrc: '/media/recovering.png' }] },
      ],
      events: {},
    }))
    const { gcMedia } = await import('../gc.js')
    const result = await gcMedia(0)
    for (const name of retained) assert.equal((await fs.stat(path.join(media, name))).isFile(), true)
    await assert.rejects(fs.stat(path.join(media, 'orphan.png')), { code: 'ENOENT' })
    assert.equal(result.removed, 1)
    assert.equal(result.kept, 3)
  } finally {
    if (previous.mock === undefined) delete process.env.CANAI_MOCK
    else process.env.CANAI_MOCK = previous.mock
    if (previous.data === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previous.data
    if (previous.envFile === undefined) delete process.env.CANAI_ENV_FILE
    else process.env.CANAI_ENV_FILE = previous.envFile
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })
  }
})
