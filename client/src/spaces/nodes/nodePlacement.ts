export interface NodePoint {
  x: number
  y: number
}

export interface NodeRect extends NodePoint {
  width: number
  height: number
}

export interface NodePlacementRequest {
  preferred: NodePoint
  existing: NodeRect[]
  viewport: NodeRect
  nodeSize: { width: number; height: number }
  gap: number
}

export function placementScreenArea({
  flow,
  toolbar,
  baseGap,
  compactGap,
  compactWidth,
}: {
  flow: NodeRect
  toolbar: NodeRect | null
  baseGap: number
  compactGap: number
  compactWidth: number
}): { rect: NodeRect; gap: number } {
  const flowBottom = flow.y + flow.height
  const toolbarBottom = toolbar ? toolbar.y + toolbar.height : flow.y
  const top = Math.min(flowBottom, Math.max(flow.y, toolbarBottom))
  return {
    rect: {
      x: flow.x,
      y: top,
      width: flow.width,
      height: Math.max(1, flowBottom - top),
    },
    gap: flow.width < compactWidth ? compactGap : baseGap,
  }
}

export function visibleFlowViewportForPlacement({
  center,
  screenSize,
  currentZoom,
  maxZoom,
}: {
  center: NodePoint
  screenSize: { width: number; height: number }
  currentZoom: number
  maxZoom: number
}): { viewport: NodeRect; zoom: number } {
  const zoom = Math.max(0.01, Math.min(currentZoom, maxZoom))
  const width = screenSize.width / zoom
  const height = screenSize.height / zoom
  return {
    viewport: {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    },
    zoom,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function conflicts(candidate: NodeRect, existing: NodeRect[], gap: number): boolean {
  return existing.some(
    (rect) =>
      candidate.x < rect.x + rect.width + gap &&
      candidate.x + candidate.width + gap > rect.x &&
      candidate.y < rect.y + rect.height + gap &&
      candidate.y + candidate.height + gap > rect.y,
  )
}

export function findFreeNodePosition(request: NodePlacementRequest): NodePoint {
  const { existing, viewport, nodeSize } = request
  const gap = Math.max(0, request.gap)
  const minX = viewport.x
  const minY = viewport.y
  const maxX = viewport.x + viewport.width - nodeSize.width
  const maxY = viewport.y + viewport.height - nodeSize.height
  const preferred = {
    x: clamp(request.preferred.x, minX, maxX),
    y: clamp(request.preferred.y, minY, maxY),
  }

  const candidateAt = (x: number, y: number): NodeRect => ({
    x,
    y,
    width: nodeSize.width,
    height: nodeSize.height,
  })
  if (!conflicts(candidateAt(preferred.x, preferred.y), existing, gap)) {
    return preferred
  }

  const rowStep = nodeSize.height + gap
  const rows = Math.max(1, Math.ceil(Math.max(viewport.height, rowStep) / rowStep))
  const rowYs = [preferred.y]
  for (let step = 1; step <= rows; step += 1) {
    const below = preferred.y + step * rowStep
    const above = preferred.y - step * rowStep
    if (below <= maxY) rowYs.push(below)
    if (above >= minY) rowYs.push(above)
  }
  for (let row = 0; row < rowYs.length; row += 1) {
    const y = rowYs[row]
    const starts = row === 0 ? [preferred.x] : [minX]
    for (const rect of existing) {
      starts.push(rect.x + rect.width + gap)
    }
    for (const x of [...new Set(starts)].sort((a, b) => a - b)) {
      if (x < minX || x > maxX) continue
      if (!conflicts(candidateAt(x, y), existing, gap)) {
        return { x, y }
      }
    }
  }

  // Если видимая область уже плотно заполнена, продолжаем аккуратную раскладку
  // ниже неё: бесконечный холст важнее искусственного наложения нод.
  let y = viewport.y + viewport.height + gap
  while (conflicts(candidateAt(minX, y), existing, gap)) {
    y += rowStep
  }
  return { x: minX, y }
}
