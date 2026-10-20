export interface MediaSize {
  width: number
  height: number
}
export interface MediaGridRect {
  x: number
  y: number
  w: number
  h: number
}

export interface MediaGridOptions {
  columns?: number
  gap?: number
  itemWidth?: number | null
}

export function defaultGridColumns(count: number): number {
  if (count <= 1) return 1
  return Math.min(6, Math.max(2, Math.ceil(Math.sqrt(count))))
}

function safeSize(size: MediaSize): MediaSize {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 1
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : width
  return { width, height }
}

export function layoutMediaGrid(
  sizes: MediaSize[],
  anchor: { x: number; y: number },
  options: MediaGridOptions = {},
): MediaGridRect[] {
  if (sizes.length === 0) return []
  const columns = Math.min(sizes.length, Math.max(1, Math.round(options.columns ?? defaultGridColumns(sizes.length))))
  const gap = Math.max(0, Number.isFinite(options.gap) ? options.gap! : 32)
  const itemWidth = options.itemWidth === null
    ? null
    : Math.max(40, Number.isFinite(options.itemWidth) ? options.itemWidth! : 440)
  const scaled = sizes.map((raw) => {
    const size = safeSize(raw)
    if (itemWidth === null) return { w: size.width, h: size.height }
    return { w: itemWidth, h: Math.max(40, (itemWidth * size.height) / size.width) }
  })

  const rows = Math.ceil(scaled.length / columns)
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...scaled.filter((_, index) => index % columns === column).map((size) => size.w)),
  )
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(0, ...scaled.slice(row * columns, (row + 1) * columns).map((size) => size.h)),
  )
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0) + gap * (columns - 1)
  const totalHeight = rowHeights.reduce((sum, height) => sum + height, 0) + gap * (rows - 1)
  const columnX: number[] = []
  const rowY: number[] = []
  let x = anchor.x - totalWidth / 2
  for (const width of columnWidths) {
    columnX.push(x)
    x += width + gap
  }
  let y = anchor.y - totalHeight / 2
  for (const height of rowHeights) {
    rowY.push(y)
    y += height + gap
  }

  return scaled.map((size, index) => ({
    x: columnX[index % columns],
    y: rowY[Math.floor(index / columns)],
    w: size.w,
    h: size.h,
  }))
}
