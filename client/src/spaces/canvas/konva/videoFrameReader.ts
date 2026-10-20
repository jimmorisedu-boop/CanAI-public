export interface VideoFrame { blob: Blob; width: number; height: number }

/** Готовый видимый кадр читаем сразу. Отдельный декодер освобождаем на любом исходе. */
export function frameBlob(src: string, time: number, options: {
  video?: HTMLVideoElement | null; timeoutMs?: number
  /** По умолчанию PNG в натуральном размере — так кадр встаёт на холст. */
  mime?: 'image/png' | 'image/jpeg'; quality?: number; maxSide?: number
} = {}): Promise<VideoFrame> {
  return new Promise((resolve, reject) => {
    const visible = options.video
    const reuse = visible && visible.readyState >= 2 && !visible.seeking
      && Math.abs(visible.currentTime - time) < 0.001
    const video = reuse ? visible : document.createElement('video')
    let settled = false
    let drawing = false
    let seeking = false
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('error', fail)
      video.removeEventListener('loadedmetadata', prepare)
      video.removeEventListener('loadeddata', prepare)
      video.removeEventListener('seeked', draw)
      if (!reuse) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
    const finish = (error?: unknown, frame?: VideoFrame) => {
      if (settled) return
      settled = true
      cleanup()
      if (frame) resolve(frame)
      else reject(error instanceof Error ? error : new Error('Failed to read a video frame'))
    }
    const fail = () => finish(new Error('Failed to read the video. Try again after the clip loads.'))
    const timer = setTimeout(() => finish(new Error('Video did not load in time. Try capturing the frame again.')), options.timeoutMs ?? 15_000)
    const draw = () => {
      if (settled || drawing || video.seeking || video.readyState < 2) return
      drawing = true
      try {
        const canvas = document.createElement('canvas')
        const longest = Math.max(video.videoWidth, video.videoHeight)
        const scale = options.maxSide && longest > options.maxSide ? options.maxSide / longest : 1
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const context = canvas.getContext('2d')
        if (!context || !canvas.width || !canvas.height) return fail()
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          if (blob) finish(undefined, { blob, width: canvas.width, height: canvas.height })
          else fail()
        }, options.mime ?? 'image/png', options.quality)
      } catch (error) { finish(error) }
    }
    const prepare = () => {
      if (settled || drawing) return
      const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : time
      const target = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, end))
      if (!seeking && Math.abs(video.currentTime - target) > 0.001) {
        seeking = true
        try { video.currentTime = target } catch (error) { finish(error) }
      } else if (!video.seeking) draw()
    }
    if (reuse) { draw(); return }
    video.muted = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.addEventListener('error', fail)
    video.addEventListener('loadedmetadata', prepare)
    video.addEventListener('loadeddata', prepare)
    video.addEventListener('seeked', draw)
    video.src = src
    video.load()
  })
}
