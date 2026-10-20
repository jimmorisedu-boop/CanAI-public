import { useEffect, useState, type RefObject } from 'react'

const CORNER_DOCK_GAP = 16

export type CanvasCornerRect = Pick<DOMRect, 'top' | 'bottom'>
type HorizontalRect = Pick<DOMRect, 'left' | 'right'>

/** Keep the corner beside the dock whenever its full column fits there. */
export function canvasCornerDockIntersects(column: HorizontalRect, dock: HorizontalRect, gap = CORNER_DOCK_GAP): boolean {
  if (![column.left, column.right, dock.left, dock.right, gap].every(Number.isFinite)) return false
  return column.left < dock.right + Math.max(0, gap) && column.right + Math.max(0, gap) > dock.left
}

/**
 * Convert the real prompt-dock edge into the space the narrow corner must
 * leave below itself.  The corner is positioned inside the canvas wrapper,
 * while both rectangles are in viewport coordinates, so their difference is
 * independent of zoom and of the wrapper's offset on the page.
 */
export function canvasCornerDockReserve(
  canvas: CanvasCornerRect,
  dock: Pick<DOMRect, 'top'>,
  gap = CORNER_DOCK_GAP,
): number {
  if (![canvas.top, canvas.bottom, dock.top, gap].every(Number.isFinite)) return 0
  return Math.max(0, Math.ceil(canvas.bottom - dock.top + Math.max(0, gap)))
}

/**
 * Measure the sibling prompt dock without guessing its mode or height.
 * ResizeObserver catches collapsed, chat and agents presentations; the small
 * MutationObserver only discovers the dock when the board shell mounts or
 * replaces it.  There is deliberately no animation-frame polling here.
 */
export function useCanvasCornerDockReserve(
  canvasRef: RefObject<HTMLElement | null>,
  narrow: boolean,
  columnSelector?: string,
): number {
  const [reserve, setReserve] = useState(0)

  useEffect(() => {
    if (!narrow) {
      setReserve(0)
      return
    }

    const canvas = canvasRef.current
    const canvasMain = canvas?.closest<HTMLElement>('.canvas-main')
    if (!canvas || !canvasMain) {
      setReserve(0)
      return
    }

    let dock: HTMLElement | null = null
    let column: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null

    const update = () => {
      const nextDock = canvasMain.querySelector<HTMLElement>('.prompt-dock')
      if (nextDock !== dock) {
        if (resizeObserver && dock) resizeObserver.unobserve(dock)
        dock = nextDock
        if (resizeObserver && dock) resizeObserver.observe(dock)
      }
      const nextColumn = columnSelector ? canvas.querySelector<HTMLElement>(columnSelector) : null
      if (nextColumn !== column) {
        if (resizeObserver && column) resizeObserver.unobserve(column)
        column = nextColumn
        if (resizeObserver && column) resizeObserver.observe(column)
      }
      if (!dock) {
        setReserve((current) => current === 0 ? current : 0)
        return
      }

      const canvasRect = canvas.getBoundingClientRect()
      const dockRect = dock.getBoundingClientRect()
      if (dockRect.width <= 0 || dockRect.height <= 0) {
        setReserve((current) => current === 0 ? current : 0)
        return
      }
      const intersects = !columnSelector || (column && canvasCornerDockIntersects(column.getBoundingClientRect(), dockRect))
      const next = intersects ? canvasCornerDockReserve(canvasRect, dockRect) : 0
      setReserve((current) => current === next ? current : next)
    }

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(update)
      resizeObserver.observe(canvas)
      if (dock) resizeObserver.observe(dock)
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(update)
      mutationObserver.observe(canvasMain, { childList: true, subtree: true })
    }
    update()

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [canvasRef, narrow, columnSelector])

  return reserve
}
