import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { ToolError } from '../ffmpegRun.js'
import type { AgentArtifact } from '../../../packages/agent-protocol/index.js'
import type { MediaRenderRuntime, ToolResult } from './tool-shared.js'
import type { AgentTaskRecord } from './types.js'
import {
  FAKE_TOOLS,
  codeOf,
  fakeBytes,
  fakeRunner,
  manifestOf,
  refOf,
  renderFixture,
  type RenderCall,
  type RenderFixture,
} from './tool-media-render-testkit.js'

// media.render во времени: повтор после потери квитанции и перезапуска,
// переезд файла при раскладке по доскам, очередь, отмена, таймаут, обрыв.

const previousDataDir = process.env.CANAI_DATA_DIR
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canai-render-replay-')))
process.env.CANAI_DATA_DIR = dataDir
const { AgentToolBroker } = await import('./tools.js')
const { MEDIA_TYPE_FOLDERS, resolveMediaInAsync, sortMediaByBoards } = await import('../mediaLayout.js')
const { RENDER_SCRATCH_DIRECTORY, cancelMediaRenders, cleanMediaRenderScratch } = await import('./tool-media-render.js')
const { pendingMediaRenders, runExclusiveRender } = await import('./tool-media-render-queue.js')
const { hostRenderOperationFor } = await import('./types.js')

after(async () => {
  if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
  else process.env.CANAI_DATA_DIR = previousDataDir
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined)
})

const VIDEO = { width: 1920, height: 1080, fps: 30, duration: 10, frames: 300 }

function brokerFor(fx: RenderFixture, fake: ReturnType<typeof fakeRunner>, extra: Partial<MediaRenderRuntime> = {}) {
  return new AgentToolBroker({ mediaDir: fx.mediaDir, workspaceRoot: fx.root, mediaRender: { tools: FAKE_TOOLS, run: fake.run, ...extra } })
}

async function videoSource(fx: RenderFixture, name = 'clip'): Promise<AgentArtifact> {
  return fx.add(name, 'video', 'video/mp4', fakeBytes('video/mp4', VIDEO, { size: 4_000 }))
}

async function scratchEntries(fx: RenderFixture): Promise<string[]> {
  return fs.readdir(path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY)).catch(() => [])
}

async function publishedOutputs(fx: RenderFixture): Promise<string[]> {
  const all = await fs.readdir(fx.mediaDir, { recursive: true })
  return all.map((name) => path.basename(name)).filter((name) => name.startsWith('agent-render-'))
}

/** То, что Host записал бы в журнал вместе с квитанцией. */
function committed(task: AgentTaskRecord, executed: ToolResult): AgentTaskRecord {
  const commit = executed.mediaRender!
  return {
    ...task,
    artifacts: [...task.artifacts, structuredClone(commit.artifact)],
    receipts: [...task.receipts, { operationId: commit.operationId, tool: 'media.render', receiptId: `receipt-${commit.operationId}`, status: 'succeeded', result: executed.result, argumentsHash: 'hash', createdAt: 1 }],
    mediaRenderOperations: [...(task.mediaRenderOperations ?? []), {
      operationId: commit.operationId, receiptId: `receipt-${commit.operationId}`, argumentsHash: 'hash', manifestHash: commit.manifestHash,
      sourceRefs: commit.sourceRefs, artifact: refOf(commit.artifact), manifest: commit.manifest, createdAt: 1, updatedAt: 1,
    }],
  }
}

function waitFor(condition: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) resolve()
      else if (Date.now() - started > 5_000) reject(new Error(`не дождались: ${label}`))
      else setTimeout(tick, 5)
    }
    tick()
  })
}

/** Рендер, который «идёт», пока его не убьют отменой. */
function hangingRender(started: () => void) {
  return (call: RenderCall) => new Promise<void>((_resolve, reject) => {
    started()
    call.signal?.addEventListener('abort', () => reject(new ToolError('Обработка отменена', '', 'aborted')), { once: true })
  })
}

test('повтор после потери квитанции и перезапуска возвращает тот же артефакт без нового рендера', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const manifest = manifestOf([{ artifact: video, startMs: 1_000, durationMs: 2_000 }])
    const first = fakeRunner()
    const executed = await brokerFor(fx, first).execute(fx.task, 'media.render', manifest, 'render-replay')
    assert.equal(first.renders().length, 1)

    // Квитанция не записалась, Host перезапущен: новый брокер, журнал об
    // операции не знает. Готовый файл обязан найтись, а ffmpeg — не запуститься.
    const second = fakeRunner()
    const replayed = await brokerFor(fx, second).execute(fx.task, 'media.render', manifest, 'render-replay')
    assert.deepEqual(replayed.result, executed.result)
    assert.deepEqual(replayed.mediaRender!.sourceRefs, executed.mediaRender!.sourceRefs)
    assert.equal(second.renders().length, 0)

    // Квитанция записалась: сверяем по сумме из журнала, без ffprobe.
    const journaled = committed(fx.task, executed)
    assert.equal(hostRenderOperationFor(journaled, refOf(executed.mediaRender!.artifact))?.operationId, 'render-replay')
    assert.equal(hostRenderOperationFor(fx.task, refOf(executed.mediaRender!.artifact)), undefined)
    const third = fakeRunner()
    const again = await brokerFor(fx, third).execute(journaled, 'media.render', manifest, 'render-replay')
    assert.deepEqual(again.result, executed.result)
    assert.equal(third.renders().length + third.probes().length, 0)

    // Тот же operationId с другим манифестом — конфликт, а не второй ролик.
    const other = manifestOf([{ artifact: video, startMs: 1_000, durationMs: 2_500 }])
    const conflicting = fakeRunner()
    await assert.rejects(brokerFor(fx, conflicting).execute(journaled, 'media.render', other, 'render-replay'), (error) => codeOf(error) === 'OPERATION_CONFLICT')
    assert.equal(conflicting.calls.length, 0)
    assert.equal((await publishedOutputs(fx)).length, 1)

    // Исходник после рендера пропал — повтору он и не нужен.
    await fs.rm(path.join(fx.mediaDir, path.basename(video.mediaSrc)))
    const fourth = fakeRunner()
    assert.deepEqual((await brokerFor(fx, fourth).execute(fx.task, 'media.render', manifest, 'render-replay')).result, executed.result)
    assert.equal(fourth.renders().length, 0)
  } finally {
    await fx.cleanup()
  }
})

test('повтор находит ролик и после того, как раскладка по доскам увезла файл', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const manifest = manifestOf([{ artifact: video, durationMs: 1_000 }])
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const executed = await broker.execute(fx.task, 'media.render', manifest, 'render-sorted')
    const fileName = path.basename((executed.result.artifact as AgentArtifact).mediaSrc)
    const before = await resolveMediaInAsync(fx.mediaDir, fileName)

    const sorted = await sortMediaByBoards({ root: fx.mediaDir, boards: [{ id: 'board-1', name: 'Ролик', files: [fileName] }] })
    assert.ok(sorted.moved >= 1)
    const afterSort = await resolveMediaInAsync(fx.mediaDir, fileName)
    assert.equal(path.relative(fx.mediaDir, afterSort), path.join('Ролик', MEDIA_TYPE_FOLDERS.video, fileName))
    assert.notEqual(afterSort, before)

    const replayed = await broker.execute(fx.task, 'media.render', manifest, 'render-sorted')
    assert.deepEqual(replayed.result, executed.result)
    const journaled = await broker.execute(committed(fx.task, executed), 'media.render', manifest, 'render-sorted')
    assert.deepEqual(journaled.result, executed.result)
    assert.equal(fake.renders().length, 1)
    assert.deepEqual(await publishedOutputs(fx), [fileName])
    // Приватную папку раскладка не трогала и за доску не приняла.
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})

test('восемь одновременных вызовов одной операции дают один ролик, а разные операции не рендерятся разом', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const manifest = manifestOf([{ artifact: video, durationMs: 1_000 }])
    const fake = fakeRunner({ render: async (call) => { await new Promise((resolve) => setTimeout(resolve, 25)); await call.write() } })
    const broker = brokerFor(fx, fake)

    const same = await Promise.all(Array.from({ length: 8 }, () => broker.execute(fx.task, 'media.render', manifest, 'render-same')))
    assert.ok(same.every((entry) => JSON.stringify(entry.result) === JSON.stringify(same[0].result)))
    assert.equal(fake.renders().length, 1)
    assert.equal((await publishedOutputs(fx)).length, 1)

    const different = await Promise.all(['a', 'b', 'c'].map((name) => broker.execute(fx.task, 'media.render', manifest, `render-${name}`)))
    assert.equal(new Set(different.map((entry) => (entry.result.artifact as AgentArtifact).artifactId)).size, 3)
    assert.equal(fake.renders().length, 4)
    assert.equal(fake.peak(), 1)
    assert.equal((await publishedOutputs(fx)).length, 4)
    assert.equal(pendingMediaRenders(fx.task.taskId), 0)
    assert.deepEqual(await scratchEntries(fx), [])
  } finally {
    await fx.cleanup()
  }
})

test('изменённый, чужой и пропавший файл результата — конфликт, а не новый рендер', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const manifest = manifestOf([{ artifact: video, durationMs: 1_000 }])
    const fake = fakeRunner()
    const broker = brokerFor(fx, fake)
    const executed = await broker.execute(fx.task, 'media.render', manifest, 'render-corrupt')
    const journaled = committed(fx.task, executed)
    const file = await resolveMediaInAsync(fx.mediaDir, (executed.result.artifact as AgentArtifact).mediaSrc)

    // Валидный на вид ролик, но не те байты, что в журнале.
    await fs.writeFile(file, fakeBytes('video/mp4', { width: 1280, height: 720, fps: 24, frames: 24, codec: 'h264', pixFmt: 'yuv420p' }, { size: 70_001 }))
    await assert.rejects(broker.execute(journaled, 'media.render', manifest, 'render-corrupt'), (error) => codeOf(error) === 'MEDIA_RENDER_CONFLICT')
    // Журнала нет, на месте результата лежит мусор.
    await fs.writeFile(file, 'не видео')
    await assert.rejects(broker.execute(fx.task, 'media.render', manifest, 'render-corrupt'), (error) => codeOf(error) === 'MEDIA_RENDER_CONFLICT')
    // Журнала нет, ролик на месте настоящий, но не от этого манифеста.
    await fs.writeFile(file, fakeBytes('video/mp4', { width: 1280, height: 720, fps: 24, frames: 240, codec: 'h264', pixFmt: 'yuv420p' }, { size: 70_000 }))
    await assert.rejects(broker.execute(fx.task, 'media.render', manifest, 'render-corrupt'), (error) => codeOf(error) === 'MEDIA_RENDER_CONFLICT')
    assert.equal((await fs.readFile(file)).length, 70_000)

    // Журнал называет артефакт, а файла нет: «тот же» ролик заново не собрать.
    await fs.rm(file)
    await assert.rejects(broker.execute(journaled, 'media.render', manifest, 'render-corrupt'), (error) => codeOf(error) === 'MEDIA_RENDER_OUTPUT_MISSING')
    assert.equal(fake.renders().length, 1)
  } finally {
    await fx.cleanup()
  }
})

test('таймаут, превышение размера и обрыв ничего не публикуют', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const manifest = manifestOf([{ artifact: video, durationMs: 5_000 }], { maxOutputBytes: 100_000 })
    const run = (render: (call: RenderCall) => Promise<void>, operationId: string, extra: Partial<MediaRenderRuntime> = {}) => {
      const fake = fakeRunner({ encoders: ['h264_nvenc', 'libopenh264'], render })
      return { fake, result: brokerFor(fx, fake, extra).execute(fx.task, 'media.render', manifest, operationId) }
    }

    const timedOut = run(async (call) => {
      await fs.writeFile(call.output, 'половина ролика')
      throw new ToolError('Обработка заняла слишком долго и была прервана', '', 'timeout')
    }, 'render-timeout', { timeoutMs: 1_234 })
    await assert.rejects(timedOut.result, (error) => codeOf(error) === 'MEDIA_RENDER_TIMEOUT')
    // После таймаута следующий кодировщик не пробуется: он удвоил бы ожидание.
    assert.equal(timedOut.fake.renders().length, 1)

    let seenTimeout: number | undefined
    const oversize = run(async (call) => { seenTimeout = call.timeoutMs; await call.write({ bytes: 100_001 }) }, 'render-oversize')
    await assert.rejects(oversize.result, (error) => codeOf(error) === 'MEDIA_RENDER_OUTPUT_LIMIT')
    // Пять секунд монтажа: минута плюс восьмикратная длина, но не меньше двух минут.
    assert.equal(seenTimeout, 120_000)

    const truncated = run((call) => call.write({ frames: call.meta.frames - 30 }), 'render-truncated')
    await assert.rejects(truncated.result, (error) => codeOf(error) === 'MEDIA_RENDER_TRUNCATED')
    const withAudio = run((call) => call.write({ audio: true }), 'render-audio')
    await assert.rejects(withAudio.result, (error) => codeOf(error) === 'MEDIA_RENDER_OUTPUT_INVALID')
    const wrongFrame = run((call) => call.write({ width: 1920, height: 1080 }), 'render-frame')
    await assert.rejects(wrongFrame.result, (error) => codeOf(error) === 'MEDIA_RENDER_OUTPUT_INVALID')
    const nothing = run(async () => undefined, 'render-nothing')
    await assert.rejects(nothing.result, (error) => codeOf(error) === 'MEDIA_RENDER_OUTPUT_INVALID')

    assert.deepEqual(await publishedOutputs(fx), [])
    assert.deepEqual(await scratchEntries(fx), [])

    // Допуск — кадр на клип: у одного клипа два потерянных кадра уже обрыв,
    // а на нарезке из 32 клипов двадцать кадров — обычное округление.
    const twoShort = run((call) => call.write({ frames: call.meta.frames - 2 }), 'render-two-short')
    await assert.rejects(twoShort.result, (error) => codeOf(error) === 'MEDIA_RENDER_TRUNCATED')
    const many = manifestOf(Array.from({ length: 32 }, () => ({ artifact: video, durationMs: 70 })), { fps: 24 })
    const rounded = fakeRunner({ render: (call) => call.write({ frames: call.meta.frames - 20 }) })
    await brokerFor(fx, rounded).execute(fx.task, 'media.render', many, 'render-rounded')
    assert.equal(rounded.renders().length, 1)
  } finally {
    await fx.cleanup()
  }
})

test('отмена задачи убивает идущий рендер и снимает ждущие в очереди', async () => {
  const fx = await renderFixture()
  const neighbour = await renderFixture()
  try {
    const video = await videoSource(fx)
    const other = await videoSource(neighbour)
    let started = 0
    const hanging = fakeRunner({ render: hangingRender(() => { started += 1 }) })
    const running = brokerFor(fx, hanging).execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }]), 'render-cancel')
    const queued = brokerFor(fx, hanging).execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 2_000 }]), 'render-cancel-queued')
    running.catch(() => undefined)
    queued.catch(() => undefined)
    const honest = fakeRunner()
    const bystander = brokerFor(neighbour, honest).execute(neighbour.task, 'media.render', manifestOf([{ artifact: other, durationMs: 1_000 }]), 'render-bystander')

    await waitFor(() => started === 1, 'рендер начался')
    assert.equal(pendingMediaRenders(fx.task.taskId), 2)
    assert.equal(honest.calls.length, 0)

    cancelMediaRenders(fx.task.taskId)
    await assert.rejects(running, (error) => codeOf(error) === 'MEDIA_RENDER_CANCELLED')
    await assert.rejects(queued, (error) => codeOf(error) === 'MEDIA_RENDER_CANCELLED')
    // Чужая задача в той же очереди доходит до конца.
    const finished = await bystander
    assert.equal((finished.result.artifact as AgentArtifact).provenance, 'derived')

    assert.equal(started, 1)
    assert.equal(hanging.renders().length, 1)
    assert.deepEqual(await publishedOutputs(fx), [])
    assert.deepEqual(await scratchEntries(fx), [])
    assert.equal(pendingMediaRenders(fx.task.taskId), 0)

    // Отмена относится к рендерам, которые шли: следующий запуск её не наследует.
    const later = fakeRunner()
    await brokerFor(fx, later).execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }]), 'render-after-cancel')
    assert.equal(later.renders().length, 1)

    // Брокер гасит рендер первым и только потом, по очереди, платные брокеры.
    const order: string[] = []
    let live = 0
    const slow = fakeRunner({ render: hangingRender(() => { live += 1 }) })
    const paid = (name: string) => ({ cancelTask: async () => { order.push(`${name}:start`); await new Promise((resolve) => setTimeout(resolve, 10)); order.push(`${name}:end`) } })
    const full = new AgentToolBroker({
      mediaDir: fx.mediaDir, workspaceRoot: fx.root, mediaRender: { tools: FAKE_TOOLS, run: slow.run },
      llm: paid('llm') as never, generation: paid('generation') as never,
    })
    const doomed = full.execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 3_000 }]), 'render-cancel-external')
    doomed.catch(() => undefined)
    await waitFor(() => live === 1, 'второй рендер начался')
    await full.cancelExternal(fx.task)
    await assert.rejects(doomed, (error) => codeOf(error) === 'MEDIA_RENDER_CANCELLED')
    assert.deepEqual(order, ['llm:start', 'llm:end', 'generation:start', 'generation:end'])
  } finally {
    await fx.cleanup()
    await neighbour.cleanup()
  }
})

test('снятый из очереди не пропускает следующего вперёд идущего', async () => {
  const log: string[] = []
  let releaseFirst!: () => void
  const first = runExclusiveRender('queue-a', async () => {
    log.push('a:start')
    await new Promise<void>((resolve) => { releaseFirst = resolve })
    log.push('a:end')
  })
  const second = runExclusiveRender('queue-b', async () => { log.push('b:start') })
  const third = runExclusiveRender('queue-c', async () => { log.push('c:start') })
  await new Promise((resolve) => setTimeout(resolve, 10))
  cancelMediaRenders('queue-b')
  await assert.rejects(second, (error) => codeOf(error) === 'MEDIA_RENDER_CANCELLED')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(log, ['a:start'])
  releaseFirst()
  await Promise.all([first, third])
  assert.deepEqual(log, ['a:start', 'a:end', 'c:start'])
  assert.equal(pendingMediaRenders('queue-a') + pendingMediaRenders('queue-b') + pendingMediaRenders('queue-c'), 0)
})

test('остатки оборванного рендера убираются перед следующим и при старте', async () => {
  const fx = await renderFixture()
  try {
    const video = await videoSource(fx)
    const stale = path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY, 'оборванный-рендер')
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(stale, 'in-00.mp4'), 'копия исходника')
    await fs.writeFile(path.join(stale, 'out.mp4'), 'половина ролика')

    const fake = fakeRunner()
    await brokerFor(fx, fake).execute(fx.task, 'media.render', manifestOf([{ artifact: video, durationMs: 1_000 }]), 'render-after-crash')
    assert.deepEqual(await scratchEntries(fx), [])

    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(stale, 'in-00.mp4'), 'копия исходника')
    await cleanMediaRenderScratch(fx.mediaDir)
    await assert.rejects(fs.lstat(path.join(fx.mediaDir, RENDER_SCRATCH_DIRECTORY)), (error) => codeOf(error) === 'ENOENT')
    // Медиа и исходники уборка не трогает.
    assert.equal((await publishedOutputs(fx)).length, 1)
    await fs.access(path.join(fx.mediaDir, path.basename(video.mediaSrc)))
    await cleanMediaRenderScratch(path.join(fx.root, 'нет-такой-папки'))
  } finally {
    await fx.cleanup()
  }
})
