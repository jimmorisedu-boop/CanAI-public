import type { CanvasStore } from './canvasStore'
import { startLocalWork } from './localWorkPlaceholder'

/** Хитбокс одной кнопки на клипе; кружок радиусом 19 стоит по его центру. */
export const VIDEO_FRAME_CAPTURE_SIZE = 44
const VIDEO_CONTROL_RADIUS = 19

/**
 * Кружок кнопки отстоит от края клипа ровно на столько же, на сколько плашки
 * с именем и временем внизу (8). Раньше коробка кнопки начиналась в самом углу,
 * и кружок почти касался края — вплотную к рамке выделения (просьба
 * 21.09.2026 «отступы от края чуть дальше»).
 */
export const VIDEO_CONTROL_EDGE = 8
export const VIDEO_CONTROL_INSET = VIDEO_CONTROL_EDGE - (VIDEO_FRAME_CAPTURE_SIZE / 2 - VIDEO_CONTROL_RADIUS)
export const VIDEO_CONTROL_CY = VIDEO_CONTROL_INSET + VIDEO_FRAME_CAPTURE_SIZE / 2

/** Звук — первым, у самого угла; кадр — следом, тем же шагом (просьба 21.09.2026). */
export const MUTE_CX = VIDEO_CONTROL_INSET + VIDEO_FRAME_CAPTURE_SIZE / 2
export const CAPTURE_CX = MUTE_CX + VIDEO_FRAME_CAPTURE_SIZE

/**
 * Снять кадр и положить его на холст, ПОКАЗЫВАЯ ожидание.
 *
 * Одна точка на оба входа — кнопку на клипе и правку клипа: снимок и отправка
 * файла занимают секунды, и без карточки холст всё это время молчит (жалоба
 * 09.09.2026 «новый контент долго появляется»). Заглушка ведёт себя как у
 * генерации: встаёт рядом с клипом и заменяется готовым кадром на месте.
 *
 * ⚠️ Выделенным остаётся КЛИП: кадры снимают подряд, и перескок выделения на
 * каждый снимок сбивал бы работу.
 *
 * ⚠️ Кадр встаёт размером клипа на доске (см. `startLocalWork`): клип можно
 * растянуть как угодно, и кадр обязан быть в том же масштабе.
 */
export async function captureFrameToCanvas(
  store: CanvasStore,
  video: { id: string },
  produce: () => Promise<{ blob: Blob; width: number; height: number; name: string }>,
  upload: (file: File) => Promise<{ assetId?: string; assetRevision?: number; assetChecksum?: string; url: string; mime: string }>,
): Promise<string | null> {
  const work = startLocalWork(store, { label: 'Capturing frame…', anchorId: video.id })
  try {
    const { blob, name, width, height } = await produce()
    const uploaded = await upload(new File([blob], name, { type: blob.type || 'image/png' }))
    await work.done({ url: uploaded.url, mime: uploaded.mime, assetId: uploaded.assetId, assetRevision: uploaded.assetRevision, assetChecksum: uploaded.assetChecksum, width, height }, name)
    store.select(video.id)
    return store.getItems().find((item) => item.src === uploaded.url)?.id ?? null
  } catch (error) {
    work.fail()
    throw error
  }
}

/** Кнопки кадра и звука имеют один внутренний размер у любого клипа.
 *
 * Раньше коэффициент зависел от меньшей стороны видео и гулял от 0.55 до 2.5:
 * одинаковый контрол становился то крошечным, то почти стотипиксельным ещё до
 * масштаба холста. Габариты объекта не должны менять геометрию управления. */
export function videoControlScale(_w: number, _h: number): number {
  return 1
}

/** Попадание по кнопке кадра: её коробка — второе место от угла. */
export function isVideoFrameCapturePoint(point: { x: number; y: number }, scale = 1): boolean {
  const k = scale > 0 ? scale : 1
  const left = (CAPTURE_CX - VIDEO_FRAME_CAPTURE_SIZE / 2) * k
  const top = VIDEO_CONTROL_INSET * k
  const size = VIDEO_FRAME_CAPTURE_SIZE * k
  return point.x >= left
    && point.y >= top
    && point.x < left + size
    && point.y < top + size
}
