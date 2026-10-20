import { api } from '../../../api'
import { loadImage } from './loadMedia'
import type { CanvasStore } from './canvasStore'
import { sketchResultName } from './mediaFileName'
import type { CanvasMediaUploader } from './cropApply'
import { CANVAS_SANS_FONT } from './fonts'
import { startLocalWork } from './localWorkPlaceholder'

function loadVideoFrame(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    video.currentTime = 0.1 // Seek slightly to get a frame
    video.onseeked = () => resolve(video)
    video.onerror = () => resolve(video) // Fallback if video fails to load
    video.src = src
    video.load()
  })
}

async function loadDrawable(item: { kind: string; src?: string }): Promise<HTMLImageElement | HTMLVideoElement | null> {
  if (!item.src) return null
  try {
    if (item.kind === 'video') {
      return await loadVideoFrame(item.src)
    } else {
      return await loadImage(item.src, 'image for the sketch')
    }
  } catch {
    return null
  }
}

function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

// Общая склейка: перекрывающиеся картинки/видео/тексты в границах целевой картинки + штрихи поверх неё.
// cap — ограничение длинной стороны (для отправки в fal), null — натуральное
// разрешение (для впекания). Вернёт null, если над картинкой нет штрихов.
async function composeSketch(
  store: CanvasStore,
  targetId: string,
  cap: number | null,
): Promise<HTMLCanvasElement | null> {
  const item = store.getItem(targetId)
  if (!item) return null

  const strokes = store.getStrokes()
  const inside = (x: number, y: number) =>
    x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h
  const relevant = strokes.filter((s) => {
    for (let i = 0; i < s.points.length; i += 2) if (inside(s.points[i], s.points[i + 1])) return true
    return false
  })
  if (relevant.length === 0) return null

  // 1. Находим все элементы, пересекающие targetId, включая сам targetId
  const allItems = store.getItems()
  const overlapping = allItems.filter((other) => intersects(other, item))

  // 2. Получаем натуральные размеры целевого элемента для пропорций холста
  let targetDrawable: HTMLImageElement | HTMLVideoElement | null = null
  if (item.src) {
    targetDrawable = await loadDrawable(item)
  }
  const natW = targetDrawable
    ? (targetDrawable as HTMLImageElement).naturalWidth || (targetDrawable as HTMLVideoElement).videoWidth || item.w
    : item.w
  const natH = targetDrawable
    ? (targetDrawable as HTMLImageElement).naturalHeight || (targetDrawable as HTMLVideoElement).videoHeight || item.h
    : item.h

  const longSide = Math.max(natW, natH)
  const scale = cap ? Math.min(1, cap / longSide) : 1
  const cw = Math.max(1, Math.round(natW * scale))
  const ch = Math.max(1, Math.round(natH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Коэффициенты преобразования мировых координат в пиксели новой картинки
  const kx = cw / item.w
  const ky = ch / item.h

  // 3. Загружаем все изображения/видео для перекрывающихся элементов
  const drawablesMap = new Map<string, HTMLImageElement | HTMLVideoElement | null>()
  await Promise.all(
    overlapping.map(async (other) => {
      if (other.id === item.id) {
        drawablesMap.set(other.id, targetDrawable)
      } else if (other.src) {
        const drawable = await loadDrawable(other)
        drawablesMap.set(other.id, drawable)
      }
    })
  )

  // 4. Отрисовываем все перекрывающиеся элементы в порядке слоев холста
  for (const other of overlapping) {
    const relX = other.x - item.x
    const relY = other.y - item.y
    const px = relX * kx
    const py = relY * ky
    const pw = other.w * kx
    const ph = other.h * ky

    if (other.kind === 'image' || other.kind === 'video') {
      const drawable = drawablesMap.get(other.id)
      if (drawable) {
        ctx.drawImage(drawable, px, py, pw, ph)
      }
    } else if (other.kind === 'text' && other.text) {
      ctx.fillStyle = '#ffffff'
      const fontSize = Math.round((other.fontSize ?? 15) * ky)
      ctx.font = `${fontSize}px ${CANVAS_SANS_FONT}`
      ctx.textBaseline = 'top'
      ctx.fillText(other.text, px, py)
    }
  }

  // 5. Штрихи собираем на прозрачном слое. Ластик стирает только рисунок,
  // а не исходную картинку под ним.
  const overlay = document.createElement('canvas')
  overlay.width = cw
  overlay.height = ch
  const overlayCtx = overlay.getContext('2d')
  if (!overlayCtx) return null
  overlayCtx.lineCap = 'round'
  overlayCtx.lineJoin = 'round'
  for (const s of relevant) {
    overlayCtx.globalCompositeOperation = s.tool === 'erase' ? 'destination-out' : 'source-over'
    overlayCtx.strokeStyle = s.color
    overlayCtx.lineWidth = Math.max(1, s.size * kx)
    overlayCtx.beginPath()
    for (let i = 0; i < s.points.length; i += 2) {
      const px = (s.points[i] - item.x) * kx
      const py = (s.points[i + 1] - item.y) * ky
      if (i === 0) overlayCtx.moveTo(px, py)
      else overlayCtx.lineTo(px, py)
    }
    overlayCtx.stroke()
  }
  ctx.drawImage(overlay, 0, 0)

  return canvas
}

// Для генерации: склейка в data-URL (длинная сторона ≤1600px — иначе
// многомегабайтный PNG падает на лимите загрузки). Нет штрихов → исходник.
export async function exportImageWithSketch(
  store: CanvasStore,
  targetId: string,
  fallbackSrc: string,
): Promise<string> {
  const canvas = await composeSketch(store, targetId, 1600)
  if (!canvas) return fallbackSrc
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return fallbackSrc
  }
}

// «Готово» в режиме скетча: склеиваем картинку + рисунок (натуральное
// разрешение), файл уходит в media и кладётся НОВОЙ картинкой рядом с исходной
// (с тем же интервалом, что и результаты) — оригинал остаётся чистым.
// Один шаг истории: Ctrl+Z уберёт новую картинку.
// Вернёт false, если рисовать нечего (штрихов над картинкой нет).
export async function bakeSketchToNewImage(
  store: CanvasStore,
  targetId: string,
  upload: CanvasMediaUploader = api.uploadFile,
): Promise<boolean> {
  const target = store.getItem(targetId)
  // ⚠️ Место занимаем ДО тяжёлой работы: склейка в натуральном разрешении и
  // отправка файла (на сетевой доске — по сети, мегабайтами) занимают
  // секунды, и без карточки холст всё это время молчит — «новый контент долго
  // появляется» (жалоба 09.09.2026). Готовая картинка заменит заглушку на её
  // месте, как результат генерации, и встанет размером исходной картинки.
  const work = startLocalWork(store, { label: 'Building image…', anchorId: targetId })
  try {
    const canvas = await composeSketch(store, targetId, null)
    if (!canvas) {
      work.fail()
      return false
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('failed to build sketch'))), 'image/png')
    })
    const uploaded = await upload(new File([blob], 'sketch.png', { type: 'image/png' }))
    await work.done(
      { assetId: uploaded.assetId, assetRevision: uploaded.assetRevision, assetChecksum: uploaded.assetChecksum, url: uploaded.url, mime: uploaded.mime },
      sketchResultName(target?.name),
    )
    return true
  } catch (error) {
    work.fail()
    throw error
  }
}
