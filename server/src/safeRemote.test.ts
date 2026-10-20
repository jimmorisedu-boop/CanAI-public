import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { config } from './config.js'
import { MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS } from './mediaLayout.js'
import {
  downloadRemoteMedia,
  openSafeRemote,
  proxyRemoteRange,
  remoteProxyFor,
  UploadTooLargeError,
  type SafeRemoteDeps,
  setOwnCloudOrigin,
} from './safeRemote.js'

function responseWithChunks(
  chunks: number[][],
  headers: Record<string, string> = {},
  status = 200,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers })
}

test('private DNS is rejected before fetch', async () => {
  let fetched = false
  await assert.rejects(
    openSafeRemote('https://internal.test/a.jpg', {}, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      fetch: async () => {
        fetched = true
        throw new Error('fetch не должен вызываться')
      },
    }),
    /internal network/u,
  )
  assert.equal(fetched, false)
})

test('every redirect target is resolved and checked before the next fetch', async () => {
  const fetched: string[] = []
  const lookedUp: string[] = []
  const deps: SafeRemoteDeps = {
    lookup: async (hostname) => {
      lookedUp.push(hostname)
      return [{ address: hostname === 'private.test' ? '10.0.0.7' : '93.184.216.34', family: 4 }]
    },
    fetch: async (url) => {
      fetched.push(String(url))
      return new Response(null, { status: 302, headers: { location: 'https://private.test/file.mp4' } })
    },
  }

  await assert.rejects(openSafeRemote('https://public.test/start', {}, deps), /internal network/u)
  assert.deepEqual(lookedUp, ['public.test', 'private.test'])
  assert.deepEqual(fetched, ['https://public.test/start'])
})

test('only public Referer and User-Agent are forwarded', async () => {
  let forwarded: Headers | undefined
  await openSafeRemote('https://cdn.test/photo.jpg', {
    headers: {
      Referer: 'https://www.instagram.com/',
      'User-Agent': 'CanAI test',
    },
  }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (_url, init) => {
      forwarded = new Headers(init?.headers)
      return new Response(Uint8Array.from([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    },
  })

  assert.equal(forwarded?.get('referer'), 'https://www.instagram.com/')
  assert.equal(forwarded?.get('user-agent'), 'CanAI test')
  assert.equal(forwarded?.get('cookie'), null)
  assert.equal(forwarded?.get('authorization'), null)
})

test('streaming download reports monotonic bytes and renames a complete file', async () => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-safe-remote-'))
  const progress: Array<[number, number | undefined]> = []
  try {
    const result = await downloadRemoteMedia({
      url: 'https://cdn.test/photo.png',
      mediaDir,
      baseName: 'direct-photo',
      maxBytes: 8,
      onProgress: (received, total) => progress.push([received, total]),
      deps: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => responseWithChunks([[1, 2], [3, 4]], {
          'content-type': 'image/png',
          'content-length': '4',
        }),
      },
    })

    assert.deepEqual(result, { url: '/media/direct-photo.png', mime: 'image/png', bytes: 4 })
    assert.deepEqual(progress, [[2, 4], [4, 4]])
    // Файл лежит в папке по типу (см. mediaLayout): ссылка при этом остаётся
    // «/media/<имя>» без папки — её знает только диск.
    assert.deepEqual(await fs.readdir(mediaDir), [MEDIA_SHARED_FOLDER])
    assert.deepEqual(
      await fs.readdir(path.join(mediaDir, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.image)),
      ['direct-photo.png'],
    )
  } finally {
    await fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('streaming download removes tmp when the body exceeds its limit', async () => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-safe-limit-'))
  try {
    await assert.rejects(
      downloadRemoteMedia({
        url: 'https://cdn.test/large.mp4',
        mediaDir,
        baseName: 'large-video',
        maxBytes: 5,
        deps: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetch: async () => responseWithChunks([[1, 2, 3], [4, 5, 6]], { 'content-type': 'video/mp4' }),
        },
      }),
      UploadTooLargeError,
    )
    // Обрыв по лимиту не оставляет ни файла, ни .tmp — только пустую папку типа
    assert.deepEqual(await fs.readdir(path.join(mediaDir, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.video)), [])
  } finally {
    await fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('video preview range is validated and capped at eight MiB', async () => {
  let range = ''
  const deps: SafeRemoteDeps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (_url, init) => {
      range = new Headers(init?.headers).get('range') ?? ''
      return responseWithChunks([[1]], { 'content-type': 'video/mp4' }, 206)
    },
  }

  await proxyRemoteRange('https://cdn.test/video.mp4', 'bytes=0-99999999', deps)
  assert.equal(range, 'bytes=0-8388607')
  await assert.rejects(proxyRemoteRange('https://cdn.test/video.mp4', 'items=0-5', deps), /Range/)
})

test('свой сервер CanAI разрешён, даже если он в локальной сети', async () => {
  setOwnCloudOrigin('http://192.168.1.50:8790')
  try {
    let asked = false
    const response = await openSafeRemote('http://192.168.1.50:8790/media/job_x.png', {}, {
      lookup: async () => { asked = true; return [{ address: '192.168.1.50', family: 4 }] },
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    })
    assert.equal(response.response.ok, true)
    // Свой адрес человек ввёл сам — разрешать его по DNS-ответу незачем.
    assert.equal(asked, false, 'своему серверу устраивают проверку как чужому')
  } finally {
    setOwnCloudOrigin(null)
  }
})

test('чужой адрес в той же локальной сети по-прежнему отвергается', async () => {
  setOwnCloudOrigin('http://192.168.1.50:8790')
  try {
    // ⚠️ Похожий, но НЕ тот же origin: иначе «http://сервер.ru» открывал бы
    // дорогу «http://сервер.ru.чужой-домен» и всей внутренней сети заодно.
    await assert.rejects(
      openSafeRemote('http://192.168.1.51:8790/media/x.png', {}, {
        lookup: async () => [{ address: '192.168.1.51', family: 4 }],
        fetch: async () => { throw new Error('fetch не должен вызываться') },
      }),
      /unsafe external URL|internal network/u,
    )
  } finally {
    setOwnCloudOrigin(null)
  }
})

// Жалоба 27.09.2026: картинка-превью YouTube шла мимо прокси и висела 21,7 с.
test('внешний https-файл идёт той же дорогой, что и приложение', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: 'localhost,127.0.0.1,canai.example.com' }
  assert.equal(remoteProxyFor(new URL('https://i.ytimg.com/vi/x/hqdefault.jpg'), env), 'http://127.0.0.1:10809/')
  // Сервер команды, до которого прямая дорога лучше, — напрямую.
  assert.equal(remoteProxyFor(new URL('https://canai.example.com/media/a.png'), env), null)
  // Своя сеть и http — напрямую, как раньше: http-переменную приложение не
  // проверяет, и у прокси-клиентов она нередко смотрит на SOCKS-порт.
  assert.equal(remoteProxyFor(new URL('https://192.168.1.50/a.png'), env), null)
  assert.equal(remoteProxyFor(new URL('http://cdn.test/a.png'), { ...env, HTTP_PROXY: 'http://127.0.0.1:10808' }), null)
  assert.equal(remoteProxyFor(new URL('https://cdn.test/a.png'), {}), null, 'прокси нет — напрямую')
})
