// Геометрия просмотра кропа. Область `rect` здесь намеренно не участвует:
// масштаб предпросмотра — состояние интерфейса, а не часть кропа в исходных
// пикселях.

export const CROP_PREVIEW_MIN_ZOOM = 0.5
export const CROP_HANDLE_SAFE_MARGIN = 30

export interface CropPreviewSize {
  w: number
  h: number
  scale: number
  fitScale: number
  zoom: number
}

export function fitCropPreview(
  bounds: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = CROP_HANDLE_SAFE_MARGIN,
  zoom = 1,
): CropPreviewSize {
  const safeZoom = Number.isFinite(zoom)
    ? Math.min(1, Math.max(CROP_PREVIEW_MIN_ZOOM, zoom))
    : 1
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : CROP_HANDLE_SAFE_MARGIN
  if (bounds.w <= 0 || bounds.h <= 0 || viewport.w < 2 || viewport.h < 2) {
    return { w: 0, h: 0, scale: 0, fitScale: 0, zoom: safeZoom }
  }

  const availableW = Math.max(1, viewport.w - safeMargin * 2)
  const availableH = Math.max(1, viewport.h - safeMargin * 2)
  const fitScale = Math.min(availableW / bounds.w, availableH / bounds.h)
  const scale = fitScale * safeZoom
  return {
    w: bounds.w * scale,
    h: bounds.h * scale,
    scale,
    fitScale,
    zoom: safeZoom,
  }
}
