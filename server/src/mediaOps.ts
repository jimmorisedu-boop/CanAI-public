import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { peaksFromPcm, isUsefulPeaks, PEAK_COUNT } from './audioPeaks.js'
import { config } from './config.js'
import { runTool } from './ffmpegRun.js'
import { requireFfmpeg } from './ffmpegTools.js'
import { parseShotScores, peakCandidates, type ShotCandidate } from './shotDetect.js'
import { mediaFilePath, saveBuffer } from './storage.js'
import { mediaWritePath } from './mediaLayout.js'
import { cropFilter, encoderArgs, parseEncoders, pickEncoder, type VideoEncoder } from './videoEncoder.js'
import { parseVideoFacts, type VideoFacts } from './videoProbe.js'

// Операции над медиа, которые делает ffmpeg. Каждая — отдельная короткая
// функция: их будет много (обрезка, резы, кадр, кроп), и складывать их в один
// файл нельзя.

export class NoAudioTrackError extends Error {
  constructor() {
    super('This video has no audio track')
  }
}

/** Есть ли в файле звук и сколько он длится.
 *
 * Спрашиваем ДО извлечения: без этого ffmpeg падает с текстом про
 * «Output file does not contain any stream», по которому не догадаться, что
 * видео просто немое. */
export async function probeAudio(src: string): Promise<{ hasAudio: boolean; duration: number | undefined }> {
  return probeAudioFile(mediaFilePath(src))
}

async function probeAudioFile(file: string): Promise<{ hasAudio: boolean; duration: number | undefined }> {
  const { ffprobe } = await requireFfmpeg()
  const { stdout } = await runTool(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json',
    file,
  ], { timeoutMs: 30_000, maxStdoutBytes: 1024 * 1024 })

  const parsed = JSON.parse(stdout.toString('utf8') || '{}') as {
    streams?: Array<{ codec_type?: string }>
    format?: { duration?: string }
  }
  const duration = Number(parsed.format?.duration)
  return {
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio')),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
  }
}

/** Пики волны для файла со звуком (в том числе для видео).
 *
 * Декодируем в моно 8 кГц: для картинки высотой в три десятка пикселей
 * большего не нужно, а объём получается в сотни раз меньше исходного. */
export async function audioPeaks(src: string): Promise<number[] | undefined> {
  let file: string
  try {
    file = mediaFilePath(src)
  } catch {
    return undefined
  }
  return audioPeaksFile(file)
}

/** Внутренний путь к уже проверенному файлу, в том числе кэшу командного ассета. */
export async function audioPeaksFile(file: string): Promise<number[] | undefined> {
  const { ffmpeg } = await requireFfmpeg()
  try {
    const { stdout } = await runTool(ffmpeg, [
      '-v', 'error',
      '-i', file,
      '-vn', '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-',
    ], { timeoutMs: 60_000, maxStdoutBytes: 64 * 1024 * 1024 })
    const peaks = peaksFromPcm(stdout, PEAK_COUNT)
    return isUsefulPeaks(peaks) ? peaks : undefined
  } catch {
    // Волна — украшение плашки, а не результат работы. Не посчиталась —
    // объект всё равно должен появиться, просто без картинки.
    return undefined
  }
}

export interface ExtractedAudio {
  url: string
  mime: string
  duration: number | undefined
  peaks: number[] | undefined
}

/** Вытащить звук из видео отдельным файлом.
 *
 * Перекодируем в MP3, а не копируем дорожку как есть. Копия была бы быстрее и
 * точнее, но пришла бы в AAC — а модели, ради которых звук и вытаскивают
 * (Seedance по референсам), принимают только MP3 и WAV, и такая дорожка
 * оказалась бы бесполезной ровно там, где нужна. Для десятисекундного клипа
 * перекодирование занимает доли секунды. */
export async function extractAudio(src: string): Promise<ExtractedAudio> {
  return extractAudioFile(mediaFilePath(src))
}

/** Внутренний путь к уже проверенному файлу, в том числе кэшу командного ассета. */
export async function extractAudioFile(file: string): Promise<ExtractedAudio> {
  const { hasAudio } = await probeAudioFile(file)
  if (!hasAudio) throw new NoAudioTrackError()

  const { ffmpeg } = await requireFfmpeg()
  const { stdout } = await runTool(ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-vn', '-map', '0:a:0',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    '-f', 'mp3', '-',
  ], { timeoutMs: 120_000, maxStdoutBytes: 256 * 1024 * 1024 })

  if (stdout.length === 0) throw new NoAudioTrackError()

  const saved = await saveBuffer(stdout, 'audio/mpeg', `audio-${randomUUID()}`)
  const probed = await probeAudio(saved.url)
  return {
    url: saved.url,
    mime: saved.mime,
    duration: probed.duration,
    peaks: await audioPeaks(saved.url),
  }
}

export interface MuxedVideo {
  url: string
  mime: string
}

/** Склейка: видео получает звуковую дорожку из отдельного файла.
 *
 *  Видео КОПИРУЕТСЯ потоком (`-c:v copy`) — пережимать его незачем, меняется
 *  только дорожка, а перекодирование стоило бы времени и качества. Звук
 *  приводим к AAC: он влезает в mp4 всегда, в отличие от произвольного
 *  исходного кодека.
 *
 *  `-shortest` обязателен: без него дорожка длиннее видео растягивает файл
 *  чёрным хвостом, а короче — оставляет тишину до конца. */
export async function muxAudio(videoSrc: string, audioSrc: string): Promise<MuxedVideo> {
  const { ffmpeg } = await requireFfmpeg()
  const target = await mediaWritePath(`mux-${randomUUID()}.mp4`)

  await runTool(ffmpeg, [
    '-v', 'error',
    '-i', mediaFilePath(videoSrc),
    '-i', mediaFilePath(audioSrc),
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y', target,
  ], { timeoutMs: 300_000, maxStdoutBytes: 1024 * 1024 })

  return { url: `/media/${path.basename(target)}`, mime: 'video/mp4' }
}

export type VideoTimeline = VideoFacts & { audioCodec?: string }

/** Всё, что нужно таймлайну, одним запросом.
 *
 * Опорные кадры больше НЕ читаем: их вычитывание перебирало пакеты всего
 * потока (до 32 МБ вывода на длинном ролике) и нужно было только для снапа
 * меток. Резы перекодируются и встают куда угодно — читать стало нечего. */
export async function probeVideoTimeline(src: string): Promise<VideoTimeline> {
  return probeVideoFile(mediaFilePath(src))
}

/** Внутренний путь из media или проверенного кэша облачного аккаунта. */
export async function probeVideoFile(file: string): Promise<VideoTimeline> {
  const { ffprobe } = await requireFfmpeg()
  const facts = await runTool(ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
    '-of', 'json', file,
  ], { timeoutMs: 30_000, maxStdoutBytes: 1024 * 1024 })

  const json = facts.stdout.toString('utf8')
  const parsed = JSON.parse(json) as { streams?: Array<{ codec_type?: string; codec_name?: string }> }
  return { ...parseVideoFacts(json), audioCodec: parsed.streams?.find((stream) => stream.codec_type === 'audio')?.codec_name }
}

/**
 * Найти склейки в клипе. ОДИН проход декодирования — дальше ползунок
 * чувствительности отсекает уже посчитанное, без нового запуска ffmpeg.
 *
 * threshold=0 значит «не отбирай сам, отдай баллы всех кадров»: решение о том,
 * что считать склейкой, принимает человек ползунком, а не число, зашитое здесь.
 */
export async function detectShots(src: string): Promise<ShotCandidate[]> {
  return detectShotsFile(mediaFilePath(src))
}

/** Внутренний путь к уже проверенному файлу, в том числе кэшу командного ассета. */
export async function detectShotsFile(file: string): Promise<ShotCandidate[]> {
  const { ffmpeg } = await requireFfmpeg()
  const { stdout } = await runTool(ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-vf', 'scdet=threshold=0,metadata=print:key=lavfi.scd.score:file=-',
    '-an', '-f', 'null', '-',
  ], { timeoutMs: 180_000, maxStdoutBytes: 32 * 1024 * 1024 })

  return peakCandidates(parseShotScores(stdout.toString('utf8')))
}

export interface CutSegment {
  start: number
  end: number
}

export class InvalidVideoSegmentError extends Error {}

/** Рамка кадрирования в ДОЛЯХ кадра (0..1). Именно в долях, а не в пикселях:
 *  клиент рисует её поверх превью произвольного размера, и переводить одно в
 *  другое должна одна сторона — та, что знает настоящее разрешение. */
export interface NormalizedCrop {
  x: number
  y: number
  w: number
  h: number
}

let cachedEncoders: Set<string> | undefined

/** Какой кодировщик доступен. Спрашиваем ffmpeg один раз за запуск: список
 *  зашит в сборку и меняться не может. */
export async function selectEncoder(preferSoftware = false): Promise<VideoEncoder | null> {
  if (!cachedEncoders) {
    const { ffmpeg } = await requireFfmpeg()
    const { stdout } = await runTool(ffmpeg, ['-hide_banner', '-encoders'], {
      timeoutMs: 30_000,
      maxStdoutBytes: 8 * 1024 * 1024,
    })
    cachedEncoders = parseEncoders(stdout.toString('utf8'))
  }
  if (preferSoftware && cachedEncoders.has('libopenh264')) return 'libopenh264'
  return pickEncoder(cachedEncoders)
}

export interface CutPiece {
  url: string
  mime: string
  duration: number
  width: number | undefined
  height: number | undefined
}

/**
 * Нарезать видео на куски. Одна обрезка — частный случай одного куска.
 *
 * ВСЕГДА перекодируем. Копирование потока (`-c copy`) было бы мгновенным и
 * без потери качества, но оно умеет начинать кусок только с опорного кадра:
 * просишь с 3.4 — получаешь с 3.0. У импортированных роликов опорные кадры
 * стоят через одну-две секунды, и рез прыгал такими же ступенями. Решение
 * пользователя: рез обязан вставать туда, куда его поставили, а плата за
 * это — время и один проход сжатия.
 */
export async function cutVideo(
  src: string,
  segments: readonly CutSegment[],
  crop?: NormalizedCrop,
): Promise<CutPiece[]> {
  return cutVideoFile(mediaFilePath(src), segments, crop)
}

/** Внутренний путь к уже проверенному файлу, в том числе кэшу командного ассета. */
export async function cutVideoFile(
  input: string,
  segments: readonly CutSegment[],
  crop?: NormalizedCrop,
): Promise<CutPiece[]> {
  const { ffmpeg } = await requireFfmpeg()
  // Видео всегда перекодируется в H.264: контейнер исходника (например,
  // WebM) может его не поддерживать. Выход имеет единый браузерный формат.
  const extension = '.mp4'
  const pieces: CutPiece[] = []
  const source = await probeVideoFile(input)
  if (!source.width || !source.height || !source.duration) {
    throw new InvalidVideoSegmentError('The source file has no video with the requested duration')
  }
  // Проверяем ВСЕ куски до первой записи. Допуск — только на округление
  // таймлайна и -ss/-t до миллисекунды, а не на лишний кадр за концом.
  if (segments.some(({ start, end }) => !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end - start < 0.05 || start >= source.duration || end > source.duration + 0.001)) {
    throw new InvalidVideoSegmentError('Clip bounds exceed video duration')
  }

  // Кроп меняет каждый кадр, копированием потока его не сделать. Раз уж
  // пережимаем — делаем обе операции одной командой, а не режем и потом
  // кропаем: второй проход стоил бы столько же и ещё раз потерял качество.
  let filter: string | null = null
  const encoder = await selectEncoder()
  if (!encoder) throw new Error('No suitable encoder is available — nothing to cut')
  if (crop) {
    filter = cropFilter(crop, { width: source.width, height: source.height })
    if (!filter) throw new Error('The crop extends beyond the frame')
  }

  for (const segment of segments) {
    const fileName = `cut-${randomUUID()}${extension}`
    const target = await mediaWritePath(fileName)
    const temporary = `${target}.tmp${extension}`
    try {
      await runTool(ffmpeg, [
        '-v', 'error', '-y',
        // -ss ДО -i: быстрая перемотка по контейнеру. После -i ffmpeg
        // декодировал бы всё от начала файла до точки реза.
        '-ss', segment.start.toFixed(3),
        '-i', input,
        // -t после -i задаёт длительность; -to перед -i считался бы
        // по исходной шкале и удлинял дробные резы.
        '-t', Math.max(0.05, segment.end - segment.start).toFixed(3),
        ...(filter ? ['-vf', filter] : []),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', encoder, ...encoderArgs(encoder), '-pix_fmt', 'yuv420p',
        // AAC сохраняем без потерь, другие дорожки (например, Opus из WebM)
        // приводим к поддерживаемому вместе с H.264 браузерному формату.
        ...(source.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
        '-movflags', '+faststart',
        // Без -avoid_negative_ts make_zero: ранний AAC-пакет сдвинул бы
        // всё видео и растянул точный рез на разницу временных меток.
        temporary,
      ], { timeoutMs: 600_000 })
      // У контейнера может быть длинный аудиохвост после последнего кадра.
      // Успешный exit ffmpeg ещё не означает, что получился видеоклип.
      const facts = await probeVideoFile(temporary)
      if (!facts.width || !facts.height || !facts.duration) {
        throw new InvalidVideoSegmentError('In selected clip no video frames')
      }
      await fs.rename(temporary, target)
      pieces.push({ url: `/media/${fileName}`, mime: 'video/mp4', duration: facts.duration, width: facts.width, height: facts.height })
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      await Promise.all(pieces.map((piece) => fs.rm(mediaFilePath(piece.url), { force: true }).catch(() => undefined)))
      throw error
    }
  }

  return pieces
}
