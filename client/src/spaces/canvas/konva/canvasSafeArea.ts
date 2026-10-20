import type { Rect } from './generationSeriesGeometry'

export interface SafeEdgeOcclusion {
  edge: 'bottom' | 'right'
  rect: Rect
}

type OcclusionInput = Omit<SafeEdgeOcclusion, 'rect'> & {
  rect: Pick<Rect, 'x' | 'y'>
}

const DEFAULT_INSET = 16

function isFiniteContainer(rect: Rect): boolean {
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.w >= 0
    && rect.h >= 0
}

export function safeViewportFromOcclusions(
  container: Rect,
  occlusions: Array<SafeEdgeOcclusion | OcclusionInput>,
  inset = DEFAULT_INSET,
): Rect {
  if (!isFiniteContainer(container)) return { x: 0, y: 0, w: 0, h: 0 }

  const safeInset = Number.isFinite(inset) ? Math.max(0, inset) : DEFAULT_INSET
  let right = container.x + container.w
  let bottom = container.y + container.h
  for (const occlusion of occlusions) {
    if (!occlusion || !Number.isFinite(occlusion.rect.x) || !Number.isFinite(occlusion.rect.y)) continue
    if (occlusion.edge === 'bottom') {
      bottom = Math.min(bottom, Math.max(container.y, occlusion.rect.y - safeInset))
    } else if (occlusion.edge === 'right') {
      right = Math.min(right, Math.max(container.x, occlusion.rect.x - safeInset))
    }
  }
  return {
    x: container.x,
    y: container.y,
    w: Math.max(0, right - container.x),
    h: Math.max(0, bottom - container.y),
  }
}
