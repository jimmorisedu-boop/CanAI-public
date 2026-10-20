import { api } from '../../../api'
import { loadImage } from './loadMedia'
import type { CanvasStore } from './canvasStore'
import type { Rect } from './cropMath'
import type { CanvasItem } from './types'
import { cropMetadataForAppliedRect, cropSessionForItem } from './cropState'
import { LEASE_REFUSED } from './boardLeaseActions'
import { startLocalWork } from './localWorkPlaceholder'

export interface CanvasMediaUpload {
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  url: string
  mime: string
}

export type CanvasMediaUploader = (
  file: File,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
) => Promise<CanvasMediaUpload>

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to build crop'))), mime, quality)
  })
}

function sameCrop(left: CanvasItem['crop'], right: CanvasItem['crop']): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.sourceSrc === right.sourceSrc
    && left.sourceAssetId === right.sourceAssetId
    && left.sourceMime === right.sourceMime
    && left.sourceNaturalWidth === right.sourceNaturalWidth
    && left.sourceNaturalHeight === right.sourceNaturalHeight
    && left.rect.x === right.rect.x
    && left.rect.y === right.rect.y
    && left.rect.w === right.rect.w
    && left.rect.h === right.rect.h
}

/**
 * Пока картинка декодируется и загружается, объект может измениться. Держим
 * под оптимистичной проверкой поля исходника и положения; несвязанные поля
 * (имя, метка, промпт) можно безопасно объединить с текущей версией.
 */
function sameCropTarget(left: CanvasItem | undefined, right: CanvasItem): boolean {
  if (!left) return false
  return left.id === right.id
    && left.kind === right.kind
    && left.src === right.src
    && left.assetId === right.assetId
    && left.mime === right.mime
    && left.naturalWidth === right.naturalWidth
    && left.naturalHeight === right.naturalHeight
    && left.x === right.x
    && left.y === right.y
    && left.w === right.w
    && left.h === right.h
    && left.rotation === right.rotation
    && sameCrop(left.crop, right.crop)
}

function cropTargetChanged(): Error {
  return new Error('Image changed or was deleted while preparing the crop')
}


/** Кусок уже вырезан — осталось отправить файл и поставить его на место. */
export interface PreparedCrop {
  file: File
  /** Где и какого размера встанет результат: там же стоит карточка на время загрузки. */
  rect: { x: number; y: number; w: number; h: number; rotation?: number }
  /** Откуда вырезано и какой кусок — карточка показывает его, пока файл едет. */
  sourceSrc: string
  sourceCrop: { x: number; y: number; width: number; height: number }
  /** Поставить отправленный файл на место исходника (один шаг истории). */
  commit(uploaded: CanvasMediaUpload): Promise<void>
}

// Обрезает картинку в НАТУРАЛЬНОМ разрешении (окно rect — в экранных единицах
// item) и готовит правку объекта на месте. JPEG остаётся JPEG; остальные
// форматы сохраняем в PNG, чтобы WebP/GIF/AVIF не теряли прозрачность и цвет.
export async function prepareCrop(store: CanvasStore, item: CanvasItem, rect: Rect): Promise<PreparedCrop> {
  if (!item.src) throw new Error('Object has no file')

  // `item` может быть развёрнутой сессией кропа (видимый объект всё ещё
  // указывает на предыдущий результат), поэтому сверяемся с объектом доски.
  // Это только дешёвая предварительная проверка; та же проверка повторяется
  // внутри финального callback аренды после всех await.
  const expectedTarget = store.getItem(item.id)
  if (!expectedTarget || !sameCropTarget(store.getItem(item.id), expectedTarget)) throw cropTargetChanged()
  const expectedSession = cropSessionForItem(expectedTarget)
  if (!sameCropTarget(expectedSession.item, item)) throw cropTargetChanged()

  const img = await loadImage(item.src)
  const natW = img.naturalWidth || item.w
  const natH = img.naturalHeight || item.h

  const kx = natW / item.w
  const ky = natH / item.h
  const sx = Math.max(0, Math.round(rect.x * kx))
  const sy = Math.max(0, Math.round(rect.y * ky))
  const sw = Math.max(1, Math.min(natW - sx, Math.round(rect.w * kx)))
  const sh = Math.max(1, Math.min(natH - sy, Math.round(rect.h * ky)))

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  const keepPng = item.mime !== 'image/jpeg'
  const mime = keepPng ? 'image/png' : 'image/jpeg'
  const blob = await toBlob(canvas, mime, keepPng ? undefined : 0.92)

  // смещение окна в мировые координаты с учётом поворота вокруг (x, y)
  const rad = ((item.rotation ?? 0) * Math.PI) / 180
  const dx = rect.x * Math.cos(rad) - rect.y * Math.sin(rad)
  const dy = rect.x * Math.sin(rad) + rect.y * Math.cos(rad)

  const geometry = {
    naturalWidth: sw,
    naturalHeight: sh,
    crop: cropMetadataForAppliedRect({
      item: { ...item, naturalWidth: natW, naturalHeight: natH },
      savedRect: null,
    }, rect),
    x: item.x + dx,
    y: item.y + dy,
    w: rect.w,
    h: rect.h,
  }

  return {
    file: new File([blob], `crop.${keepPng ? 'png' : 'jpg'}`, { type: mime }),
    rect: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h, rotation: item.rotation },
    sourceSrc: item.src,
    sourceCrop: { x: sx, y: sy, width: sw, height: sh },
    async commit(uploaded) {
      // Берём (или берём заново) аренду только после завершения сетевой
      // работы. Callback выполняется при владении слотом и прямо перед
      // updateItem сверяет тот же снимок исходника/геометрии: поздняя чужая
      // правка или удаление не будут перезаписаны этим upload.
      const admitted = await store.withSelection([item.id], () => {
        const current = store.getItem(item.id)
        if (!current) throw cropTargetChanged()
        let shift = { x: 0, y: 0 }
        if (!sameCropTarget(current, expectedTarget)) {
          // ⚠️ Пока файл ехал, объект могли просто передвинуть: режим обрезки
          // закрывается сразу (пункт 3.6), и хвататься за картинку можно
          // тут же. Переезд — не повод терять обрезку: сдвигаем результат
          // вместе с ней. Любая другая перемена — отказ, как раньше.
          if (!sameCropTarget({ ...current, x: expectedTarget.x, y: expectedTarget.y }, expectedTarget)) {
            throw cropTargetChanged()
          }
          shift = { x: current.x - expectedTarget.x, y: current.y - expectedTarget.y }
        }
        if (!store.canMutateItems([item.id])) throw new Error(LEASE_REFUSED)
        store.updateItem(item.id, {
          src: uploaded.url,
          assetId: uploaded.assetId,
          assetRevision: uploaded.assetRevision,
          assetChecksum: uploaded.assetChecksum,
          mime: uploaded.mime,
          ...geometry,
          x: geometry.x + shift.x,
          y: geometry.y + shift.y,
        })
      })
      if (!admitted) throw new Error(LEASE_REFUSED)
    },
  }
}

// Обрезка целиком: вырезать, отправить и поставить на место — с ожиданием.
// Один шаг истории: Ctrl+Z вернёт как было.
export async function applyCrop(
  store: CanvasStore,
  item: CanvasItem,
  rect: Rect,
  upload: CanvasMediaUploader = api.uploadFile,
): Promise<void> {
  const prepared = await prepareCrop(store, item, rect)
  await prepared.commit(await upload(prepared.file))
}

/**
 * Обрезка без ожидания (пункт 3.6, находка Ф-7 аудита сетевой доски):
 * кусок вырезается сразу, и на этом обещание выполнено — режим обрезки можно
 * закрывать. Файл едет на сервер фоном, а на месте результата всё это время
 * стоит карточка С САМИМ результатом и процентами загрузки. Раньше режим
 * держался открытым всю дорогу файла туда и обратно.
 *
 * Возвращается, когда кусок вырезан; сбой загрузки уходит в `onFailure`.
 */
export async function applyCropInBackground(
  store: CanvasStore,
  item: CanvasItem,
  rect: Rect,
  upload: CanvasMediaUploader,
  onFailure: (error: unknown) => void,
): Promise<void> {
  const prepared = await prepareCrop(store, item, rect)
  const work = startLocalWork(store, {
    label: 'Crop',
    rect: prepared.rect,
    preview: { previewSrc: prepared.sourceSrc, previewCrop: prepared.sourceCrop },
  })
  void (async () => {
    try {
      const uploaded = await upload(prepared.file, undefined, work.progress)
      // Карточку убрали, пока файл ехал, — от обрезки отказались: исходник
      // остаётся как был. Раньше карточка не убиралась вовсе, а на Delete
      // отвечала «Генерация ещё идёт» (жалоба 01.10.2026).
      if (work.dropped()) return
      await prepared.commit(uploaded)
    } catch (error) {
      if (!work.dropped()) onFailure(error)
    } finally {
      work.finish()
    }
  })()
}
