import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import {
  resolveMediaLink,
  type ResolverDeps,
  type ToolRunResult,
} from './mediaLinkResolver.js'

async function samplePng(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 2, channels: 3, background: '#ff452d' },
  }).png().toBuffer()
}

function remoteResponse(body: Buffer | string | null, contentType: string, status = 200): {
  response: Response
  finalUrl: URL
} {
  return {
    response: new Response(Buffer.isBuffer(body) ? Uint8Array.from(body).buffer : body, { status, headers: { 'content-type': contentType } }),
    finalUrl: new URL('https://cdn.test/final'),
  }
}

test('direct image creates one stable entry and a local webp thumbnail', async () => {
  const png = await samplePng()
  const previews: Buffer[] = []
  const deps: ResolverDeps = {
    openRemote: async () => remoteResponse(png, 'image/png'),
    savePreview: async (buffer, baseName) => {
      previews.push(buffer)
      return `/media/${baseName}.webp`
    },
  }

  const first = await resolveMediaLink('https://cdn.test/photo.png', deps)
  const second = await resolveMediaLink('https://cdn.test/photo.png', deps)
  assert.equal(first.public.provider, 'direct')
  assert.equal(first.public.previewSrc, `/media/link-preview-${first.public.entries[0].id}.webp`)
  assert.equal(first.public.previewKind, 'image')
  assert.deepEqual(first.public.entries, [{
    id: first.public.entries[0].id,
    kind: 'image',
    title: 'photo.png',
    aspectRatio: 2,
  }])
  assert.match(first.public.entries[0].id, /^[a-f0-9]{16}$/)
  assert.equal(first.public.entries[0].id, second.public.entries[0].id)
  assert.deepEqual(first.entries[0].download, { type: 'remote', url: 'https://cdn.test/photo.png' })
  const metadata = await sharp(previews[0]).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 4)
  assert.equal(metadata.height, 2)
})

test('direct video creates one entry and declares guarded video preview', async () => {
  const result = await resolveMediaLink('https://cdn.test/clip.mp4', {
    openRemote: async () => remoteResponse(null, 'video/mp4', 206),
  })
  assert.equal(result.public.previewKind, 'video')
  assert.equal(result.public.previewSrc, undefined)
  assert.equal(result.public.entries[0].kind, 'video')
  assert.deepEqual(result.entries[0].download, { type: 'remote', url: 'https://cdn.test/clip.mp4' })
})

function socialDeps(lines: unknown[], extraRuns: Record<string, ToolRunResult> = {}): ResolverDeps {
  const png = Buffer.from('not-used')
  return {
    tools: { locate: async (tool) => `C:/runtime/${tool}.exe` },
    runTool: async (executable) => {
      if (executable.includes('gallery-dl')) return { stdout: lines.map((line) => JSON.stringify(line)).join('\n'), stderr: '' }
      return extraRuns['yt-dlp'] ?? { stdout: '', stderr: '' }
    },
    openRemote: async () => remoteResponse(png, 'image/jpeg'),
    savePreview: async (_buffer, baseName) => `/media/${baseName}.webp`,
    makeThumbnail: async () => Buffer.from('webp'),
  }
}

test('gallery-dl JSONL preserves Instagram carousel order and mixed kinds', async () => {
  const result = await resolveMediaLink('https://www.instagram.com/p/POST/', socialDeps([
    {
      id: 'POST_1', extension: 'jpg', url: 'https://cdn.instagram.test/one.jpg',
      width: 1200, height: 1500, title: 'Карусель',
      _http_headers: { Referer: 'https://www.instagram.com/', Cookie: 'secret' },
    },
    {
      id: 'POST_2', extension: 'mp4', url: 'https://cdn.instagram.test/two.mp4',
      width: 1080, height: 1920, title: 'Карусель',
      _http_headers: { 'User-Agent': 'gallery-dl', Authorization: 'secret' },
    },
  ]))

  assert.equal(result.public.title, 'Карусель')
  assert.deepEqual(result.public.entries.map((entry) => entry.kind), ['image', 'video'])
  assert.deepEqual(result.public.entries.map((entry) => entry.aspectRatio), [0.8, 0.5625])
  assert.deepEqual(result.entries.map((entry) => entry.download), [
    {
      type: 'remote', url: 'https://cdn.instagram.test/one.jpg',
      headers: { Referer: 'https://www.instagram.com/' },
    },
    {
      type: 'remote', url: 'https://cdn.instagram.test/two.mp4',
      headers: { 'User-Agent': 'gallery-dl' },
    },
  ])
  assert.notEqual(result.public.entries[0].id, result.public.entries[1].id)
})

test('gallery-dl JSONL preserves TikTok photo order', async () => {
  const lines = [1, 2, 3].map((number) => ({
    id: `photo-${number}`,
    extension: 'webp',
    url: `https://cdn.tiktok.test/${number}.webp`,
    width: 900,
    height: 1200,
    title: 'Три фото',
  }))
  const result = await resolveMediaLink('https://www.tiktok.com/@demo/video/7', socialDeps(lines))
  assert.deepEqual(result.entries.map((entry) => (
    entry.download.type === 'remote' ? entry.download.url : ''
  )), [
    'https://cdn.tiktok.test/1.webp',
    'https://cdn.tiktok.test/2.webp',
    'https://cdn.tiktok.test/3.webp',
  ])
  assert.deepEqual(result.public.entries.map((entry) => entry.kind), ['image', 'image', 'image'])
})

test('yt-dlp JSON maps YouTube title, local thumbnail and one video entry', async () => {
  const fallbacks: string[] = []
  const result = await resolveMediaLink('https://youtu.be/abc123', {
    tools: { locate: async () => 'C:/runtime/yt-dlp.exe' },
    runTool: async () => ({
      stdout: JSON.stringify({
        id: 'abc123', title: 'Демо ролик', width: 1920, height: 1080,
        thumbnail: 'https://i.ytimg.test/abc.jpg',
      }),
      stderr: '',
    }),
    openRemote: async () => { throw new Error('ConnectTimeoutError') },
    extractorPreview: async (provider, url, entryId) => {
      fallbacks.push(`${provider}:${url}:${entryId}`)
      return '/media/fallback.webp'
    },
  })
  assert.equal(result.public.title, 'Демо ролик')
  assert.equal(result.public.previewSrc, '/media/fallback.webp')
  assert.equal(result.public.previewSrc?.includes('ytimg'), false)
  assert.deepEqual(fallbacks, [`youtube:https://youtu.be/abc123:${result.public.entries[0].id}`])
  assert.deepEqual(result.entries[0].download, { type: 'yt-dlp', url: 'https://youtu.be/abc123' })
  assert.equal(result.public.entries[0].aspectRatio, 16 / 9)
})

test('yt-dlp JSON maps Vimeo, keeps download on yt-dlp and stores a local preview', async () => {
  const calls: string[][] = []
  const fallbacks: string[] = []
  const result = await resolveMediaLink('https://player.vimeo.com/video/12345', {
    tools: { locate: async () => 'C:/runtime/yt-dlp.exe' },
    runTool: async (_executable, args) => {
      calls.push(args)
      return {
        stdout: JSON.stringify({
          id: '12345', title: 'Закрытый ролик', width: 1280, height: 720,
          thumbnail: 'https://cdn.vimeo.test/thumb.jpg',
        }),
        stderr: '',
      }
    },
    openRemote: async () => { throw new Error('CDN недоступен') },
    extractorPreview: async (provider, url, entryId) => {
      fallbacks.push(`${provider}:${url}:${entryId}`)
      return '/media/vimeo-preview.webp'
    },
  })

  assert.equal(result.public.provider, 'vimeo')
  assert.equal(result.public.sourceLabel, 'Vimeo')
  assert.equal(result.public.previewSrc, '/media/vimeo-preview.webp')
  assert.equal(result.public.previewKind, 'image')
  assert.deepEqual(result.entries[0].download, {
    type: 'yt-dlp', url: 'https://player.vimeo.com/video/12345',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.at(-1), 'https://player.vimeo.com/video/12345')
  assert.deepEqual(fallbacks, [`vimeo:https://player.vimeo.com/video/12345:${result.public.entries[0].id}`])
})

test('private Vimeo errors are short Russian messages without extractor details', async () => {
  const secretDump = 'C:\\runtime\\yt-dlp.exe: Private video COOKIE=secret'
  await assert.rejects(resolveMediaLink('https://vimeo.com/private', {
    tools: { locate: async () => 'C:/runtime/yt-dlp.exe' },
    runTool: async () => {
      const error = new Error(secretDump) as Error & { stderr?: string }
      error.stderr = secretDump
      throw error
    },
  }), (error: unknown) => {
    assert(error instanceof Error)
    assert.match(error.message, /Vimeo|проверьте ссылку|доступность публикации/u)
    assert.equal(error.message.includes('COOKIE'), false)
    assert.equal(error.message.includes('C:\\runtime'), false)
    return true
  })
})

test('gallery provider uses extractor preview when its CDN cannot be fetched', async () => {
  const deps = socialDeps([{
    id: 'POST_1', extension: 'jpg', url: 'https://cdn.instagram.test/one.jpg',
    width: 1200, height: 1500, title: 'Карусель',
  }])
  const fallbacks: string[] = []
  deps.openRemote = async () => { throw new Error('ConnectTimeoutError') }
  deps.extractorPreview = async (provider, url, entryId) => {
    fallbacks.push(`${provider}:${url}:${entryId}`)
    return '/media/gallery-fallback.webp'
  }

  const result = await resolveMediaLink('https://www.instagram.com/p/POST/', deps)
  assert.equal(result.public.previewSrc, '/media/gallery-fallback.webp')
  assert.deepEqual(fallbacks, [`instagram:https://www.instagram.com/p/POST/:${result.public.entries[0].id}`])
})

test('provider errors become Russian public messages without stderr dump', async () => {
  const forceRefresh: boolean[] = []
  const secretDump = 'C:\\Users\\Name\\runtime\\gallery-dl.exe: Unsupported URL COOKIE=secret'
  await assert.rejects(resolveMediaLink('https://www.instagram.com/p/broken/', {
    tools: {
      locate: async (_tool, options) => {
        forceRefresh.push(options?.forceRefresh === true)
        return 'C:/runtime/gallery-dl.exe'
      },
    },
    runTool: async () => {
      const error = new Error(secretDump) as Error & { stderr?: string }
      error.stderr = secretDump
      throw error
    },
  }), (error: unknown) => {
    assert(error instanceof Error)
    assert.match(error.message, /Instagram|extractor необходимо обновить/)
    assert.equal(error.message.includes('COOKIE'), false)
    assert.equal(error.message.includes('C:\\Users'), false)
    return true
  })
  assert.deepEqual(forceRefresh, [false, true])
})

test('требование входа в аккаунт не выдаётся за битую ссылку и не обновляет extractor', async () => {
  // Дословный ответ yt-dlp 2026.08.19 на ПУБЛИЧНЫЙ ролик Vimeo (18.09.2026).
  const live = 'ERROR: [vimeo] 315204505: The web client only works when logged-in. '
    + 'Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, '
    + 'or --netrc (vimeo) to provide account credentials.'
  const locations: boolean[] = []
  await assert.rejects(resolveMediaLink('https://vimeo.com/315204505?fl=pl&fe=sh', {
    tools: {
      locate: async (_tool, options) => {
        locations.push(options?.forceRefresh === true)
        return 'C:/runtime/yt-dlp.exe'
      },
    },
    runTool: async () => {
      const error = new Error(live) as Error & { stderr?: string }
      error.stderr = live
      throw error
    },
  }), (error: unknown) => {
    assert(error instanceof Error)
    assert.match(error.message, /Vimeo.*sign in/u)
    assert.doesNotMatch(error.message, /Проверьте ссылку|extractor необходимо обновить/u)
    assert.equal(error.message.includes('--cookies'), false)
    assert.equal(error.message.includes('C:/runtime'), false)
    return true
  })
  // Обновление инструмента вход не выдаёт — второй закачки быть не должно.
  assert.deepEqual(locations, [false])
})
