import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { layoutMediaGrid } from '../spaces/canvas/konva/mediaGridLayout'
import type { TabletMediaUpload } from './runtime'

export type UploadedVideoFrame = TabletMediaUpload & { width: number; height: number; time: number }

/**
 * ⚠️ Кадры встают шириной клипа на доске: они в его натуральном разрешении,
 * значит та же ширина и есть тот же масштаб (жалоба 22.09.2026). Прежний
 * потолок в 440 уменьшал кадры растянутого клипа.
 */
export function placeVideoFrames(store: CanvasStore, source: CanvasItem, frames: UploadedVideoFrame[]): string[] {
  const rects = layoutMediaGrid(frames, { x: 0, y: 0 }, { itemWidth: source.w, gap: 24 })
  const items: CanvasItem[] = frames.map((frame, index) => ({
    id: `frame-${index}`, kind: 'image', ...rects[index], src: frame.url, mime: frame.mime,
    ...(frame.assetId ? { assetId: frame.assetId } : {}),
    naturalWidth: frame.width, naturalHeight: frame.height, name: `Frame ${frame.time.toFixed(3)} s.png`,
  }))
  return store.pasteItems(items, { x: source.x + source.w + 24, y: source.y })
}
