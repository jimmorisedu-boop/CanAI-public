import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import test from 'node:test'
import type { MediaImportTask, MediaLinkPreview } from './mediaImportTypes.js'
import { createMediaImportRouter, type MediaImportManagerLike } from './mediaImportRoutes.js'

const preview: MediaLinkPreview = {
  normalizedUrl: 'https://cdn.test/photo.jpg',
  provider: 'direct',
  sourceLabel: 'Ссылка',
  title: 'photo.jpg',
  entries: [{ id: 'entry-1', kind: 'image', title: 'photo.jpg', aspectRatio: 1 }],
}

const task: MediaImportTask = {
  id: 'task-1', sourceUrl: preview.normalizedUrl, provider: 'direct', status: 'queued',
  createdAt: 1, updatedAt: 1,
  items: [{ ...preview.entries[0], status: 'queued', downloadedBytes: 0 }],
}

async function withServer(
  manager: MediaImportManagerLike,
  run: (origin: string) => Promise<void>,
  proxyRange?: NonNullable<Parameters<typeof createMediaImportRouter>[1]>['proxyRange'],
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api', createMediaImportRouter(manager, { proxyRange }))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function manager(overrides: Partial<MediaImportManagerLike> = {}): MediaImportManagerLike {
  return {
    preview: async () => preview,
    create: async () => task,
    get: async (id) => id === task.id ? task : null,
    cancel: async () => ({ ...task, status: 'cancelled' }),
    ...overrides,
  }
}

test('preview rejects invalid and unsafe URLs with stable error codes', async () => {
  await withServer(manager({
    preview: async (url) => {
      if (url.includes('127.0.0.1')) throw new Error('внешний URL указывает во внутреннюю сеть')
      return preview
    },
  }), async (origin) => {
    for (const [url, code] of [['not a url', 'MEDIA_LINK_INVALID'], ['https://127.0.0.1/a.jpg', 'MEDIA_LINK_UNSAFE']]) {
      const response = await fetch(`${origin}/api/media-imports/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { code: string }).code, code)
    }
  })
})

test('create, get and cancel return the exact task contracts', async () => {
  await withServer(manager(), async (origin) => {
    const created = await fetch(`${origin}/api/media-imports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: preview.normalizedUrl, entryIds: ['entry-1'] }),
    })
    assert.equal(created.status, 202)
    assert.deepEqual(await created.json(), { task })

    const loaded = await fetch(`${origin}/api/media-imports/task-1`)
    assert.equal(loaded.status, 200)
    assert.deepEqual(await loaded.json(), { task })

    const missing = await fetch(`${origin}/api/media-imports/missing`)
    assert.equal(missing.status, 404)

    const cancelled = await fetch(`${origin}/api/media-imports/task-1/cancel`, { method: 'POST' })
    assert.equal(cancelled.status, 200)
    assert.equal((await cancelled.json() as { task: MediaImportTask }).task.status, 'cancelled')
  })
})

test('create validates entryIds before calling the manager', async () => {
  let called = false
  await withServer(manager({ create: async () => { called = true; return task } }), async (origin) => {
    const response = await fetch(`${origin}/api/media-imports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: preview.normalizedUrl, entryIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }),
    })
    assert.equal(response.status, 400)
    assert.equal(called, false)
  })
})

test('direct preview caps Range and forwards only approved media headers', async () => {
  let seenRange = ''
  await withServer(manager(), async (origin) => {
    const response = await fetch(`${origin}/api/media-imports/direct-preview?url=${encodeURIComponent('https://cdn.test/video.mp4')}`, {
      headers: { Range: 'bytes=0-99999999' },
    })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'video')
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('content-range'), 'bytes 0-4/5')
    assert.equal(response.headers.get('x-secret-upstream'), null)
    assert.equal(response.headers.get('cache-control'), 'private, max-age=300')
    assert.equal(seenRange, 'bytes=0-99999999')
  }, async (_url, range) => {
    seenRange = range ?? ''
    return {
      finalUrl: new URL('https://cdn.test/video.mp4'),
      response: new Response('video', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-4/5',
          'content-length': '5',
          'accept-ranges': 'bytes',
          'x-secret-upstream': 'no',
        },
      }),
    }
  })
})
