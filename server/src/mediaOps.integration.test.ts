import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import express from 'express'

const exec = promisify(execFile)

test('реальные cut/crop и mock создают совместимое видео и отвергают пустые диапазоны', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-regression-'))
  const previous = Object.fromEntries(['CANAI_DATA_DIR', 'CANAI_ENV_FILE', 'CANAI_MOCK'].map((key) => [key, process.env[key]]))
  const emptyEnv = path.join(directory, 'empty.env')
  await fs.writeFile(emptyEnv, '')
  process.env.CANAI_DATA_DIR = directory
  process.env.CANAI_ENV_FILE = emptyEnv
  process.env.CANAI_MOCK = '1'
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory))
    assert.ok(relative.startsWith('canai-media-regression-') && !relative.includes(path.sep))
    await fs.rm(directory, { recursive: true, force: true })
  })

  // Импорт только после установки окружения: пользовательские .env и data не читаются.
  const { ffmpegBinary } = await import('./ffmpegTools.js')
  const tools = await ffmpegBinary.locate()
  if (!tools) return t.skip('FFmpeg/ffprobe не установлены; интеграционный тест не скачивает компоненты')
  const { createMediaToolsRouter } = await import('./mediaToolsRoutes.js')
  const { mediaWritePath } = await import('./mediaLayout.js')
  const { mediaFilePath } = await import('./storage.js')
  const { mockVideo } = await import('./mock.js')
  const { parseEncoders, pickEncoder } = await import('./videoEncoder.js')
  const { stdout } = await exec(tools.ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true })
  const available = parseEncoders(stdout)
  const h264 = available.has('libopenh264') ? 'libopenh264' : pickEncoder(available)
  assert.ok(h264, 'Переносимая сборка должна предоставлять H.264')

  const app = express()
  app.use(express.json())
  app.use('/api', createMediaToolsRouter(ffmpegBinary))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const cut = async (src: string, segments: Array<{ start: number; end: number }>, crop?: object) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/media/cut-video`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src, segments, crop }),
    })
    return { status: response.status, body: await response.json() as { error?: string; pieces?: Array<{ url: string; mime: string; width: number; height: number; duration: number }> } }
  }
  const makeVideo = async (name: string, codec: string, audio: string, videoDuration = 3) => {
    const output = await mediaWritePath(name)
    await exec(tools.ffmpeg, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x240:r=24:d=${videoDuration}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', audio, output,
    ], { windowsHide: true })
    return `/media/${name}`
  }
  const inspect = async (url: string) => {
    const file = mediaFilePath(url)
    const { stdout } = await exec(tools.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true })
    // Существование контейнера недостаточно: настоящий декодер обязан прочитать видео.
    await exec(tools.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true })
    return JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; nb_read_frames?: string; duration?: string; pix_fmt?: string }> }
  }
  const cutFiles = async () => (await fs.readdir(directory, { recursive: true })).filter((name) => path.basename(name).startsWith('cut-')).sort()
  const mp4 = await makeVideo('source.mp4', h264, 'aac')

  await t.test('звук извлекается из файла облачного кэша без media URL', async () => {
    const { extractAudioFile } = await import('./mediaOps.js')
    const cachedFile = path.join(directory, 'cloud-video.bin')
    await fs.copyFile(mediaFilePath(mp4), cachedFile)
    const audio = await extractAudioFile(cachedFile)
    assert.equal(audio.mime, 'audio/mpeg')
    assert.ok(audio.url.startsWith('/media/'))
    const { stdout } = await exec(tools.ffprobe, [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', mediaFilePath(audio.url),
    ], { windowsHide: true })
    const stream = JSON.parse(stdout) as { streams: Array<{ codec_name: string }> }
    assert.equal(stream.streams[0]?.codec_name, 'mp3')
  })

  for (const crop of [undefined, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }]) {
    await t.test(`VP9/Opus WebM ${crop ? 'кадрируется' : 'нарезается'} в декодируемое видео`, async (t) => {
      if (!available.has('libvpx-vp9') || !available.has('libopus')) return t.skip('Сборка не содержит VP9/Opus для fixture')
      const src = await makeVideo(`source-${crop ? 'crop' : 'cut'}.webm`, 'libvpx-vp9', 'libopus')
      const result = await cut(src, [{ start: 0.5, end: 1.5 }], crop)
      assert.equal(result.status, 200, JSON.stringify(result.body))
      const piece = result.body.pieces![0]
      assert.equal(piece.mime, 'video/mp4')
      assert.ok(piece.url.endsWith('.mp4'))
      assert.equal(piece.width, crop ? 160 : 320)
      assert.equal(piece.height, crop ? 120 : 240)
      const facts = await inspect(piece.url)
      const video = facts.streams.find((stream) => stream.codec_type === 'video')!
      assert.equal(video.codec_name, 'h264')
      assert.equal(Number(video.nb_read_frames), 24)
      assert.equal(facts.streams.find((stream) => stream.codec_type === 'audio')?.codec_name, 'aac')
    })
  }

  await t.test('диапазоны за концом исходника отвергаются целиком без выходных файлов', async () => {
    const before = await cutFiles()
    for (const segments of [
      [{ start: 4, end: 5 }],
      [{ start: 2.5, end: 3.5 }],
      [{ start: 0, end: 1 }, { start: 4, end: 5 }],
    ]) {
      const result = await cut(mp4, segments)
      assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result))
      assert.ok(result.body.error)
      assert.equal(result.body.pieces, undefined)
      assert.deepEqual(await cutFiles(), before)
    }
  })

  await t.test('звуковой хвост после последнего видеокадра не становится успешным клипом', async () => {
    const src = await makeVideo('long-audio.mp4', h264, 'aac', 1)
    const before = await cutFiles()
    for (const segments of [
      [{ start: 1.5, end: 2.5 }],
      [{ start: 0, end: 0.5 }, { start: 1.5, end: 2.5 }],
    ]) {
      const result = await cut(src, segments)
      assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result))
      assert.ok(result.body.error)
      assert.equal(result.body.pieces, undefined)
      assert.deepEqual(await cutFiles(), before, 'Вся неудавшаяся партия и временные файлы удалены')
    }
  })

  await t.test('дробный рез до последнего кадра сохраняет длину и звук', async () => {
    const result = await cut(mp4, [{ start: 1.75, end: 3 }], { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const facts = await inspect(result.body.pieces![0].url)
    const video = facts.streams.find((stream) => stream.codec_type === 'video')!
    assert.equal(Number(video.nb_read_frames), 30)
    assert.equal(video.width, 160)
    assert.equal(video.height, 120)
    assert.ok(Math.abs(Number(video.duration) - 1.25) < 0.05)
    assert.ok(Math.abs(Number(facts.streams.find((stream) => stream.codec_type === 'audio')?.duration) - 1.25) < 0.08)
  })

  await t.test('нарезка немого видео не требует звуковой дорожки', async () => {
    const file = await mediaWritePath('silent.mp4')
    await exec(tools.ffmpeg, ['-v', 'error', '-y', '-i', mediaFilePath(mp4), '-an', '-c:v', 'copy', file], { windowsHide: true })
    const result = await cut('/media/silent.mp4', [{ start: 0.5, end: 1.5 }])
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const facts = await inspect(result.body.pieces![0].url)
    assert.equal(Number(facts.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames), 24)
    assert.equal(facts.streams.some((stream) => stream.codec_type === 'audio'), false)
  })

  await t.test('mock-видео явно использует браузерный H.264 с 48 декодируемыми кадрами', async () => {
    const result = await mockVideo('browser-mock')
    const facts = await inspect(result.url)
    const video = facts.streams.find((stream) => stream.codec_type === 'video')!
    assert.equal(video.codec_name, 'h264')
    assert.equal(video.pix_fmt, 'yuv420p')
    assert.equal(Number(video.nb_read_frames), 48)
    assert.equal(Number(video.duration), 2)
  })
})
