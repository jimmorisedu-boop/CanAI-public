// Натуральные размеры media из файла (fal не всегда отдаёт width/height).

// Результат оплачен, но картинку не удалось прочитать; клиент не должен
// ставить на доску «угаданные» размеры и портить пропорции вёрстки.
export const DELIVERY_IMAGE_DIMENSIONS_FAILED =
  'Result is ready, but the image could not be loaded; refresh the board or try again later'

export function probeImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    let done = false
    const finish = (size: { width: number; height: number }) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      img.onload = null
      img.onerror = null
      resolve(size)
    }
    const timer = window.setTimeout(() => finish({ width: 1024, height: 768 }), 10_000)
    img.onload = () => finish({ width: img.naturalWidth || 1024, height: img.naturalHeight || 768 })
    img.onerror = () => finish({ width: 1024, height: 768 })
    img.src = src
  })
}

function apiSize(w?: number, h?: number): { width: number; height: number } | null {
  if (typeof w === 'number' && Number.isFinite(w) && w > 0 && typeof h === 'number' && Number.isFinite(h) && h > 0) {
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }
  }
  return null
}

/**
 * Чтение размера сгенерированного изображения для размещения на холсте.
 *
 * Успешное декодирование ВСЕГДА побеждает провайдерские width/height: fal
 * (особенно GPT Image) отдавал неверную ширину, и картинка играла в «портрет
 * горизонтально». Если файл не удалось прочитать (сеть/таймаут/ошибка),
 * берём только проверенную конечную положительную пару из API. Ничего не
 * угадываем: возвращаем null, а вызывающий не кладёт ложные natural-размеры.
 */
export function probeGeneratedImageSize(
  src: string,
  options: { apiWidth?: number; apiHeight?: number; timeoutMs?: number } = {},
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    let done = false
    const finish = (size: { width: number; height: number } | null) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      img.onload = null
      img.onerror = null
      resolve(size)
    }
    const timer = window.setTimeout(
      () => finish(apiSize(options.apiWidth, options.apiHeight)),
      options.timeoutMs ?? 10_000,
    )
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        finish({ width: img.naturalWidth, height: img.naturalHeight })
      } else {
        finish(apiSize(options.apiWidth, options.apiHeight))
      }
    }
    img.onerror = () => finish(apiSize(options.apiWidth, options.apiHeight))
    img.src = src
  })
}

/** Длительность звука. undefined — не прочиталась: плашка покажет прочерк,
 * а не выдуманный ноль, за которым не видно, что файл вообще-то длинный. */
export function probeAudioDuration(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    let done = false
    const finish = (value: number | undefined) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      audio.removeAttribute('src')
      resolve(value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined)
    }
    const timer = window.setTimeout(() => finish(undefined), 10_000)
    audio.preload = 'metadata'
    audio.src = src
    audio.addEventListener('loadedmetadata', () => finish(audio.duration), { once: true })
    audio.addEventListener('error', () => finish(undefined), { once: true })
  })
}

export function probeVideoSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    let done = false
    const finish = (size: { width: number; height: number }) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(size)
    }
    const timer = window.setTimeout(() => finish({ width: 1024, height: 576 }), 10_000)
    video.src = src
    video.addEventListener(
      'loadedmetadata',
      () => finish({ width: video.videoWidth || 1024, height: video.videoHeight || 576 }),
      { once: true },
    )
    video.addEventListener('error', () => finish({ width: 1024, height: 576 }), { once: true })
  })
}
