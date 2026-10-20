import fs from 'node:fs/promises'
import { requireFfmpeg } from '../ffmpegTools.js'
import { runTool, ToolError } from '../ffmpegRun.js'
import { encoderArgs, parseEncoders, pickEncoder, type VideoEncoder } from '../videoEncoder.js'
import { parseFrameRate } from '../videoProbe.js'
import { AgentToolError, type MediaRenderRun, type MediaRenderRuntime } from './tool-shared.js'

// Запуск ffmpeg и ffprobe для чернового монтажа. Сюда приходят только файлы из
// приватной папки Host с именами, которые дал сам Host: ни пути, ни адреса, ни
// фильтры от агента в командную строку не попадают.
//
// Что держит ffmpeg в рамках:
//  — перед КАЖДЫМ входом свой набор ограничений. Это параметры входа, а не
//    запуска: поставленные один раз, они относились бы только к первому файлу;
//  — протокол только `file`, демультиплексор только тот, что положен типу
//    файла. Без этого «mp4» с текстом ffconcat внутри открылся бы как список
//    и потянул бы за собой чужие файлы (проверено на настоящем ffmpeg);
//  — кодировщик берётся общим выбором проекта (videoEncoder). x264 там нет и
//    быть не может: он GPL, и в сборке, которую получает покупатель, его нет.

/** Вход рендера: файл в приватной папке Host плюс отрезок из манифеста. */
export interface RenderInput {
  file: string
  kind: 'image' | 'video'
  mimeType: string
  startMs: number
  durationMs: number
  /** Сколько кадров займёт клип в результате (см. clipFrames). */
  frames: number
}

export interface RenderTools {
  ffmpeg: string
  ffprobe: string
  run: MediaRenderRun
  /** Кодировщики сборки в порядке предпочтения проекта; первый годный выигрывает. */
  encoders: VideoEncoder[]
}

export interface RenderControl {
  timeoutMs: number
  signal?: AbortSignal
  /** Пути Host, которые нельзя показывать агенту в тексте ошибки. */
  redact?: readonly string[]
}

export interface MediaFacts {
  formats: string[]
  /** Секунды по контейнеру; 0 — неизвестно. */
  duration: number
  videoStreams: number
  hasAudio: boolean
  video?: {
    codec: string
    pixFmt: string
    width: number
    height: number
    fps: number | undefined
    frames: number | undefined
    duration: number | undefined
  }
}

const HEADER_BYTES = 64
const PROBE_SIZE = '5000000'
const MAX_STREAMS = '8'
const PROBE_TIMEOUT_MS = 30_000
const MOV_FAMILY = 'mov,mp4,m4a,3gp,3g2,mj2'
// Первый атом QuickTime-семейства. У MP4 это почти всегда ftyp, у старых MOV
// файл начинается сразу с данных.
const MOV_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])

// image2 рядом с *_pipe не лишний: обычный JPEG ffmpeg открывает именно им.
// Шаблоны имён (%d, *) у image2 нам не страшны — имя файла даёт Host.
const FORMATS: Record<string, { kind: 'image' | 'video'; demuxers: string }> = {
  'video/mp4': { kind: 'video', demuxers: MOV_FAMILY },
  'video/quicktime': { kind: 'video', demuxers: MOV_FAMILY },
  'video/x-m4v': { kind: 'video', demuxers: MOV_FAMILY },
  'video/webm': { kind: 'video', demuxers: 'matroska,webm' },
  'image/png': { kind: 'image', demuxers: 'image2,png_pipe' },
  'image/jpeg': { kind: 'image', demuxers: 'image2,jpeg_pipe' },
  'image/webp': { kind: 'image', demuxers: 'image2,webp_pipe' },
}

/** Чем является файл такого типа для монтажа; null — тип не поддержан. */
export function renderInputKind(mimeType: string): 'image' | 'video' | null {
  return FORMATS[mimeType.toLowerCase()]?.kind ?? null
}

function demuxers(mimeType: string): string {
  const format = FORMATS[mimeType.toLowerCase()]
  if (!format) throw new AgentToolError('MEDIA_RENDER_INPUT_UNSUPPORTED', `Type ${mimeType} is not supported by rough-cut editing`)
  return format.demuxers
}

/** Ограничения одного входа. Обязаны стоять перед его `-i`. */
function inputGuards(mimeType: string): string[] {
  return [
    '-protocol_whitelist', 'file',
    '-format_whitelist', demuxers(mimeType),
    '-probesize', PROBE_SIZE,
    '-analyzeduration', PROBE_SIZE,
    '-max_streams', MAX_STREAMS,
  ]
}

function redacted(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (!secret) continue
    out = out.split(secret).join('…').split(secret.replaceAll('\\', '/')).join('…')
  }
  return out
}

/** Сбой внешнего процесса → код для агента. Причину берём из поля, а не из
 *  русского текста ошибки. */
function commandFailure(error: unknown, label: string, redact?: readonly string[]): AgentToolError {
  if (error instanceof AgentToolError) return error
  const reason = error instanceof ToolError ? error.reason : undefined
  if (reason === 'aborted') return new AgentToolError('MEDIA_RENDER_CANCELLED', 'Render stopped with the task')
  if (reason === 'timeout') return new AgentToolError('MEDIA_RENDER_TIMEOUT', `${label}: exceeded the allotted time`)
  const stderr = error instanceof ToolError ? error.stderr : ''
  if (/not on whitelist/iu.test(stderr)) {
    return new AgentToolError('MEDIA_RENDER_FORMAT_UNSAFE', 'File contents do not match the format declared in the receipt')
  }
  const detail = redacted(stderr.trim().slice(-400), redact)
  return new AgentToolError('MEDIA_RENDER_FAILED', detail ? `${label}: ${detail}` : label)
}

async function readHeader(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

/**
 * Сверить первые байты с заявленным типом — до того, как файл увидит ffprobe.
 * Текстовый список (m3u8, ffconcat) под видом видео останавливается здесь; а
 * если бы прошёл, его остановил бы белый список демультиплексоров.
 *
 * Адреса внутри файла НЕ ищем: у обычного JPEG с XMP в заголовке буквально
 * стоит http://ns.adobe.com/xap/1.0/, и такая проверка отвергала бы снимки.
 */
export async function assertSafeSignature(file: string, mimeType: string): Promise<void> {
  const mime = mimeType.toLowerCase()
  demuxers(mime)
  const header = await readHeader(file)
  const text = header.toString('latin1').replace(/^ï»¿/u, '').trimStart()
  if (/^(?:#EXTM3U|#EXT-X-|ffconcat\s+version)/iu.test(text)) {
    throw new AgentToolError('MEDIA_RENDER_FORMAT_UNSAFE', 'Playlists and concatenations are not accepted in place of media')
  }
  const ascii = (from: number, to: number) => header.subarray(from, to).toString('latin1')
  let valid = false
  if (mime === 'video/webm') valid = startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])
  else if (mime.startsWith('video/')) valid = MOV_ATOMS.has(ascii(4, 8))
  else if (mime === 'image/png') valid = startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  else if (mime === 'image/jpeg') valid = startsWith(header, [0xff, 0xd8, 0xff])
  else if (mime === 'image/webp') {
    valid = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    // Анимированный WebP ffmpeg читать не умеет: вместо кадра вышла бы error
    // посреди рендера. Флаг анимации — второй бит в заголовке VP8X.
    if (valid && ascii(12, 16) === 'VP8X' && (header[20] & 0x02) !== 0) {
      throw new AgentToolError('MEDIA_RENDER_INPUT_UNSUPPORTED', 'Animated WebP is not supported by rough-cut editing')
    }
  }
  if (!valid) throw new AgentToolError('MEDIA_RENDER_FORMAT_UNSAFE', 'File contents do not match the format declared in the receipt')
}

/** Найти ffmpeg и выяснить, чем в этой сборке можно кодировать. */
export async function resolveRenderTools(runtime: MediaRenderRuntime = {}, signal?: AbortSignal): Promise<RenderTools> {
  const tools = runtime.tools ?? await requireFfmpeg().catch((error) => {
    throw new AgentToolError('MEDIA_RENDER_UNAVAILABLE', error instanceof Error ? error.message : 'Video processing component is not installed')
  })
  const run = runtime.run ?? runTool
  let listing: string
  try {
    const result = await run(tools.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: PROBE_TIMEOUT_MS, maxStdoutBytes: 8 * 1024 * 1024, signal })
    listing = result.stdout.toString('utf8')
  } catch (error) {
    if (error instanceof ToolError && error.reason === 'aborted') throw commandFailure(error, '')
    throw new AgentToolError('MEDIA_RENDER_UNAVAILABLE', 'Video processing component cannot start')
  }
  // Порядок задаёт pickEncoder: аппаратные, затем libopenh264. Берём не один,
  // а весь ряд: h264_nvenc значится в сборке и на машине без видеокарты
  // NVIDIA, и узнать, что он не работает, можно только попробовав.
  const available = parseEncoders(listing)
  const encoders: VideoEncoder[] = []
  for (let next = pickEncoder(available); next; next = pickEncoder(available)) {
    encoders.push(next)
    available.delete(next)
  }
  if (!encoders.length) {
    throw new AgentToolError('MEDIA_RENDER_UNAVAILABLE', 'The installed video processing build has no allowed H.264 encoder')
  }
  return { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, run, encoders }
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** Разбор ответа ffprobe. Отдельно от запуска: формат проверяется на строках. */
export function parseMediaFacts(json: string): MediaFacts {
  const parsed = JSON.parse(json || '{}') as {
    streams?: Array<Record<string, unknown>>
    format?: { duration?: unknown; format_name?: unknown }
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const videos = streams.filter((stream) => stream.codec_type === 'video')
  const first = videos[0]
  const width = positive(first?.width)
  const height = positive(first?.height)
  const formats = typeof parsed.format?.format_name === 'string'
    ? parsed.format.format_name.split(',').map((name) => name.trim()).filter(Boolean)
    : []
  return {
    formats,
    duration: positive(parsed.format?.duration) ?? 0,
    videoStreams: videos.length,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    ...(first && width && height ? {
      video: {
        codec: typeof first.codec_name === 'string' ? first.codec_name : '',
        pixFmt: typeof first.pix_fmt === 'string' ? first.pix_fmt : '',
        width,
        height,
        fps: parseFrameRate(first.r_frame_rate),
        frames: positive(first.nb_frames),
        duration: positive(first.duration),
      },
    } : {}),
  }
}

/** ffprobe под теми же ограничениями, что и вход рендера. Сигнатуру файла
 *  проверяет вызывающий (assertSafeSignature) — до этого вызова. */
export async function probeMedia(file: string, tools: RenderTools, mimeType: string, control: Omit<RenderControl, 'timeoutMs'> = {}): Promise<MediaFacts> {
  let stdout: string
  try {
    const result = await tools.run(tools.ffprobe, [
      '-v', 'error',
      ...inputGuards(mimeType),
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,nb_frames,duration:format=duration,format_name',
      '-of', 'json', file,
    ], { timeoutMs: PROBE_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024, signal: control.signal })
    stdout = result.stdout.toString('utf8')
  } catch (error) {
    throw commandFailure(error, 'File cannot be read as media', control.redact)
  }
  let facts: MediaFacts
  try {
    facts = parseMediaFacts(stdout)
  } catch {
    throw new AgentToolError('MEDIA_RENDER_PROBE_INVALID', 'Could not parse the media description')
  }
  const allowed = new Set(demuxers(mimeType).split(','))
  if (!facts.formats.length || facts.formats.some((name) => !allowed.has(name))) {
    throw new AgentToolError('MEDIA_RENDER_FORMAT_UNSAFE', 'File contents do not match the format declared in the receipt')
  }
  return facts
}

export interface RenderPlan {
  fps: number
  frame: { width: number; height: number }
  maxOutputBytes: number
  output: string
}

/**
 * Командная строка рендера. Каждый клип — свой вход: приводится к частоте и
 * кадру результата, доводится до точного числа кадров и только потом идёт в
 * склейку. Звука нет вовсе (-an), метаданные и главы исходников не переносятся.
 */
export function renderArgs(inputs: readonly RenderInput[], plan: RenderPlan, encoder: VideoEncoder): string[] {
  const { width, height } = plan.frame
  const args = ['-v', 'error', '-nostdin', '-y']
  const filters: string[] = []
  inputs.forEach((input, index) => {
    const seconds = (input.durationMs / 1000).toFixed(3)
    args.push(...inputGuards(input.mimeType))
    if (input.kind === 'image') args.push('-loop', '1', '-framerate', String(plan.fps))
    // -ss ДО -i: перемотка по контейнеру, а не декодирование от начала файла.
    else if (input.startMs > 0) args.push('-ss', (input.startMs / 1000).toFixed(3))
    args.push('-t', seconds, '-i', input.file)
    filters.push([
      `[${index}:v:0]fps=${plan.fps}`,
      // out_range=tv: иначе один JPEG (полный диапазон) перекрашивает метку
      // диапазона у всего ролика, и результат выходит yuvj420p.
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:out_range=tv`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      'format=yuv420p',
      // Источник может кончиться на кадр раньше заявленного: дотягиваем
      // последним кадром и режем ровно по счёту.
      `tpad=stop_mode=clone:stop_duration=${seconds}`,
      `trim=end_frame=${input.frames}`,
      `setpts=PTS-STARTPTS[v${index}]`,
    ].join(','))
  })
  filters.push(`${inputs.map((_, index) => `[v${index}]`).join('')}concat=n=${inputs.length}:v=1:a=0[outv]`)
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-an',
    '-c:v', encoder, ...encoderArgs(encoder), '-pix_fmt', 'yuv420p',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact',
    '-movflags', '+faststart',
    // ffmpeg останавливается на пакете, который пересёк предел, и выходит без
    // ошибки. Файл при этом получается БОЛЬШЕ предела — по этому признаку
    // вызывающий и отличает «не влезло» от «оборвалось».
    '-fs', String(plan.maxOutputBytes + 1),
    '-f', 'mp4', plan.output,
  )
  return args
}

/** Потолок времени одного прохода: минута на запуск плюс восьмикратная длина
 *  монтажа, но не меньше двух минут и не больше десяти. */
export function renderTimeoutMs(totalMs: number): number {
  return Math.min(600_000, Math.max(120_000, 60_000 + totalMs * 8))
}

/** Собрать ролик первым работающим кодировщиком. Возвращает, каким именно. */
export async function renderRoughCut(inputs: readonly RenderInput[], plan: RenderPlan, tools: RenderTools, control: RenderControl): Promise<VideoEncoder> {
  let failure: AgentToolError | undefined
  for (const encoder of tools.encoders) {
    await fs.rm(plan.output, { force: true })
    try {
      await tools.run(tools.ffmpeg, renderArgs(inputs, plan, encoder), {
        timeoutMs: control.timeoutMs,
        maxStdoutBytes: 2 * 1024 * 1024,
        signal: control.signal,
      })
      return encoder
    } catch (error) {
      failure = commandFailure(error, 'Could not build the rough cut', control.redact)
      // Таймаут, отмена и чужой формат от кодировщика не зависят — следующий
      // их не исправит, а таймаут ещё и удвоил бы ожидание.
      if (failure.code !== 'MEDIA_RENDER_FAILED') throw failure
    }
  }
  throw failure ?? new AgentToolError('MEDIA_RENDER_UNAVAILABLE', 'No encoder is available for rough-cut editing')
}
