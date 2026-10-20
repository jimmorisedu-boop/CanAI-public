import type { Rect } from './cropMath'
import type { CanvasCrop, CanvasItem } from './types'

export interface CropSession {
  item: CanvasItem
  savedRect: Rect | null
}

function rotatedOffset(x: number, y: number, rotation = 0): { x: number; y: number } {
  const radians = rotation * Math.PI / 180
  return {
    x: x * Math.cos(radians) - y * Math.sin(radians),
    y: x * Math.sin(radians) + y * Math.cos(radians),
  }
}

export function cropSessionForItem(item: CanvasItem): CropSession {
  const crop = item.crop
  if (!crop) return { item, savedRect: null }

  const w = item.w / crop.rect.w
  const h = item.h / crop.rect.h
  const savedRect = {
    x: crop.rect.x * w,
    y: crop.rect.y * h,
    w: item.w,
    h: item.h,
  }
  const offset = rotatedOffset(savedRect.x, savedRect.y, item.rotation)

  return {
    item: {
      ...item,
      x: item.x - offset.x,
      y: item.y - offset.y,
      w,
      h,
      src: crop.sourceSrc ?? item.src,
      assetId: crop.sourceAssetId ?? item.assetId,
      mime: crop.sourceMime,
      naturalWidth: crop.sourceNaturalWidth,
      naturalHeight: crop.sourceNaturalHeight,
    },
    savedRect,
  }
}

export function cropMetadataForAppliedRect(session: CropSession, rect: Rect): CanvasCrop {
  const existing = session.item.crop
  const sourceAssetId = existing?.sourceAssetId ?? session.item.assetId
  return {
    sourceSrc: existing?.sourceSrc ?? session.item.src!,
    ...(sourceAssetId ? { sourceAssetId } : {}),
    sourceMime: existing?.sourceMime ?? session.item.mime,
    sourceNaturalWidth: existing?.sourceNaturalWidth ?? session.item.naturalWidth ?? session.item.w,
    sourceNaturalHeight: existing?.sourceNaturalHeight ?? session.item.naturalHeight ?? session.item.h,
    rect: {
      x: rect.x / session.item.w,
      y: rect.y / session.item.h,
      w: rect.w / session.item.w,
      h: rect.h / session.item.h,
    },
  }
}
