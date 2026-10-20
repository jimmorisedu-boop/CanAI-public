import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { ToolError } from '../ffmpegRun.js'
import type { MediaRenderRuntime } from './tool-shared.js'
import {
  FAKE_TOOLS,
  codeOf,
  fakeBytes,
  fakeRunner,
  inputSections,
  manifestOf,
  refOf,
  renderFixture,
  sha256,
  type RenderFixture,
} from './tool-media-render-testkit.js'

// Договор media.render на подставном ffmpeg: что Host принимает, что
// отвергает и что именно попадает в командную строку. Повторы, очередь и
// отмена — в tool-media-render-replay.test.ts, настоящий ffmpeg — в
// tool-media-render.integration.test.ts.

const previousDataDir = process.env.CANAI_DATA_DIR
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canai-render-data-')))
process.env.CANAI_DATA_DIR = dataDir
const { AgentToolBroker } = await import('./tools.js')
const { MEDIA_SHARED_FOLDER, resolveMediaInAsync } = await import('../mediaLayout.js')
const { RENDER_SCRATCH_DIRECTORY } = await import('./tool-media-render.js')
const { clipFrames, expectedFrames, parseRenderManifest, renderManifestHash } = await import('./tool-media-render-manifest.js')
const { renderTimeoutMs } = await import('./tool-media-render-ffmpeg.js')

after(async () => {
  if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
  else process.env.CANAI_DATA_DIR = previousDataDir
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined)
})

const VIDEO = { width: 1920, height: 1080, fps: 30, duration: 10, frames: 300 }
const IMAGE = { width: 800, height: 600 }

function brokerFor(fx: RenderFixture, fake: ReturnType<typeof fakeRunner>, extra: Partial<MediaRenderRuntime> = {}) {
  return new AgentToolBroker({ mediaDir: fx.mediaDir, workspaceRoot: fx.root, mediaRender: { tools: FAKE_TOOLS, run: fake.run, ...extra } })
}

async function standardSources(fx: RenderFixture) {
  return {
    video: await fx.add('clip', 'video', 'video/mp4', fakeBytes('video/mp4', VIDEO, { size: 4_000 })),
    image: await fx.add('still', 'image', 'image/png', fakeBytes('image/png', IMAGE, { size: 2_000 })),
  }
}

async function scratchEntries(fx: RenderFixture): Promise<string[]> {
  return fs.readdir(path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY)).catch(() => [])
}

async function publishedOutputs(fx: RenderFixture): Promise<string[]> {
  const all = await fs.readdir(fx.mediaDir, { recursive: true })
  return all.map((name) => path.basename(name)).filter((name) => name.startsWith('agent-render-'))
}

test('media.render собирает ролик из квитанций Host и публикует его обычным путём медиа', async () => {
  const fx = await renderFixture()
  try {
    const { video, image } = await standardSources(fx)
    const fake = fakeRunner()
    const manifest = manifestOf([
      { artifact: video, startMs: 500, durationMs: 1_000 },
      { artifact: image, durationMs: 1_000 },
      { artifact: video, durationMs: 1_000 },
    ])
    const executed = await brokerFor(fx, fake).execute(fx.task, 'media.render', manifest, 'render-basic')
    const artifact = executed.result.artifact as { artifactId: string; checksum: string; sizeBytes: number; mediaSrc: string; kind: string; mimeType: string; provenance: string; caption: string }

    assert.equal(artifact.kind, 'video')
    assert.equal(artifact.mimeType, 'video/mp4')
    assert.equal(artifact.provenance, 'derived')
    assert.equal(artifact.caption, 'Rough cut')
    assert.match(artifact.mediaSrc, /^\/media\/agent-render-[a-f0-9]{40}\.mp4$/u)
    assert.deepEqual(Object.keys(executed.result), ['artifact'])

    // Файл лежит там, куда медиа пишет всё остальное, и находится индексом.
    const file = await resolveMediaInAsync(fx.mediaDir, artifact.mediaSrc)
    assert.equal(path.relative(fx.mediaDir, file), path.join(MEDIA_SHARED_FOLDER, 'video', path.basename(artifact.mediaSrc)))
    const bytes = await fs.readFile(file)
    assert.equal(artifact.checksum, sha256(bytes))
    assert.equal(artifact.sizeBytes, bytes.length)

    // Lineage для журнала: исходники без повторов, манифест с подставленным кадром.
    const commit = executed.mediaRender!
    assert.equal(commit.operationId, 'render-basic')
    assert.match(commit.manifestHash, /^[a-f0-9]{64}$/u)
    assert.deepEqual(commit.sourceRefs, [refOf(video), refOf(image)])
    assert.equal(commit.manifest.frame, '1280x720')
    assert.deepEqual(commit.artifact, artifact)

    assert.equal(fake.renders().length, 1)
    assert.deepEqual(await scratchEntries(fx), [])
    // Рабочая папка агента в монтаже не участвует вовсе.
    assert.deepEqual(await fs.readdir(fx.workspace), [])
    assert.equal(JSON.stringify(executed.result).includes(fx.root), false)
  } finally {
    await fx.cleanup()
  }
})

test('манифест проверяется целиком до первого запуска ffmpeg', async () => {
  const fx = await renderFixture()
  try {
    const { video, image } = await standardSources(fx)
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const base = manifestOf([{ artifact: video, durationMs: 1_000 }, { artifact: image, durationMs: 1_000 }])
    const clip = (overrides: Record<string, unknown>) => ({ ...base, clips: [{ ...base.clips[0], ...overrides }, base.clips[1]] })
    const cases: Array<[string, unknown, string]> = [
      ['лишний ключ', { ...base, filters: 'drawtext' }, 'INPUT_INVALID'],
      ['путь вместо ref', { ...base, output: 'C:/out.mp4' }, 'INPUT_INVALID'],
      ['лишний ключ клипа', clip({ url: 'https://example.com/a.mp4' }), 'INPUT_INVALID'],
      ['лишний ключ ref', clip({ artifact: { ...base.clips[0].artifact, path: '../x' } }), 'INPUT_INVALID'],
      ['order не по порядку', clip({ order: 1 }), 'INPUT_INVALID'],
      ['fps вне набора', { ...base, fps: 23 }, 'INPUT_INVALID'],
      ['версия 2', { ...base, version: 2 }, 'INPUT_INVALID'],
      ['звук', { ...base, audio: 'keep' }, 'INPUT_INVALID'],
      ['другой режим', { ...base, mode: 'final' }, 'INPUT_INVALID'],
      ['кадр вне набора', { ...base, frame: '1920x1080' }, 'INPUT_INVALID'],
      ['33 клипа', { ...base, clips: Array.from({ length: 33 }, (_, order) => ({ ...base.clips[0], order, durationMs: 50 })) }, 'INPUT_INVALID'],
      ['ни одного клипа', { ...base, clips: [] }, 'INPUT_INVALID'],
      ['клип короче 50 мс', clip({ durationMs: 49 }), 'INPUT_INVALID'],
      ['дробная длительность', clip({ durationMs: 1000.5 }), 'INPUT_INVALID'],
      ['отрицательный старт', clip({ startMs: -1 }), 'INPUT_INVALID'],
      ['потолок размера ниже минимума', { ...base, maxOutputBytes: 65_535 }, 'INPUT_INVALID'],
      ['потолок длительности выше предела', { ...base, maxDurationMs: 300_001 }, 'INPUT_INVALID'],
      ['сумма больше потолка', { ...base, maxDurationMs: 1_999 }, 'MEDIA_RENDER_DURATION_LIMIT'],
      ['картинка со сдвигом', { ...base, clips: [base.clips[0], { ...base.clips[1], startMs: 100 }] }, 'MEDIA_RENDER_INPUT_INVALID'],
    ]
    for (const [name, manifest, code] of cases) {
      await assert.rejects(broker.execute(fx.task, 'media.render', manifest, `manifest-${cases.findIndex((entry) => entry[0] === name)}`), (error) => codeOf(error) === code, name)
    }
    assert.equal(fake.calls.length, 0)
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})

test('чужие и неподходящие refs отвергаются до ffmpeg', async () => {
  const fx = await renderFixture()
  const other = await renderFixture()
  try {
    const { video } = await standardSources(fx)
    const foreign = await other.add('foreign', 'video', 'video/mp4', fakeBytes('video/mp4', VIDEO))
    const text = await fx.add('notes', 'text', 'text/plain', Buffer.from('план'))
    const audio = await fx.add('voice', 'audio', 'audio/mpeg', fakeBytes('audio/mpeg', VIDEO))
    const gif = await fx.add('anim', 'image', 'image/gif', fakeBytes('image/gif', IMAGE))
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const one = (artifact: Parameters<typeof manifestOf>[0][number]['artifact']) => manifestOf([{ artifact, durationMs: 1_000 }])

    await assert.rejects(broker.execute(fx.task, 'media.render', one({ ...refOf(video), checksum: 'f'.repeat(64) }), 'forged-checksum'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    await assert.rejects(broker.execute(fx.task, 'media.render', one(foreign), 'other-task'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    await assert.rejects(broker.execute(fx.task, 'media.render', one(text), 'text-artifact'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_UNSUPPORTED')
    await assert.rejects(broker.execute(fx.task, 'media.render', one(audio), 'audio-artifact'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_UNSUPPORTED')
    await assert.rejects(broker.execute(fx.task, 'media.render', one(gif), 'gif-artifact'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_UNSUPPORTED')
    const cloud = { ...fx.task, projectRef: { source: 'cloud' as const, id: fx.task.projectRef.id } }
    await assert.rejects(broker.execute(cloud, 'media.render', one(video), 'cloud-task'), (error) => codeOf(error) === 'UNSUPPORTED_TOOL')
    assert.equal(fake.calls.length, 0)
  } finally {
    await fx.cleanup()
    await other.cleanup()
  }
})

test('в командной строке у каждого входа свои ограничения, а пути — только из приватной папки Host', async () => {
  const fx = await renderFixture()
  try {
    const { video, image } = await standardSources(fx)
    // libx264 «значится в сборке» (чужой системный ffmpeg) и стоит первым —
    // выбран он не должен быть никогда.
    const fake = fakeRunner({ encoders: ['libx264', 'libx264rgb', 'libopenh264'] })
    const manifest = manifestOf([
      { artifact: video, startMs: 500, durationMs: 1_000 },
      { artifact: image, durationMs: 2_000 },
      { artifact: video, durationMs: 50 },
    ], { fps: 30, maxOutputBytes: 1_000_000 })
    await brokerFor(fx, fake).execute(fx.task, 'media.render', manifest, 'argv')
    const args = fake.renders()[0].args
    const scratch = path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY) + path.sep
    const sections = inputSections(args)

    assert.equal(sections.length, 3)
    for (const section of sections) {
      const whitelist = section.options[section.options.indexOf('-format_whitelist') + 1]
      assert.equal(section.options[section.options.indexOf('-protocol_whitelist') + 1], 'file')
      assert.ok(section.options.includes('-format_whitelist'), 'у каждого входа свой белый список демультиплексоров')
      assert.ok(section.options.includes('-probesize') && section.options.includes('-analyzeduration') && section.options.includes('-max_streams'))
      assert.ok(section.file.startsWith(scratch), `вход вне приватной папки Host: ${section.file}`)
      assert.match(path.basename(section.file), /^in-\d\d\.(?:mp4|png)$/u)
      assert.equal(whitelist, section.file.endsWith('.png') ? 'image2,png_pipe' : 'mov,mp4,m4a,3gp,3g2,mj2')
    }
    // Один исходник — одна приватная копия, хоть он и стоит в двух клипах.
    assert.equal(sections[0].file, sections[2].file)
    assert.deepEqual(sections[0].options.slice(-4), ['-ss', '0.500', '-t', '1.000'])
    assert.deepEqual(sections[1].options.slice(-6), ['-loop', '1', '-framerate', '30', '-t', '2.000'])
    assert.deepEqual(sections[2].options.slice(-2), ['-t', '0.050'])
    assert.equal(sections[2].options.includes('-ss'), false)

    assert.equal(args.some((arg) => /libx264|x264/u.test(arg)), false)
    assert.equal(args[args.indexOf('-c:v') + 1], 'libopenh264')
    assert.ok(args.includes('-an'))
    assert.deepEqual(args.slice(args.indexOf('-map_metadata'), args.indexOf('-map_metadata') + 4), ['-map_metadata', '-1', '-map_chapters', '-1'])
    assert.equal(args[args.indexOf('-fs') + 1], '1000001')
    assert.ok(args.at(-1)!.startsWith(scratch))
    assert.equal(args.some((arg) => arg.includes(fx.workspace) || /^[a-z]+:\/\//iu.test(arg)), false)

    const filter = args[args.indexOf('-filter_complex') + 1]
    assert.deepEqual([...filter.matchAll(/trim=end_frame=(\d+)/gu)].map((match) => Number(match[1])), [30, 60, 2])
    assert.match(filter, /concat=n=3:v=1:a=0\[outv\]$/u)
    assert.equal(filter.includes('scale=1280:720'), true)

    // ffprobe видит те же приватные копии и итог — и тоже под ограничениями.
    for (const probe of fake.probes()) {
      assert.ok(probe.args.at(-1)!.startsWith(scratch))
      assert.equal(probe.args[probe.args.indexOf('-protocol_whitelist') + 1], 'file')
      assert.ok(probe.args.includes('-format_whitelist'))
    }
  } finally {
    await fx.cleanup()
  }
})

test('кадр результата задаётся манифестом, а «не задан» и «1280x720» — один и тот же монтаж', async () => {
  const fx = await renderFixture()
  try {
    const { video } = await standardSources(fx)
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const vertical = await broker.execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }], { frame: '720x1280' }), 'vertical')
    assert.ok(fake.renders()[0].args[fake.renders()[0].args.indexOf('-filter_complex') + 1].includes('scale=720:1280'))
    assert.equal(vertical.mediaRender!.manifest.frame, '720x1280')
    await broker.execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }], { frame: '1080x1080' }), 'square')
    assert.ok(fake.renders()[1].args[fake.renders()[1].args.indexOf('-filter_complex') + 1].includes('pad=1080:1080'))

    const implicit = manifestOf([{ artifact: video, durationMs: 1_000 }])
    const explicit = { ...implicit, frame: '1280x720' as const }
    assert.equal(renderManifestHash(parseRenderManifest(implicit)), renderManifestHash(parseRenderManifest(explicit)))
    assert.notEqual(renderManifestHash(parseRenderManifest(implicit)), renderManifestHash(parseRenderManifest({ ...implicit, frame: '720x1280' })))
    const first = await broker.execute(fx.task, 'media.render', implicit, 'landscape')
    const second = await broker.execute(fx.task, 'media.render', explicit, 'landscape')
    assert.deepEqual(second.result.artifact, first.result.artifact)
    assert.equal(fake.renders().length, 3)
  } finally {
    await fx.cleanup()
  }
})

test('число кадров считает Host, и таймаут растёт с длиной монтажа', () => {
  assert.equal(clipFrames(1_000, 24), 24)
  assert.equal(clipFrames(50, 24), 1)
  assert.equal(clipFrames(50, 30), 2)
  assert.equal(clipFrames(1_040, 25), 26)
  assert.equal(expectedFrames({ version: 1, mode: 'rough-cut', audio: 'mute', fps: 24, maxDurationMs: 9_000, maxOutputBytes: 100_000, clips: [
    { artifact: { artifactId: 'a', revision: 1, checksum: 'a'.repeat(64) }, order: 0, startMs: 0, durationMs: 1_000 },
    { artifact: { artifactId: 'a', revision: 1, checksum: 'a'.repeat(64) }, order: 1, startMs: 0, durationMs: 500 },
  ] }), 36)
  assert.equal(renderTimeoutMs(1_000), 120_000)
  assert.equal(renderTimeoutMs(30_000), 300_000)
  assert.equal(renderTimeoutMs(300_000), 600_000)
})

test('список воспроизведения под видом видео не доходит даже до ffprobe', async () => {
  const fx = await renderFixture()
  try {
    const playlist = await fx.add('playlist', 'video', 'video/mp4', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nC:/Windows/win.ini\n#EXT-X-ENDLIST\n'))
    const concat = await fx.add('concat', 'video', 'video/mp4', Buffer.from('\uFEFFffconcat version 1.0\nfile C:/secret.mp4\n'))
    const notPng = await fx.add('fake-image', 'image', 'image/png', fakeBytes('image/jpeg', IMAGE))
    const hls = await fx.add('hls', 'video', 'video/mp4', fakeBytes('video/mp4', { ...VIDEO, formatName: 'hls' }))
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    for (const [index, artifact] of [playlist, concat, notPng].entries()) {
      await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact, durationMs: 1_000 }]), `unsafe-${index}`), (error) => codeOf(error) === 'MEDIA_RENDER_FORMAT_UNSAFE')
    }
    assert.equal(fake.probes().length, 0)
    // Сигнатура верная, но ffprobe называет чужой демультиплексор.
    await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact: hls, durationMs: 1_000 }]), 'unsafe-hls'), (error) => codeOf(error) === 'MEDIA_RENDER_FORMAT_UNSAFE')
    assert.equal(fake.renders().length, 0)
    assert.deepEqual(await publishedOutputs(fx), [])
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})

test('обычные снимки с адресами в метаданных принимаются', async () => {
  const fx = await renderFixture()
  try {
    // XMP в JPEG: маркер APP1 с дословным адресом Adobe в первых байтах файла.
    const xmpHeader = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x01, 0x00]), Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/">', 'latin1')])
    const c2paHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('caBX https://c2pa.org/specifications file://manifest', 'latin1')])
    const jpeg = await fx.add('photo', 'image', 'image/jpeg', fakeBytes('image/jpeg', IMAGE, { prefix: xmpHeader }))
    const png = await fx.add('signed', 'image', 'image/png', fakeBytes('image/png', IMAGE, { prefix: c2paHeader }))
    const mov = await fx.add('classic', 'video', 'video/quicktime', fakeBytes('video/quicktime', VIDEO))
    const webm = await fx.add('web', 'video', 'video/webm', fakeBytes('video/webm', VIDEO))
    const webp = await fx.add('modern', 'image', 'image/webp', fakeBytes('image/webp', IMAGE))
    const fake = fakeRunner()
    const executed = await brokerFor(fx, fake).execute(fx.task, 'media.render', manifestOf([
      { artifact: jpeg, durationMs: 500 }, { artifact: png, durationMs: 500 }, { artifact: mov, durationMs: 500 },
      { artifact: webm, durationMs: 500 }, { artifact: webp, durationMs: 500 },
    ]), 'metadata-urls')
    assert.equal((executed.result.artifact as { kind: string }).kind, 'video')
    const whitelists = inputSections(fake.renders()[0].args).map((section) => section.options[section.options.indexOf('-format_whitelist') + 1])
    assert.deepEqual(whitelists, ['image2,jpeg_pipe', 'image2,png_pipe', 'mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'image2,webp_pipe'])

    // Анимированный WebP: флаг анимации в заголовке VP8X.
    const animated = Buffer.concat([Buffer.from('RIFF\x20\0\0\0WEBPVP8X\x0a\0\0\0', 'latin1'), Buffer.from([0x02, 0, 0, 0])])
    const animatedWebp = await fx.add('animated', 'image', 'image/webp', fakeBytes('image/webp', IMAGE, { prefix: animated }))
    await assert.rejects(brokerFor(fx, fake).execute(fx.task, 'media.render', manifestOf([{ artifact: animatedWebp, durationMs: 500 }]), 'animated-webp'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_UNSUPPORTED')
  } finally {
    await fx.cleanup()
  }
})

async function createDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(codeOf(error) ?? '')) return false
    throw error
  }
}

async function createFileLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file')
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(codeOf(error) ?? '')) return false
    throw error
  }
}

test('выход из медиа через «..», ссылку и junction отвергается', async (t) => {
  const fx = await renderFixture()
  try {
    const { video, image } = await standardSources(fx)
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const one = manifestOf([{ artifact: video, durationMs: 1_000 }])

    const traversal = { ...fx.task, artifacts: [{ ...video, mediaSrc: '/media/../outside.mp4' as `/media/${string}` }] }
    await assert.rejects(broker.execute(traversal, 'media.render', one, 'traversal'), (error) => codeOf(error) === 'PATH_INVALID')

    // Junction на месте корня медиа.
    const mediaLink = path.join(fx.root, 'media-link')
    if (!await createDirectoryLink(fx.mediaDir, mediaLink)) {
      t.skip('OS does not permit creating a symlink/junction in the test fixture')
      return
    }
    const linked = new AgentToolBroker({ mediaDir: mediaLink, workspaceRoot: fx.root, mediaRender: { tools: FAKE_TOOLS, run: fake.run } })
    await assert.rejects(linked.execute(fx.task, 'media.render', one, 'media-root-link'), (error) => codeOf(error) === 'PATH_INVALID')

    // Junction на месте приватной папки рендера.
    const outside = path.join(fx.root, 'outside')
    await fs.mkdir(outside)
    await createDirectoryLink(outside, path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY))
    await assert.rejects(broker.execute(fx.task, 'media.render', one, 'scratch-link'), (error) => codeOf(error) === 'PATH_INVALID')
    await fs.rm(path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY), { recursive: true, force: true })
    assert.deepEqual(await fs.readdir(outside), [])

    // Junction на месте папки, куда ложится результат: рендер проходит, а
    // публикация — нет, и снаружи не появляется даже пустой папки.
    await createDirectoryLink(outside, path.join(fx.mediaDir, MEDIA_SHARED_FOLDER))
    await assert.rejects(broker.execute(fx.task, 'media.render', one, 'publish-link'), (error) => codeOf(error) === 'PATH_INVALID')
    assert.deepEqual(await fs.readdir(outside), [])
    await fs.rm(path.join(fx.mediaDir, MEDIA_SHARED_FOLDER), { recursive: true, force: true })
    assert.deepEqual(await scratchEntries(fx), [])

    // Ссылка на месте уже выпущенного результата.
    const executed = await broker.execute(fx.task, 'media.render', manifestOf([{ artifact: image, durationMs: 1_000 }]), 'output-link')
    const published = await resolveMediaInAsync(fx.mediaDir, (executed.result.artifact as { mediaSrc: string }).mediaSrc)
    const stolen = path.join(outside, 'stolen.mp4')
    await fs.rename(published, stolen)
    if (await createFileLink(stolen, published)) {
      await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact: image, durationMs: 1_000 }]), 'output-link'), (error) => codeOf(error) === 'PATH_INVALID')
      await fs.rm(published, { force: true })
    }

    // Ссылка на месте исходника.
    const source = path.join(fx.mediaDir, path.basename(video.mediaSrc))
    const moved = path.join(outside, 'source.mp4')
    await fs.rename(source, moved)
    if (!await createFileLink(moved, source)) {
      t.diagnostic('OS does not permit creating a file symlink: source/output link cases skipped')
      return
    }
    await assert.rejects(broker.execute(fx.task, 'media.render', one, 'source-link'), (error) => codeOf(error) === 'PATH_INVALID')
  } finally {
    await fx.cleanup()
  }
})

test('исходник, подменённый между проверкой и рендером, останавливает монтаж', async () => {
  const fx = await renderFixture()
  try {
    const { video } = await standardSources(fx)
    const fake = fakeRunner()
    // Приватная копия вышла не теми байтами, что проверенный исходник.
    const swapped = brokerFor(fx, fake, { link: async (_from, to) => { await fs.writeFile(to, fakeBytes('video/mp4', { ...VIDEO, width: 640 }, { size: 4_000 })) } })
    await assert.rejects(swapped.execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }]), 'swapped'), (error) => codeOf(error) === 'FILE_INVALID')
    assert.equal(fake.probes().length, 0)
    assert.equal(fake.renders().length, 0)

    // Исходник в медиа изменили после выдачи квитанции.
    await fs.writeFile(path.join(fx.mediaDir, path.basename(video.mediaSrc)), fakeBytes('video/mp4', { ...VIDEO, width: 320 }, { size: 4_000 }))
    await assert.rejects(brokerFor(fx, fake).execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }]), 'changed'), (error) => codeOf(error) === 'FILE_INVALID')
    assert.equal(fake.renders().length, 0)
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})

test('на томе без жёстких ссылок монтаж идёт по копиям, а исходники остаются на месте', async () => {
  const fx = await renderFixture()
  try {
    const { video, image } = await standardSources(fx)
    const fake = fakeRunner()
    let attempts = 0
    const noLinks = brokerFor(fx, fake, {
      link: async () => {
        attempts += 1
        throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
      },
    })
    const executed = await noLinks.execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }, { artifact: image, durationMs: 1_000 }]), 'no-links')
    const artifact = executed.result.artifact as { mediaSrc: string; checksum: string }
    assert.equal(attempts, 3) // два исходника и публикация результата
    assert.equal(sha256(await fs.readFile(await resolveMediaInAsync(fx.mediaDir, artifact.mediaSrc))), artifact.checksum)
    assert.equal(sha256(await fs.readFile(path.join(fx.mediaDir, path.basename(video.mediaSrc)))), video.checksum)
    assert.equal(sha256(await fs.readFile(path.join(fx.mediaDir, path.basename(image.mediaSrc)))), image.checksum)
    assert.deepEqual(await scratchEntries(fx), [])
    assert.equal((await publishedOutputs(fx)).length, 1)
  } finally {
    await fx.cleanup()
  }
})

test('пределы входа: сторона кадра, суммарный вес, длительность исходника', async () => {
  const fx = await renderFixture()
  try {
    const { video } = await standardSources(fx)
    const huge = await fx.add('huge', 'image', 'image/png', fakeBytes('image/png', { width: 9_000, height: 600 }))
    const silentDuration = await fx.add('no-duration', 'video', 'video/webm', fakeBytes('video/webm', { width: 640, height: 360, fps: 30 }))
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)

    await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact: huge, durationMs: 1_000 }]), 'huge-frame'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_LIMIT')
    // Исходник длится 10 с; запас на расхождение контейнера и дорожки — 80 мс.
    await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact: video, startMs: 9_500, durationMs: 600 }]), 'beyond-end'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_INVALID')
    await assert.rejects(broker.execute(fx.task, 'media.render', manifestOf([{ artifact: silentDuration, durationMs: 600 }]), 'no-duration'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_INVALID')
    assert.equal(fake.renders().length, 0)
    await broker.execute(fx.task, 'media.render', manifestOf([{ artifact: video, startMs: 9_500, durationMs: 580 }]), 'within-slack')
    assert.equal(fake.renders().length, 1)

    // Суммарный вес считается по квитанциям — до очереди и до диска.
    const heavy = Array.from({ length: 5 }, (_, index) => ({
      artifactId: `heavy-${index}`, revision: 1, checksum: String(index).repeat(64), kind: 'video' as const, caption: 'heavy', mimeType: 'video/mp4',
      sizeBytes: 500 * 1024 * 1024, mediaSrc: `/media/heavy-${index}.mp4` as `/media/${string}`, provenance: 'generated' as const,
    }))
    const before = fake.calls.length
    await assert.rejects(broker.execute({ ...fx.task, artifacts: heavy }, 'media.render', manifestOf(heavy.map((artifact) => ({ artifact, durationMs: 1_000 }))), 'heavy'), (error) => codeOf(error) === 'MEDIA_RENDER_INPUT_LIMIT')
    assert.equal(fake.calls.length, before)
  } finally {
    await fx.cleanup()
  }
})

test('кодировщик берётся общим выбором проекта: неработающий аппаратный уступает следующему, x264 не берётся никогда', async () => {
  const fx = await renderFixture()
  try {
    const { video } = await standardSources(fx)
    const one = manifestOf([{ artifact: video, durationMs: 1_000 }])

    // NVENC значится в сборке и на машине без видеокарты NVIDIA.
    const fallback = fakeRunner({
      encoders: ['libopenh264', 'h264_nvenc', 'libx264'],
      render: async (call) => {
        if (call.encoder === 'h264_nvenc') throw new ToolError('Обработчик завершился с ошибкой (1)', `[h264_nvenc] Cannot load nvcuda.dll\nError opening output ${call.output}`)
        await call.write()
      },
    })
    await brokerFor(fx, fallback).execute(fx.task, 'media.render', one, 'encoder-fallback')
    assert.deepEqual(fallback.renders().map((call) => call.args[call.args.indexOf('-c:v') + 1]), ['h264_nvenc', 'libopenh264'])

    const onlyGpl = fakeRunner({ encoders: ['libx264', 'libx265', 'mpeg4'] })
    await assert.rejects(brokerFor(fx, onlyGpl).execute(fx.task, 'media.render', one, 'gpl-only'), (error) => codeOf(error) === 'MEDIA_RENDER_UNAVAILABLE')
    assert.equal(onlyGpl.renders().length, 0)

    // Все кодировщики отказали: причина доходит словами, но без путей Host.
    const broken = fakeRunner({
      encoders: ['h264_nvenc', 'libopenh264'],
      render: async (call) => { throw new ToolError('Обработчик завершился с ошибкой (1)', `Error opening input file ${call.args[call.args.indexOf('-i') + 1]}.\nInvalid data found when processing input`) },
    })
    await assert.rejects(brokerFor(fx, broken).execute(fx.task, 'media.render', one, 'all-broken'), (error) => {
      const message = (error as Error).message
      return codeOf(error) === 'MEDIA_RENDER_FAILED' && message.includes('Invalid data found') && !message.includes(fx.root) && !message.includes(fx.root.replaceAll('\\', '/'))
    })
    assert.equal(broken.renders().length, 2)
    assert.deepEqual(await publishedOutputs(fx).then((names) => names.length), 1)
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})
