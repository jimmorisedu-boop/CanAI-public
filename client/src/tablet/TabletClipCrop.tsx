import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { clampMove, resizeFromCorner, type Rect } from '../spaces/canvas/konva/cropMath'
import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import {
  applyCropGesture,
  type ClipSize,
  type CropCorner,
  type CropGesture,
  type NormalizedPoint,
  normalizedPoint,
} from './clipPreviewGeometry'
import { useT } from '../i18n/context.js'


const CORNERS: CropCorner[] = ['nw', 'ne', 'sw', 'se']

function percent(value: number): string {
  return `${Math.min(1, Math.max(0, value)) * 100}%`
}

function cornerPoint(rect: Rect, corner: CropCorner): NormalizedPoint {
  return {
    x: corner === 'ne' || corner === 'se' ? rect.x + rect.w : rect.x,
    y: corner === 'sw' || corner === 'se' ? rect.y + rect.h : rect.y,
  }
}

function cornerLabel(corner: CropCorner): string {
  return corner === 'nw'
    ? 'Resize top left'
    : corner === 'ne'
      ? 'Resize top right'
      : corner === 'sw'
        ? 'Resize bottom left'
        : 'Resize bottom right'
}

function framePoint(event: ReactPointerEvent, frame: HTMLElement | null): NormalizedPoint | null {
  const rect = frame?.getBoundingClientRect()
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null
  return normalizedPoint(event.clientX, event.clientY, rect)
}

function normalizedFromPixels(rect: Rect, source: ClipSize): Rect {
  return {
    x: rect.x / source.width,
    y: rect.y / source.height,
    w: rect.w / source.width,
    h: rect.h / source.height,
  }
}

function ratioOrFree(value: number | null): number | null {
  return value && Number.isFinite(value) && value > 0 ? value : null
}

export function TabletClipCrop({
  session,
  frameRef,
  sourceSize,
}: {
  session: TimelineSession
  frameRef: RefObject<HTMLDivElement | null>
  sourceSize: ClipSize
}) {
  const t = useT()
  const sessionRef = useRef(session)
  sessionRef.current = session
  const sourceRef = useRef(sourceSize)
  sourceRef.current = sourceSize
  const dragRef = useRef<CropGesture & { target: HTMLElement } | null>(null)
  const locked = session.busy || session.loading
  const crop = session.crop
  if (!crop) return null

  const pointerPoint = (event: ReactPointerEvent): NormalizedPoint | null => framePoint(event, frameRef.current)

  const startDrag = (mode: CropGesture['mode']) => (event: ReactPointerEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    if (locked || event.button !== 0 || dragRef.current || !sessionRef.current.crop) return
    const from = pointerPoint(event)
    if (!from) return
    const target = event.currentTarget as HTMLElement
    try { target.setPointerCapture(event.pointerId) } catch { /* capture is a convenience */ }
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      from,
      start: sessionRef.current.crop,
      target,
    }
  }

  const applyPointer = (event: ReactPointerEvent): void => {
    const drag = dragRef.current
    const point = drag ? pointerPoint(event) : null
    if (!drag || !point) return
    const next = applyCropGesture(
      drag,
      event.pointerId,
      point,
      sourceRef.current,
      ratioOrFree(sessionRef.current.cropRatio),
      sessionRef.current.busy || sessionRef.current.loading,
    )
    if (next) sessionRef.current.setCrop(next)
  }

  const endDrag = (event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.type === 'pointerup') applyPointer(event)
    dragRef.current = null
    try { drag.target.releasePointerCapture(drag.pointerId) } catch { /* already released */ }
  }

  const resizeByKey = (corner: CropCorner, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const delta = event.shiftKey ? 0.05 : 0.01
    const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
    const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
    if (dx === 0 && dy === 0) return
    event.preventDefault()
    event.stopPropagation()
    const currentSession = sessionRef.current
    const current = currentSession.crop
    if (!current || currentSession.busy || currentSession.loading) return
    const source = sourceRef.current
    const point = cornerPoint(current, corner)
    const pixels: Rect = {
      x: current.x * source.width,
      y: current.y * source.height,
      w: current.w * source.width,
      h: current.h * source.height,
    }
    const pointer = { x: (point.x + dx) * source.width, y: (point.y + dy) * source.height }
    const next = resizeFromCorner(
      pixels,
      corner,
      pointer,
      { w: source.width, h: source.height },
      ratioOrFree(currentSession.cropRatio),
    )
    currentSession.setCrop(normalizedFromPixels(next, source))
  }

  const moveByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = event.shiftKey ? 0.05 : 0.01
    const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
    const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
    if (dx === 0 && dy === 0) return
    event.preventDefault()
    event.stopPropagation()
    const currentSession = sessionRef.current
    const current = currentSession.crop
    if (!current || currentSession.busy || currentSession.loading) return
    currentSession.setCrop(clampMove({ ...current, x: current.x + dx, y: current.y + dy }, { w: 1, h: 1 }))
  }

  const cropBox = { left: percent(crop.x), top: percent(crop.y), width: percent(crop.w), height: percent(crop.h) }
  const stopCropPointer = (event: ReactPointerEvent<HTMLDivElement>): void => event.stopPropagation()

  return (
    <div
      className="tablet-clip-preview-crop"
      aria-label={t('Crop frame')}
      onPointerMove={(event) => { event.stopPropagation(); applyPointer(event) }}
      onPointerUp={(event) => { event.stopPropagation(); endDrag(event) }}
      onPointerCancel={(event) => { event.stopPropagation(); endDrag(event) }}
      onLostPointerCapture={(event) => { event.stopPropagation(); endDrag(event) }}
      onPointerDown={stopCropPointer}
    >
      <div className="tablet-clip-preview-shade top" style={{ top: 0, left: 0, right: 0, height: cropBox.top }} aria-hidden="true" />
      <div className="tablet-clip-preview-shade bottom" style={{ top: `calc(${cropBox.top} + ${cropBox.height})`, left: 0, right: 0, bottom: 0 }} aria-hidden="true" />
      <div className="tablet-clip-preview-shade left" style={{ top: cropBox.top, left: 0, width: cropBox.left, height: cropBox.height }} aria-hidden="true" />
      <div className="tablet-clip-preview-shade right" style={{ top: cropBox.top, left: `calc(${cropBox.left} + ${cropBox.width})`, right: 0, height: cropBox.height }} aria-hidden="true" />
      <div
        className="tablet-clip-preview-crop-window"
        style={cropBox}
        role="group"
        tabIndex={0}
        aria-label={t('Move crop frame with arrow keys')}
        onPointerDown={startDrag('move')}
        onKeyDown={moveByKey}
      >
        <span className="tablet-clip-preview-grid" aria-hidden="true" />
        {CORNERS.map((corner) => (
          <button
            key={corner}
            type="button"
            className={`tablet-clip-preview-handle ${corner}`}
            aria-label={cornerLabel(corner)}
            title={cornerLabel(corner)}
            disabled={locked}
            onPointerDown={startDrag(corner)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => resizeByKey(corner, event)}
          />
        ))}
      </div>
    </div>
  )
}
