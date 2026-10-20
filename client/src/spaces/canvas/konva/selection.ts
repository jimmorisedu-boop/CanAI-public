import type { GenRef, JobKind } from '../../../types'
import type { CanvasItem } from './types'
import { isAnimatedImageItem } from './animatedImageItem'

// Референс = выделенный на канвасе объект. Чипы в промпт-баре зеркалят выделение.
export interface SelectionRef {
  shapeId: string
  assetId?: string
  kind: 'image' | 'video' | 'text' | 'audio'
  label: string
  src?: string
  mime?: string
  text?: string
  w?: number
  h?: number
}

export function itemToRef(item: CanvasItem): SelectionRef | null {
  if (item.kind === 'image' && item.src) {
    return { shapeId: item.id, ...(item.assetId ? { assetId: item.assetId } : {}), kind: 'image', label: item.name || 'image', src: item.src, ...(item.mime ? { mime: item.mime } : {}), w: item.naturalWidth ?? item.w, h: item.naturalHeight ?? item.h }
  }
  if (item.kind === 'video' && item.src) {
    return { shapeId: item.id, ...(item.assetId ? { assetId: item.assetId } : {}), kind: 'video', label: item.name || 'video', src: item.src, w: item.naturalWidth ?? item.w, h: item.naturalHeight ?? item.h }
  }
  if (item.kind === 'audio' && item.src) {
    return { shapeId: item.id, ...(item.assetId ? { assetId: item.assetId } : {}), kind: 'audio', label: item.name || 'audio', src: item.src }
  }
  if (item.kind === 'text' && item.text?.trim()) {
    return { shapeId: item.id, kind: 'text', label: item.text.trim(), text: item.text.trim() }
  }
  return null
}

/** GIF stays animated on the board; generation receives only its first frame. */
export function isGifReference(ref: SelectionRef): boolean {
  return ref.kind === 'image' && isAnimatedImageItem({ src: ref.src, mime: ref.mime, name: ref.label })
}

// Из видео-референса модели нужна картинка — вытаскиваем первый кадр.
function videoFrameDataUrl(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.src = src
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(0.1, (video.duration || 1) / 2)
    })
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0)
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('failed to capture a frame from the video'))
      }
    })
    video.addEventListener('error', () => reject(new Error('failed to read the video reference')))
  })
}

// Превращает выделение в референсы для сервера. Видео-референс: если сами
// генерируем ВИДЕО — шлём как настоящее видео (сервер сам подберёт модель,
// умеющую его редактировать); иначе (картинка/текст) — снимаем кадр, как раньше.
export async function toGenRefs(refs: SelectionRef[], kind: JobKind): Promise<GenRef[]> {
  const out: GenRef[] = []
  for (const ref of refs) {
    if (ref.kind === 'text' && ref.text) {
      out.push({ kind: 'text', text: ref.text })
    } else if (ref.kind === 'image' && ref.src) {
      out.push({ kind: 'image', src: ref.src, assetId: ref.assetId, width: ref.w, height: ref.h })
    } else if (ref.kind === 'audio' && ref.src) {
      // Звук уходит как есть при любом kind: кадра из него не снять, а модели,
      // которые его берут (Seedance по референсам, Gemini), ждут audio_urls.
      // Несовместимой модели откажет сервер — там для этого есть validateModelRefs.
      out.push({ kind: 'audio', src: ref.src, assetId: ref.assetId })
    } else if (ref.kind === 'video' && ref.src) {
      if (kind === 'video') {
        out.push({ kind: 'video', src: ref.src, assetId: ref.assetId, width: ref.w, height: ref.h })
      } else {
        out.push({ kind: 'image', src: await videoFrameDataUrl(ref.src), width: ref.w, height: ref.h })
      }
    }
  }
  return out
}
