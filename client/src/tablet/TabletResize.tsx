import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { useCameraVersion } from '../spaces/canvas/konva/useStore'
import type { Point } from './boardGestures'
import {
  resizeFromCorner,
  screenPointToWorld,
  worldPointToFrameLocal,
  type ResizeHandle,
  type ResizeRect,
  type ResizeItemShape,
} from './tabletResizeMath'

const HANDLES: ReadonlyArray<ResizeHandle> = ['nw', 'ne', 'sw', 'se']

function itemName(item: CanvasItem | undefined): string {
  if (item?.kind === 'image') return 'image'
  if (item?.kind === 'video') return 'video'
  return 'object'
}

function dragCornerLocal(handle: ResizeHandle, w: number, h: number): { x: number; y: number } {
  switch (handle) {
    case 'ne': return { x: w, y: 0 }
    case 'sw': return { x: 0, y: h }
    case 'nw': return { x: 0, y: 0 }
    default: return { x: w, y: h }
  }
}

interface ActiveDrag {
  pointerId: number
  handle: ResizeHandle
  start: ResizeItemShape
  grabOffset: { x: number; y: number }
}

/**
 * Gesture resize opened after long-press on an image/video.
 *
 * The overlay is positioned in screen coordinates inside the tablet board and
 * shows the actual media preview at the candidate size, without touching the
 * store until release. Handles are circular touch targets and stop propagation
 * so the board never starts a drag underneath. A second pointer, blur, lost
 * capture and pointercancel cancel the gesture and release the real capture
 * target without writing to the document.
 */
export function TabletResize({
  store,
  itemId,
  menuPoint,
  onMenu,
  onClose,
  onCancel,
}: {
  store: CanvasStore
  itemId: string
  menuPoint?: { x: number; y: number }
  onMenu(itemId: string, at: { x: number; y: number }): void
  onClose(): void
  onCancel?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const captureTargetRef = useRef<HTMLElement | null>(null)
  const originalNodeRef = useRef<{ node: HTMLElement; hadVisibility: string } | null>(null)
  const drag = useRef<ActiveDrag | null>(null)
  const [active, setActive] = useState(false)
  const [preview, setPreview] = useState<ResizeRect | null>(null)
  useCameraVersion(store)
  const item = store.getItem(itemId)
  const camera = store.getCamera()

  const boardOf = () => {
    if (hostRef.current?.closest<HTMLElement>('.tablet-board')) return hostRef.current.closest<HTMLElement>('.tablet-board')
    if (hostRef.current?.closest<HTMLElement>('.tablet-board-live')) {
      return hostRef.current.closest<HTMLElement>('.tablet-board-live')?.querySelector<HTMLElement>('.tablet-board') ?? null
    }
    return null
  }

  const worldOf = (event: ReactPointerEvent): { x: number; y: number } => {
    const board = boardOf()
    const rect = board?.getBoundingClientRect()
    return screenPointToWorld(
      { left: rect?.left ?? 0, top: rect?.top ?? 0 },
      camera,
      { x: event.clientX, y: event.clientY },
    )
  }

  const stopAndCapture = (event: ReactPointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    captureTargetRef.current = target
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // capture is optional; the gesture still works without it
    }
  }

  const releaseCapture = () => {
    const target = captureTargetRef.current
    const pointerId = drag.current?.pointerId
    captureTargetRef.current = null
    if (!target || pointerId === undefined) return
    try {
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
      else target.releasePointerCapture?.(pointerId)
    } catch {
      // capture is optional
    }
  }

  const dragNext = (d: ActiveDrag, screen: ReactPointerEvent): ResizeRect => {
    const world = worldOf(screen)
    const local = worldPointToFrameLocal(d.start, world)
    const effective = {
      x: local.x - d.grabOffset.x,
      y: local.y - d.grabOffset.y,
    }
    // The candidate pointer is relative to the fixed corner. Without the grab
    // offset, touching anywhere in the 44px hit target would jump the corner.
    return resizeFromCorner(d.start, d.handle, effective)
  }

  const resetDrag = () => {
    restoreOriginal()
    drag.current = null
    setActive(false)
    setPreview(null)
  }

  const hideOriginal = () => {
    const board = boardOf()
    const node = board?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`) ?? null
    if (node && !originalNodeRef.current) {
      originalNodeRef.current = { node, hadVisibility: node.style.visibility }
      node.style.visibility = 'hidden'
    }
  }

  const restoreOriginal = () => {
    if (!originalNodeRef.current) return
    const saved = originalNodeRef.current
    saved.node.style.visibility = saved.hadVisibility
    originalNodeRef.current = null
  }

  const startDrag = (handle: ResizeHandle) => (event: ReactPointerEvent) => {
    if (drag.current || event.button !== 0) return
    const current = store.getItem(itemId)
    if (!current || !store.canMutateItems([itemId])) return
    stopAndCapture(event)
    hideOriginal()
    const start: ResizeItemShape = { x: current.x, y: current.y, w: current.w, h: current.h, rotation: current.rotation }
    const world = worldOf(event)
    const local = worldPointToFrameLocal(start, world)
    const corner = dragCornerLocal(handle, start.w, start.h)
    drag.current = {
      pointerId: event.pointerId,
      handle,
      start,
      grabOffset: { x: local.x - corner.x, y: local.y - corner.y },
    }
    setActive(true)
    setPreview(dragNext(drag.current, event))
  }

  const onMove = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    event.stopPropagation()
    setPreview(dragNext(d, event))
  }

  const commit = (next: ResizeRect | null) => {
    const current = store.getItem(itemId)
    if (!next || !current) {
      onClose()
      return
    }
    const unchanged = next.x === current.x && next.y === current.y && next.w === current.w && next.h === current.h
    if (unchanged) {
      onClose()
      return
    }
    if (!store.canMutateItems([itemId])) {
      onCancel?.()
      onClose()
      return
    }
    store.updateItem(itemId, { x: next.x, y: next.y, w: next.w, h: next.h })
    onClose()
  }

  const finishDrag = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    event.stopPropagation()
    const next = dragNext(d, event)
    releaseCapture()
    resetDrag()
    commit(next)
  }

  const cancelDrag = () => {
    const wasActive = active
    releaseCapture()
    resetDrag()
    if (wasActive) onCancel?.()
  }

  useEffect(() => () => {
    const id = drag.current?.pointerId
    const target = captureTargetRef.current
    drag.current = null
    captureTargetRef.current = null
    if (target && id !== undefined) try { target.releasePointerCapture(id) } catch { /* already released */ }
    const saved = originalNodeRef.current
    if (saved) saved.node.style.visibility = saved.hadVisibility
    originalNodeRef.current = null
  }, [itemId])

  const onPointerCancel = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    event.stopPropagation()
    cancelDrag()
  }

  const onLostCapture = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    event.stopPropagation()
    captureTargetRef.current = null
    cancelDrag()
  }

  // Second pointer, window blur and hidden tabs cancel the active gesture
  // immediately without any partial write. We do not prevent the second
  // pointer's default so native keyboard/system gestures are not blocked.
  useEffect(() => {
    if (!active) return
    const onWindowPointerDown = (event: PointerEvent) => {
      if (drag.current && event.pointerId !== drag.current.pointerId) {
        cancelDrag()
      }
    }
    const onBlur = () => cancelDrag()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancelDrag()
    }
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  if (!item) return null
  const display = preview ?? { x: item.x, y: item.y, w: item.w, h: item.h }
  const sx = display.x * camera.scale + camera.x
  const sy = display.y * camera.scale + camera.y
  const sw = display.w * camera.scale
  const sh = display.h * camera.scale

  return (
    <div
      ref={hostRef}
      className="tablet-resize-overlay"
      style={{
        left: sx,
        top: sy,
        width: sw,
        height: sh,
        transform: `rotate(${item.rotation ?? 0}deg)`,
      }}
      role="group"
      aria-label={`Size: ${itemName(item)}`}
    >
      {active && <div className="tablet-resize-preview" aria-hidden="true">
        {item.kind === 'video'
          ? <video src={item.src} muted playsInline disablePictureInPicture preload="metadata" />
          : <img src={item.src} alt="" />}
      </div>}
      <span className="tablet-resize-frame" aria-hidden="true" />
      <button
        type="button"
        className="tablet-resize-menu"
        aria-label="More actions"
        title="More actions"
        onClick={() => onMenu(itemId, menuPoint ?? { x: display.x, y: display.y })}
      >⋯</button>
      {HANDLES.map((handle) => (
        <span
          key={handle}
          className={`tablet-resize-handle ${handle}`}
          role="button"
          tabIndex={0}
          aria-label={`Resize for ${handle}`}
          onPointerDown={startDrag(handle)}
          onPointerMove={onMove}
          onPointerUp={finishDrag}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostCapture}
        />
      ))}
    </div>
  )
}

