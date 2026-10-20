import { itemAabb, type Bounds } from './geometry'
import { layoutMediaGrid } from './mediaGridLayout'
import type { CanvasItem } from './types'

/** The six edges and centres exposed by the multi-selection arrange controls. */
export type SelectionAlignment =
  | 'left'
  | 'center-x'
  | 'right'
  | 'top'
  | 'center-y'
  | 'bottom'

export type SelectionArrangement = 'row' | 'column' | 'grid'

export interface SelectionPositionPatch {
  id: string
  x: number
  y: number
}

export interface SelectionArrangeOptions {
  columns?: number
  gap?: number
}

function safeBounds(item: CanvasItem): Bounds {
  const bounds = itemAabb(item)
  return {
    x: Number.isFinite(bounds.x) ? bounds.x : item.x,
    y: Number.isFinite(bounds.y) ? bounds.y : item.y,
    w: Number.isFinite(bounds.w) && bounds.w >= 0 ? bounds.w : Math.max(0, item.w),
    h: Number.isFinite(bounds.h) && bounds.h >= 0 ? bounds.h : Math.max(0, item.h),
  }
}

/**
 * Return the world-space AABB for a selection. Rotation is accounted for here
 * so all arrangement actions share the same visual edges as the canvas.
 */
export function selectionBounds(items: readonly CanvasItem[]): Bounds | null {
  if (items.length === 0) return null
  const bounds = items.map(safeBounds)
  const minX = Math.min(...bounds.map((rect) => rect.x))
  const minY = Math.min(...bounds.map((rect) => rect.y))
  const maxX = Math.max(...bounds.map((rect) => rect.x + rect.w))
  const maxY = Math.max(...bounds.map((rect) => rect.y + rect.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function patchToAabb(item: CanvasItem, from: Bounds, target: { x: number; y: number }): SelectionPositionPatch {
  // Moving an item by a delta keeps its width, height, and rotation untouched.
  // This is also correct for rotated items because translation moves their AABB
  // by exactly the same vector as the item's local origin.
  return { id: item.id, x: item.x + target.x - from.x, y: item.y + target.y - from.y }
}

/** Compute alignment patches without mutating a store. */
export function alignSelection(
  items: readonly CanvasItem[],
  alignment: SelectionAlignment,
): SelectionPositionPatch[] {
  const selection = selectionBounds(items)
  if (!selection || items.length < 2) return []
  const bounds = items.map(safeBounds)
  const centerX = selection.x + selection.w / 2
  const centerY = selection.y + selection.h / 2
  return items.map((item, index) => {
    const current = bounds[index]!
    switch (alignment) {
      case 'left':
        return patchToAabb(item, current, { x: selection.x, y: current.y })
      case 'center-x':
        return patchToAabb(item, current, { x: centerX - current.w / 2, y: current.y })
      case 'right':
        return patchToAabb(item, current, { x: selection.x + selection.w - current.w, y: current.y })
      case 'top':
        return patchToAabb(item, current, { x: current.x, y: selection.y })
      case 'center-y':
        return patchToAabb(item, current, { x: current.x, y: centerY - current.h / 2 })
      case 'bottom':
        return patchToAabb(item, current, { x: current.x, y: selection.y + selection.h - current.h })
    }
  })
}

function clampGap(gap: number | undefined): number {
  return Math.min(160, Math.max(0, Number.isFinite(gap) ? gap! : 32))
}

function clampColumns(columns: number | undefined, count: number): number {
  return Math.min(count, Math.max(1, Math.round(Number.isFinite(columns) ? columns! : Math.ceil(Math.sqrt(count)))))
}

/**
 * Compute a row, column, or grid arrangement around the current selection
 * centre. Each item keeps its original AABB size and rotation.
 */
export function arrangeSelection(
  items: readonly CanvasItem[],
  arrangement: SelectionArrangement,
  options: SelectionArrangeOptions = {},
): SelectionPositionPatch[] {
  const selection = selectionBounds(items)
  if (!selection || items.length < 2) return []
  const bounds = items.map(safeBounds)
  const gap = clampGap(options.gap)
  const centerX = selection.x + selection.w / 2
  const centerY = selection.y + selection.h / 2

  if (arrangement === 'row') {
    const totalWidth = bounds.reduce((sum, rect) => sum + rect.w, 0) + gap * (bounds.length - 1)
    let x = centerX - totalWidth / 2
    return items.map((item, index) => {
      const current = bounds[index]!
      const target = { x, y: centerY - current.h / 2 }
      x += current.w + gap
      return patchToAabb(item, current, target)
    })
  }

  if (arrangement === 'column') {
    const totalHeight = bounds.reduce((sum, rect) => sum + rect.h, 0) + gap * (bounds.length - 1)
    let y = centerY - totalHeight / 2
    return items.map((item, index) => {
      const current = bounds[index]!
      const target = { x: centerX - current.w / 2, y }
      y += current.h + gap
      return patchToAabb(item, current, target)
    })
  }

  const columns = clampColumns(options.columns, items.length)
  const rects = layoutMediaGrid(
    bounds.map(({ w, h }) => ({ width: w, height: h })),
    { x: centerX, y: centerY },
    { columns, gap, itemWidth: null },
  )
  return items.map((item, index) => {
    const current = bounds[index]!
    const target = rects[index]!
    return patchToAabb(item, current, target)
  })
}
