import type { MediaLinkEntry } from '../mediaImportTypes'
import { rectIntersects } from './canvasLayout'

export const LINK_IMPORT_WIDTH = 320
export const LINK_IMPORT_GAP = 24
const MAX_COLUMNS = 4

export interface ImportSlot {
  id: string
  kind: MediaLinkEntry['kind']
  x: number
  y: number
  w: number
  h: number
  column: number
  row: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function clampedAspect(value: number): number {
  return Math.min(5, Math.max(0.2, Number.isFinite(value) ? value : 1))
}

export function layoutLinkImport(
  anchor: Rect,
  entries: MediaLinkEntry[],
  occupied: Rect[],
): ImportSlot[] {
  if (entries.length === 0) return []
  const columns = Math.min(MAX_COLUMNS, entries.length)
  const sized = entries.map((entry, index) => ({
    entry,
    index,
    column: index % columns,
    row: Math.floor(index / columns),
    w: LINK_IMPORT_WIDTH,
    h: LINK_IMPORT_WIDTH / clampedAspect(entry.aspectRatio),
  }))
  const rows = Math.ceil(entries.length / columns)
  const rowHeights = Array.from({ length: rows }, (_, row) => (
    Math.max(...sized.filter((item) => item.row === row).map((item) => item.h))
  ))
  const rowY: number[] = []
  let y = anchor.y
  for (const height of rowHeights) {
    rowY.push(y)
    y += height + LINK_IMPORT_GAP
  }

  let startX = anchor.x + anchor.w + LINK_IMPORT_GAP
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = sized.map((item) => ({
      id: item.entry.id,
      kind: item.entry.kind,
      x: startX + item.column * (LINK_IMPORT_WIDTH + LINK_IMPORT_GAP),
      y: rowY[item.row],
      w: item.w,
      h: item.h,
      column: item.column,
      row: item.row,
    }))
    const collisions = occupied.filter((rect) => candidate.some((slot) => rectIntersects(slot, rect)))
    if (collisions.length === 0) return candidate
    startX = Math.max(...collisions.map((rect) => rect.x + rect.w)) + LINK_IMPORT_GAP
  }

  return sized.map((item) => ({
    id: item.entry.id,
    kind: item.entry.kind,
    x: startX + item.column * (LINK_IMPORT_WIDTH + LINK_IMPORT_GAP),
    y: rowY[item.row],
    w: item.w,
    h: item.h,
    column: item.column,
    row: item.row,
  }))
}
