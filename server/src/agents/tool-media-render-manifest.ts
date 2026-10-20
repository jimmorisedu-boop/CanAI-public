import crypto from 'node:crypto'
import type { AgentMediaRenderFrame, AgentMediaRenderManifest } from '../../../packages/agent-protocol/index.js'
import { parseArtifactRef } from './tool-media-read.js'
import { AgentToolError, MAX_ARTIFACT_BYTES, record } from './tool-shared.js'

// Разбор манифеста чернового монтажа. Manifest называет артефакты задачи и
// отрезки времени — и больше ничего: ни путей, ни адресов, ни фильтров, ни
// аргументов ffmpeg. Всё, чего нет в белом списке полей, — отказ.
//
// Пределы совпадают с docs/agents/protocol.schema.json ($defs.mediaRenderArgs);
// менять их надо в обоих местах.

export const MAX_DURATION_MS = 300_000
export const MAX_CLIPS = 32
export const MIN_CLIP_MS = 50
export const MIN_OUTPUT_BYTES = 65_536
export const DEFAULT_FRAME: AgentMediaRenderFrame = '1280x720'

const FRAMES: Record<AgentMediaRenderFrame, { width: number; height: number }> = {
  '1280x720': { width: 1280, height: 720 },
  '720x1280': { width: 720, height: 1280 },
  '1080x1080': { width: 1080, height: 1080 },
}

const MANIFEST_KEYS = ['version', 'mode', 'audio', 'clips', 'fps', 'frame', 'maxDurationMs', 'maxOutputBytes']
const CLIP_KEYS = ['artifact', 'order', 'startMs', 'durationMs']

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new AgentToolError('INPUT_INVALID', `${label} contains an unknown field`)
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}

export function frameSize(frame: AgentMediaRenderFrame): { width: number; height: number } {
  return { ...FRAMES[frame] }
}

/**
 * Manifest в каноническом виде: кадр по умолчанию подставлен, порядок ключей
 * постоянный. От этого вида считается контрольная сумма, поэтому манифест без
 * `frame` и манифест с `frame: "1280x720"` — один и тот же монтаж.
 */
export function parseRenderManifest(value: unknown): AgentMediaRenderManifest & { frame: AgentMediaRenderFrame } {
  const object = record(value, 'media.render arguments')
  exactKeys(object, MANIFEST_KEYS, 'media.render arguments')
  if (object.version !== 1 || object.mode !== 'rough-cut' || object.audio !== 'mute') {
    throw new AgentToolError('INPUT_INVALID', 'media.render supports only version=1 rough-cut audio=mute')
  }
  if (!Array.isArray(object.clips) || object.clips.length < 1 || object.clips.length > MAX_CLIPS) {
    throw new AgentToolError('INPUT_INVALID', `media.render clips must contain from 1 to ${MAX_CLIPS} items`)
  }
  if (object.fps !== 24 && object.fps !== 25 && object.fps !== 30) {
    throw new AgentToolError('INPUT_INVALID', 'media.render fps must be 24, 25, or 30')
  }
  const frame = object.frame === undefined ? DEFAULT_FRAME : object.frame
  if (typeof frame !== 'string' || !Object.hasOwn(FRAMES, frame)) {
    throw new AgentToolError('INPUT_INVALID', 'media.render frame must be 1280x720, 720x1280, or 1080x1080')
  }
  if (!integer(object.maxDurationMs, MIN_CLIP_MS, MAX_DURATION_MS)) {
    throw new AgentToolError('INPUT_INVALID', 'media.render maxDurationMs is outside the allowed range')
  }
  if (!integer(object.maxOutputBytes, MIN_OUTPUT_BYTES, MAX_ARTIFACT_BYTES)) {
    throw new AgentToolError('INPUT_INVALID', 'media.render maxOutputBytes is outside the allowed range')
  }

  let totalMs = 0
  const clips = object.clips.map((raw, index) => {
    const label = `media.render clips[${index}]`
    const clip = record(raw, label)
    exactKeys(clip, CLIP_KEYS, label)
    if (clip.order !== index || !integer(clip.startMs, 0, MAX_DURATION_MS) || !integer(clip.durationMs, MIN_CLIP_MS, MAX_DURATION_MS)) {
      throw new AgentToolError('INPUT_INVALID', `${label} has an invalid order, startMs, or durationMs`)
    }
    totalMs += clip.durationMs
    return {
      artifact: parseArtifactRef(clip.artifact, `${label}.artifact`),
      order: index,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
    }
  })
  // Сначала форма каждого клипа, потом сумма: иначе кривой клип в хвосте
  // прятался бы за сообщением о длительности.
  if (totalMs > object.maxDurationMs) {
    throw new AgentToolError('MEDIA_RENDER_DURATION_LIMIT', 'Total clip duration exceeds maxDurationMs')
  }
  return {
    version: 1,
    mode: 'rough-cut',
    audio: 'mute',
    clips,
    fps: object.fps,
    frame: frame as AgentMediaRenderFrame,
    maxDurationMs: object.maxDurationMs,
    maxOutputBytes: object.maxOutputBytes,
  }
}

export function renderManifestHash(manifest: AgentMediaRenderManifest): string {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

/**
 * Сколько кадров займёт клип. Считаем сами и отдаём ffmpeg готовым числом
 * (trim=end_frame): длина результата тогда известна заранее с точностью до
 * кадра, и «обрезало ли» проверяется счётом, а не догадкой по секундам.
 */
export function clipFrames(durationMs: number, fps: number): number {
  return Math.max(1, Math.round(durationMs * fps / 1000))
}

export function expectedFrames(manifest: AgentMediaRenderManifest): number {
  return manifest.clips.reduce((sum, clip) => sum + clipFrames(clip.durationMs, manifest.fps), 0)
}

export function totalDurationMs(manifest: AgentMediaRenderManifest): number {
  return manifest.clips.reduce((sum, clip) => sum + clip.durationMs, 0)
}
