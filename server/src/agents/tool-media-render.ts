import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AgentArtifact, AgentArtifactRef, AgentMediaRenderFrame, AgentMediaRenderManifest } from '../../../packages/agent-protocol/index.js'
import { forgetMediaFile, mediaPathIn, mediaWritePathIn, noteMediaFile, resolveMediaInAsync } from '../mediaLayout.js'
import { extForMime } from '../mediaTypes.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolError, stableId, type MediaRenderCommit, type MediaRenderRuntime, type ToolResult } from './tool-shared.js'
import { resolveVerifiedSource, sourceArtifact } from './tool-media-read.js'
import { assertNoLinks, assertSafeTree, digestFile, ensureChildDirectory, linkOrCopy, missing, placeExclusive, type FileDigest } from './tool-paths.js'
import { clipFrames, expectedFrames, frameSize, parseRenderManifest, renderManifestHash, totalDurationMs } from './tool-media-render-manifest.js'
import { runExclusiveRender, throwIfCancelled } from './tool-media-render-queue.js'
import {
  assertSafeSignature,
  probeMedia,
  renderInputKind,
  renderRoughCut,
  renderTimeoutMs,
  resolveRenderTools,
  type MediaFacts,
  type RenderInput,
  type RenderTools,
} from './tool-media-render-ffmpeg.js'

export { cancelMediaRenders } from './tool-media-render-queue.js'

// Rough cut: Host склеивает артефакты задачи в один немой ролик.
//
// ⚠️ Исходники берутся ТОЛЬКО из медиа Host и только по квитанции задачи.
// Копия в рабочей папке агента (media.read) сюда не годится: агент может
// подменить её между сверкой контрольной суммы и запуском ffmpeg, и запись
// «собрано из таких-то исходников» перестала бы быть правдой.
//
// Работа идёт в приватной папке `.agent-render` внутри медиа. Имя с точки не
// случайно: такие папки пропускают и индекс медиа, и раскладка по доскам, и
// уборка — пока ролик не готов, приложение о нём не знает.

/** Приватная рабочая папка рендера внутри медиа. */
export const RENDER_SCRATCH_DIRECTORY = '.agent-render'
const MAX_INPUT_SIDE = 8192
/** Потолок на суммарный вес разных исходников одного монтажа. На томе без
 *  жёстких ссылок они копируются, и без потолка это 32 × 512 МБ на диске. */
const MAX_TOTAL_INPUT_BYTES = 2 * 1024 * 1024 * 1024
/** На сколько отрезок может выйти за длительность исходника: контейнер и
 *  дорожка расходятся на кадр-другой, а недостающее дотягивается последним кадром. */
const SLICE_SLACK_MS = 80
const OUTPUT_CAPTION = 'Rough cut'

type Manifest = AgentMediaRenderManifest & { frame: AgentMediaRenderFrame }

interface PreparedSource {
  artifact: AgentArtifact
  kind: 'image' | 'video'
  mimeType: string
  file: string
  facts: MediaFacts
}

function refKey(ref: AgentArtifactRef): string {
  return `${ref.artifactId}\0${ref.revision}\0${ref.checksum}`
}

function uniqueRefs(manifest: Manifest): AgentArtifactRef[] {
  const seen = new Map<string, AgentArtifactRef>()
  for (const clip of manifest.clips) if (!seen.has(refKey(clip.artifact))) seen.set(refKey(clip.artifact), clip.artifact)
  return [...seen.values()]
}

function outputFileName(taskId: string, operationId: string, manifestHash: string): string {
  const identity = crypto.createHash('sha256').update(`${taskId}\0${operationId}\0${manifestHash}`).digest('hex')
  return `agent-render-${identity.slice(0, 40)}.mp4`
}

/** Проверки по одним квитанциям — до очереди и до первого обращения к диску. */
function checkReceipts(task: AgentTaskRecord, manifest: Manifest): void {
  let totalBytes = 0
  for (const ref of uniqueRefs(manifest)) {
    const artifact = sourceArtifact(task, ref)
    const kind = renderInputKind(artifact.mimeType)
    if ((artifact.kind !== 'image' && artifact.kind !== 'video') || kind !== artifact.kind) {
      throw new AgentToolError('MEDIA_RENDER_INPUT_UNSUPPORTED', 'Rough cut uses only PNG, JPEG, WebP images and MP4, MOV, WebM video')
    }
    totalBytes += artifact.sizeBytes
  }
  if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
    throw new AgentToolError('MEDIA_RENDER_INPUT_LIMIT', 'Editing sources total more than 2 GB')
  }
  for (const clip of manifest.clips) {
    if (sourceArtifact(task, clip.artifact).kind === 'image' && clip.startMs !== 0) {
      throw new AgentToolError('MEDIA_RENDER_INPUT_INVALID', `clips[${clip.order}]: image startMs must be 0`)
    }
  }
}

async function openScratch(root: string, taskId: string, operationId: string): Promise<string> {
  const base = await ensureChildDirectory(root, RENDER_SCRATCH_DIRECTORY, 'Render workspace')
  // Рендер в очереди один, значит всё, что здесь лежит, осталось от
  // оборванного запуска.
  for (const entry of await fsp.readdir(base)) await removeTree(path.join(base, entry))
  const identity = crypto.createHash('sha256').update(`${taskId}\0${operationId}`).digest('hex').slice(0, 24)
  return ensureChildDirectory(base, `${identity}-${crypto.randomUUID().slice(0, 8)}`, 'Render workspace')
}

async function removeTree(directory: string): Promise<void> {
  // Убитый ffmpeg отпускает файлы не мгновенно — отсюда повторы.
  await fsp.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined)
}

/** Убрать остатки оборванных рендеров. Зовётся при старте приложения. */
export async function cleanMediaRenderScratch(mediaDir: string): Promise<void> {
  await removeTree(path.join(mediaDir, RENDER_SCRATCH_DIRECTORY))
}

async function prepareSources(
  task: AgentTaskRecord,
  mediaDir: string,
  manifest: Manifest,
  scratch: string,
  tools: RenderTools,
  runtime: MediaRenderRuntime,
  signal: AbortSignal,
  redact: readonly string[],
): Promise<Map<string, PreparedSource>> {
  const sources = new Map<string, PreparedSource>()
  for (const [index, ref] of uniqueRefs(manifest).entries()) {
    throwIfCancelled(signal)
    const verified = await resolveVerifiedSource(task, mediaDir, ref)
    const mimeType = verified.artifact.mimeType.toLowerCase()
    const kind = renderInputKind(mimeType)
    if (!kind) throw new AgentToolError('MEDIA_RENDER_INPUT_UNSUPPORTED', `Type ${mimeType} is not supported by rough-cut editing`)
    const file = path.join(scratch, `in-${String(index).padStart(2, '0')}.${extForMime(mimeType)}`)
    await linkOrCopy(verified.file, file, runtime.link)
    // Сверяем ещё раз — уже тот файл, который откроет ffmpeg.
    const copy = await digestFile(file)
    if (copy.checksum !== ref.checksum || copy.sizeBytes !== verified.artifact.sizeBytes) {
      throw new AgentToolError('FILE_INVALID', 'Source changed between validation and rendering')
    }
    await assertSafeSignature(file, mimeType)
    const facts = await probeMedia(file, tools, mimeType, { signal, redact })
    if (!facts.video) throw new AgentToolError('MEDIA_RENDER_INPUT_INVALID', 'Source has no readable video stream')
    if (facts.video.width > MAX_INPUT_SIDE || facts.video.height > MAX_INPUT_SIDE) {
      throw new AgentToolError('MEDIA_RENDER_INPUT_LIMIT', `Source frame is larger than ${MAX_INPUT_SIDE} pixels on a side`)
    }
    sources.set(refKey(ref), { artifact: verified.artifact, kind, mimeType, file, facts })
  }
  return sources
}

function renderInputs(manifest: Manifest, sources: Map<string, PreparedSource>): RenderInput[] {
  return manifest.clips.map((clip) => {
    const source = sources.get(refKey(clip.artifact))!
    if (source.kind === 'video') {
      const seconds = source.facts.video?.duration ?? source.facts.duration
      if (!seconds) throw new AgentToolError('MEDIA_RENDER_INPUT_INVALID', `clips[${clip.order}]: source duration cannot be read`)
      if (clip.startMs + clip.durationMs > seconds * 1000 + SLICE_SLACK_MS) {
        throw new AgentToolError('MEDIA_RENDER_INPUT_INVALID', `clips[${clip.order}]: segment exceeds source duration`)
      }
    }
    return {
      file: source.file,
      kind: source.kind,
      mimeType: source.mimeType,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      frames: clipFrames(clip.durationMs, manifest.fps),
    }
  })
}

/** Тот ли это ролик, что заказан: размер, один поток H.264 без звука, кадр,
 *  число кадров и длительность. Успешный выход ffmpeg этого ещё не значит. */
async function inspectOutput(file: string, manifest: Manifest, tools: RenderTools, signal: AbortSignal, redact: readonly string[]): Promise<FileDigest> {
  const stat = await fsp.lstat(file).catch((error) => {
    if (missing(error)) throw new AgentToolError('MEDIA_RENDER_OUTPUT_INVALID', 'Render did not leave a result file')
    throw error
  })
  if (stat.size > manifest.maxOutputBytes) throw new AgentToolError('MEDIA_RENDER_OUTPUT_LIMIT', 'Render result exceeds maxOutputBytes')
  const digest = await digestFile(file).catch((error) => {
    throw error instanceof AgentToolError ? new AgentToolError('MEDIA_RENDER_OUTPUT_INVALID', 'Render result file is empty or corrupt') : error
  })
  await assertSafeSignature(file, 'video/mp4')
  const facts = await probeMedia(file, tools, 'video/mp4', { signal, redact })
  const size = frameSize(manifest.frame)
  const video = facts.video
  if (!video || facts.videoStreams !== 1 || facts.hasAudio || video.codec !== 'h264' || video.pixFmt !== 'yuv420p'
    || video.width !== size.width || video.height !== size.height) {
    throw new AgentToolError('MEDIA_RENDER_OUTPUT_INVALID', 'Render result does not match the profile: one H.264 yuv420p stream without audio')
  }
  // Каждый клип округляется до целого кадра, поэтому допуск растёт с числом
  // клипов: общий допуск «на весь ролик» ложно срабатывал бы на длинной нарезке.
  const clips = manifest.clips.length
  const frames = expectedFrames(manifest)
  const tolerance = clips / manifest.fps + 0.1
  if (video.frames === undefined || Math.abs(video.frames - frames) > clips
    || !facts.duration || Math.abs(facts.duration - frames / manifest.fps) > tolerance
    || video.fps === undefined || Math.abs(video.fps - manifest.fps) > 0.75) {
    throw new AgentToolError('MEDIA_RENDER_TRUNCATED', 'Render result is shorter or longer than requested')
  }
  return digest
}

/** Уже выпущенный файл этой операции. Где он лежит, знает индекс медиа:
 *  раскладка по доскам могла перенести его в другую папку. */
async function publishedFile(root: string, fileName: string): Promise<string | null> {
  const candidate = await resolveMediaInAsync(root, fileName)
  const stat = await fsp.lstat(candidate).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!stat) return null
  const file = await assertSafeTree(root, candidate, 'Render result')
  if (!stat.isFile()) throw new AgentToolError('PATH_INVALID', 'Render result path is not a file')
  return file
}

async function acceptPublished(file: string, manifest: Manifest, tools: RenderTools, signal: AbortSignal, redact: readonly string[], previous?: AgentArtifact): Promise<FileDigest> {
  const conflict = () => new AgentToolError('MEDIA_RENDER_CONFLICT', 'Saved render result was changed or corrupted')
  if (previous) {
    // Журнал помнит контрольную сумму: совпала — это те же байты, что уже
    // проверялись при рендере, и гонять ffprobe второй раз незачем.
    const digest = await digestFile(file).catch(() => null)
    if (!digest || digest.checksum !== previous.checksum || digest.sizeBytes !== previous.sizeBytes) throw conflict()
    return digest
  }
  try {
    return await inspectOutput(file, manifest, tools, signal, redact)
  } catch (error) {
    if (error instanceof AgentToolError && (error.code === 'MEDIA_RENDER_CANCELLED' || error.code === 'MEDIA_RENDER_TIMEOUT')) throw error
    throw conflict()
  }
}

async function renderFresh(
  task: AgentTaskRecord,
  root: string,
  manifest: Manifest,
  operationId: string,
  fileName: string,
  tools: RenderTools,
  runtime: MediaRenderRuntime,
  signal: AbortSignal,
): Promise<FileDigest> {
  const scratch = await openScratch(root, task.taskId, operationId)
  const redact = [scratch, root]
  try {
    const sources = await prepareSources(task, root, manifest, scratch, tools, runtime, signal, redact)
    const inputs = renderInputs(manifest, sources)
    const output = path.join(scratch, 'out.mp4')
    throwIfCancelled(signal)
    await renderRoughCut(inputs, {
      fps: manifest.fps,
      frame: frameSize(manifest.frame),
      maxOutputBytes: manifest.maxOutputBytes,
      output,
    }, tools, { timeoutMs: runtime.timeoutMs ?? renderTimeoutMs(totalDurationMs(manifest)), signal, redact })
    const digest = await inspectOutput(output, manifest, tools, signal, redact)
    throwIfCancelled(signal)
    // Публикация — обычным путём записи медиа: файл ложится в «общее», а к
    // доске его потом отнесёт раскладка — по ссылке из доски.
    // Место проверяем ДО создания папок: mkdir сквозь junction на месте
    // «общее» создал бы папку снаружи медиа.
    await assertNoLinks(root, mediaPathIn(root, fileName), 'Render result folder')
    const target = await mediaWritePathIn(root, fileName)
    await assertSafeTree(root, path.dirname(target), 'Render result folder')
    if (await placeExclusive(output, target, runtime.link) === 'exists') {
      throw new AgentToolError('MEDIA_RENDER_CONFLICT', 'Render result name is already used by another file')
    }
    noteMediaFile(target)
    return digest
  } finally {
    await removeTree(scratch)
  }
}

export async function renderMedia(
  task: AgentTaskRecord,
  mediaDir: string | undefined,
  rawArguments: unknown,
  operationId: string,
  runtime: MediaRenderRuntime = {},
): Promise<ToolResult> {
  if (task.projectRef.source !== 'local') throw new AgentToolError('UNSUPPORTED_TOOL', 'media.render Cloud media requires a separate shared Host')
  if (!mediaDir) throw new AgentToolError('MEDIA_UNAVAILABLE', 'Host has not configured native media storage')
  const manifest = parseRenderManifest(rawArguments)
  const manifestHash = renderManifestHash(manifest)
  const previousOperation = task.mediaRenderOperations?.find((entry) => entry.operationId === operationId)
  if (previousOperation && previousOperation.manifestHash !== manifestHash) {
    throw new AgentToolError('OPERATION_CONFLICT', 'operationId was already used with another render manifest')
  }
  const previous = previousOperation ? task.artifacts.find((artifact) => refKey(artifact) === refKey(previousOperation.artifact)) : undefined
  checkReceipts(task, manifest)
  const fileName = outputFileName(task.taskId, operationId, manifestHash)

  return runExclusiveRender(task.taskId, async (signal) => {
    const root = await assertSafeTree(mediaDir, mediaDir, 'Media storage')
    const tools = await resolveRenderTools(runtime, signal)
    const existing = await publishedFile(root, fileName)
    let digest: FileDigest
    if (existing) digest = await acceptPublished(existing, manifest, tools, signal, [root], previous)
    // Журнал уже назвал контрольную сумму результата, а кодировщик дважды
    // одинаковых байтов не даёт: собрать «тот же» артефакт заново нельзя.
    else if (previous) throw new AgentToolError('MEDIA_RENDER_OUTPUT_MISSING', 'Released render file is missing from media')
    else digest = await renderFresh(task, root, manifest, operationId, fileName, tools, runtime, signal)

    const dims = frameSize(manifest.frame)
    const durationMs = totalDurationMs(manifest)
    const artifact: AgentArtifact = previous ? structuredClone(previous) : {
      artifactId: stableId('render-artifact', task.taskId, operationId, manifestHash),
      revision: 1,
      checksum: digest.checksum,
      kind: 'video',
      caption: OUTPUT_CAPTION,
      mimeType: 'video/mp4',
      sizeBytes: digest.sizeBytes,
      mediaSrc: `/media/${fileName}`,
      provenance: 'derived',
      width: dims.width,
      height: dims.height,
      durationMs,
    }
    const commit: MediaRenderCommit = {
      operationId,
      manifestHash,
      sourceRefs: uniqueRefs(manifest).map((ref) => ({ ...ref })),
      artifact: structuredClone(artifact),
      manifest: structuredClone(manifest),
      discard: async () => {
        // Файл, на который уже ссылается журнал, не трогаем никогда.
        if (previous) return
        const file = await resolveMediaInAsync(root, fileName)
        await fsp.unlink(file).catch(() => undefined)
        forgetMediaFile(fileName)
      },
    }
    return { result: { artifact }, mediaRender: commit }
  })
}
