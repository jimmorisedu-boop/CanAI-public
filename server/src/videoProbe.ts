// Разбор ответов ffprobe. Отдельно от запуска процесса — форматы вывода
// капризны, и проверять их надо на строках, а не на живом ffmpeg.

export interface VideoFacts {
  duration: number
  width: number | undefined
  height: number | undefined
  /** Кадров в секунду — по ней стрелки в таймлайне шагают ровно на кадр. */
  fps: number | undefined
  hasAudio: boolean
}

/** ffprobe отдаёт частоту дробью («24/1», «30000/1001»), а не числом. */
export function parseFrameRate(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const [top, bottom] = raw.split('/')
  const numerator = Number(top)
  const denominator = bottom === undefined ? 1 : Number(bottom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined
  const fps = numerator / denominator
  // «0/0» у файлов без внятной частоты: лучше не знать, чем поделить на ноль
  // и шагать стрелкой в бесконечность.
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : undefined
}

/** Разбор `-show_entries stream=codec_type,width,height,r_frame_rate:format=duration -of json`. */
export function parseVideoFacts(json: string): VideoFacts {
  const parsed = JSON.parse(json || '{}') as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>
    format?: { duration?: string }
  }
  const streams = parsed.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const duration = Number(parsed.format?.duration)
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: typeof video?.width === 'number' && video.width > 0 ? video.width : undefined,
    height: typeof video?.height === 'number' && video.height > 0 ? video.height : undefined,
    fps: parseFrameRate(video?.r_frame_rate),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  }
}
