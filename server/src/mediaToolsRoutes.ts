import { Router } from 'express'
import { ffmpegPlatform, type FfmpegBinary, type FfmpegBinaryState } from './ffmpegBinary.js'
import {
  audioPeaks,
  cutVideo,
  detectShots,
  extractAudio,
  muxAudio,
  InvalidVideoSegmentError,
  NoAudioTrackError,
  probeVideoTimeline,
  type CutSegment,
  type NormalizedCrop,
} from './mediaOps.js'
import { isValidMediaSrc } from './canvasSnapshot.js'

// Портативный компонент обработки видео: состояние и загрузка по кнопке.
// Загрузка НЕ висит на запросе — сорок мегабайт дольше, чем живёт HTTP, а
// пользователю нужен живой процент, а не крутящийся браузер. Поэтому POST
// только запускает, а прогресс забирается тем же GET.

export interface PublicFfmpegState {
  state: FfmpegBinaryState['state']
  /** ready: откуда взялся — своя копия в runtime/ или системный. */
  source?: 'runtime' | 'system'
  percent?: number
  message?: string
  /** Можно ли вообще скачать сборку кнопкой. На macOS — нет: она приезжает
   *  вместе с приложением, и предлагать «Скачать» там значит звать к кнопке,
   *  которая ничего не сделает. */
  downloadable?: boolean
}

/** Начинать ли закачку по нажатию кнопки.
 *
 * Системный ffmpeg отказом НЕ является: кнопку жмут ровно затем, чтобы
 * появилась СВОЯ копия, которая переедет вместе с папкой приложения. Пока
 * здесь стояла проверка «нашёлся хоть какой-нибудь» — на машине с системным
 * ffmpeg кнопка молча не делала ничего. */
export function shouldStartFfmpegDownload(state: FfmpegBinaryState): boolean {
  if (state.state === 'downloading') return false
  if (state.state === 'unsupported') return false
  return !(state.state === 'ready' && state.source === 'runtime')
}

export function publicFfmpegState(
  state: FfmpegBinaryState,
  // Отдельным аргументом, а не чтением платформы внутри: так функция остаётся
  // чистой и её можно проверить за обе системы сразу.
  downloadable: boolean = Boolean(ffmpegPlatform()?.asset),
): PublicFfmpegState {
  if (state.state === 'ready') return { state: 'ready', source: state.source }
  if (state.state === 'downloading') return { state: 'downloading', percent: state.percent }
  if (state.state === 'failed') return { state: 'failed', message: state.message }
  if (state.state === 'missing') return { state: 'missing', downloadable }
  return { state: state.state }
}

export function createMediaToolsRouter(binary: FfmpegBinary): Router {
  const router = Router()

  router.get('/media-tools/ffmpeg', async (_req, res) => {
    // locate() не трогает состояние идущей закачки — можно опрашивать во время неё
    await binary.locate()
    res.json(publicFfmpegState(binary.getState()))
  })

  router.post('/media-tools/ffmpeg/prepare', async (_req, res) => {
    await binary.locate()
    if (!shouldStartFfmpegDownload(binary.getState())) {
      return res.json(publicFfmpegState(binary.getState()))
    }
    // Отказ ловим здесь же: без catch падение уехало бы в unhandledRejection,
    // а пользователь так и остался бы смотреть на «downloading».
    binary.download().catch(() => undefined)
    res.json(publicFfmpegState(binary.getState()))
  })

  // Склейка видео и звука: локальная операция, денег не стоит.
  router.post('/media/mux-audio', async (req, res) => {
    const { video, audio } = (req.body ?? {}) as { video?: unknown; audio?: unknown }
    if (typeof video !== 'string' || !isValidMediaSrc(video)) {
      return res.status(400).json({ error: 'Expected link on video in media' })
    }
    if (typeof audio !== 'string' || !isValidMediaSrc(audio)) {
      return res.status(400).json({ error: 'Expected link on audio in media' })
    }
    try {
      res.json(await muxAudio(video, audio))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not merge the media' })
    }
  })

  router.post('/media/extract-audio', async (req, res) => {
    const src = (req.body ?? {}).src
    if (typeof src !== 'string' || !isValidMediaSrc(src)) {
      return res.status(400).json({ error: 'Expected a link to a file in /media/' })
    }
    try {
      res.json(await extractAudio(src))
    } catch (error) {
      // Немое видео — не сбой, а честный ответ пользователю: он выделил
      // клип, у которого просто нет дорожки.
      if (error instanceof NoAudioTrackError) return res.status(409).json({ error: error.message })
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not extract audio' })
    }
  })

  router.post('/media/audio-peaks', async (req, res) => {
    const src = (req.body ?? {}).src
    if (typeof src !== 'string' || !isValidMediaSrc(src)) {
      return res.status(400).json({ error: 'Expected a link to a file in /media/' })
    }
    // Волна необязательна: не посчиталась — плашка просто без картинки,
    // поэтому здесь никогда не 500.
    res.json({ peaks: await audioPeaks(src).catch(() => undefined) })
  })

  router.post('/media/probe-video', async (req, res) => {
    const src = (req.body ?? {}).src
    if (typeof src !== 'string' || !isValidMediaSrc(src)) {
      return res.status(400).json({ error: 'Expected a link to a file in /media/' })
    }
    try {
      res.json(await probeVideoTimeline(src))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not read the video' })
    }
  })

  router.post('/media/detect-shots', async (req, res) => {
    const src = (req.body ?? {}).src
    if (typeof src !== 'string' || !isValidMediaSrc(src)) {
      return res.status(400).json({ error: 'Expected a link to a file in /media/' })
    }
    try {
      res.json({ candidates: await detectShots(src) })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not detect shots' })
    }
  })

  router.post('/media/cut-video', async (req, res) => {
    const { src, segments } = (req.body ?? {}) as { src?: unknown; segments?: unknown }
    if (typeof src !== 'string' || !isValidMediaSrc(src)) {
      return res.status(400).json({ error: 'Expected a link to a file in /media/' })
    }
    const parsed = parseSegments(segments)
    if (!parsed) return res.status(400).json({ error: 'Segments specified incorrectly' })
    const cropped = parseCrop((req.body ?? {}).crop)
    if (cropped === null) return res.status(400).json({ error: 'Frame crop specified incorrectly' })
    try {
      res.json({ pieces: await cutVideo(src, parsed, cropped) })
    } catch (error) {
      if (error instanceof InvalidVideoSegmentError) return res.status(422).json({ error: error.message })
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not cut video' })
    }
  })

  return router
}

/** Рамка кадрирования: undefined — кропа нет, null — прислали мусор.
 *  Разделять эти два случая важно: «нет рамки» значит быстрый рез копированием
 *  потока, а мусор должен получить отказ, а не молча превратиться в него же. */
export function parseCrop(raw: unknown): NormalizedCrop | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') return null
  const { x, y, w, h } = raw as Record<string, unknown>
  for (const value of [x, y, w, h]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
  }
  const crop = { x: x as number, y: y as number, w: w as number, h: h as number }
  if (crop.w <= 0 || crop.h <= 0) return null
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001) return null
  // Рамка во весь кадр — это отсутствие кропа. Гонять ради неё перекодирование
  // значит потерять качество и время ни за чем.
  if (crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999) return undefined
  return crop
}

/** Границы кусков приходят с клиента, поэтому проверяются здесь заново:
 *  сотня кусков или отрицательная длительность превратились бы в сотню
 *  запусков ffmpeg и мусор в media. */
export function parseSegments(raw: unknown): CutSegment[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return null
  const out: CutSegment[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null
    const { start, end } = value as { start?: unknown; end?: unknown }
    if (typeof start !== 'number' || typeof end !== 'number') return null
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start < 0 || end - start < 0.05) return null
    out.push({ start, end })
  }
  return out
}
