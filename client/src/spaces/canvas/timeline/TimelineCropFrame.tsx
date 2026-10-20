import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { clampMove, resizeFromCorner, type Rect } from '../konva/cropMath'
import { beginPointerDrag } from './timelineDrag'
import type { TimelineSession } from './useTimelineSession'

// Рамка кадрирования поверх превью. Живёт в ДОЛЯХ кадра, а не в пикселях
// превью: превью масштабируется под окно и зумом, а доли от этого не меняются —
// и на сервер уходит ровно то, что видно.

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

function pct(value: number): string {
  return `${value * 100}%`
}

function cornerStyle(rect: Rect, corner: Corner): CSSProperties {
  const west = corner === 'nw' || corner === 'sw'
  const north = corner === 'nw' || corner === 'ne'
  return {
    left: pct(west ? rect.x : rect.x + rect.w),
    top: pct(north ? rect.y : rect.y + rect.h),
  }
}

function boxStyle(rect: Rect): CSSProperties {
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }
}

export function TimelineCropFrame({
  session,
  stageRef,
}: {
  session: TimelineSession
  stageRef: RefObject<HTMLDivElement>
}) {
  const crop = session.crop
  // Обработчики перетаскивания живут дольше одного рендера, а session — новый
  // объект на каждый: берём свежий через ref (см. TimelineTrack).
  const sessionRef = useRef(session)
  sessionRef.current = session
  if (!crop) return null

  /** Размер сцены на ЭКРАНЕ (с учётом зума): сдвиг мыши на N пикселей — это
   *  N/(scale·размер) доли кадра, а не N/размер, потому что при приближении
   *  сцена растянута. getBoundingClientRect() как раз включает transform. */
  function screenSize(): { x: number; y: number } | null {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return { x: rect.width, y: rect.height }
  }

  function dragBody(event: ReactPointerEvent): void {
    const scale = screenSize()
    const start = sessionRef.current.crop
    if (!scale || !start) return
    const grabX = event.clientX
    const grabY = event.clientY
    beginPointerDrag(event, (moveEvent) => {
      const moved: Rect = {
        ...start,
        x: start.x + (moveEvent.clientX - grabX) / scale.x,
        y: start.y + (moveEvent.clientY - grabY) / scale.y,
      }
      // clampMove из кропа фотографии: рамка не уезжает за кадр и не меняет
      // размер при переносе — то же поведение, что человек уже видел там.
      sessionRef.current.setCrop(clampMove(moved, { w: 1, h: 1 }))
    }, () => undefined)
  }

  function dragCorner(event: ReactPointerEvent, corner: Corner): void {
    if (!screenSize()) return
    beginPointerDrag(event, (moveEvent) => {
      const current = sessionRef.current.crop
      const screen = stageRef.current?.getBoundingClientRect()
      if (!current || !screen || screen.width === 0 || screen.height === 0) return
      // Считаем в пикселях ЭКРАННОГО кадра, чтобы переиспользовать
      // resizeFromCorner из кропа фотографии, и переводим обратно в доли.
      // Логика одна на оба кропа.
      const bounds = { w: screen.width, h: screen.height }
      const pixels: Rect = {
        x: current.x * bounds.w,
        y: current.y * bounds.h,
        w: current.w * bounds.w,
        h: current.h * bounds.h,
      }
      const next = resizeFromCorner(
        pixels,
        corner,
        { x: moveEvent.clientX - screen.left, y: moveEvent.clientY - screen.top },
        bounds,
        sessionRef.current.cropRatio,
      )
      sessionRef.current.setCrop({
        x: next.x / bounds.w,
        y: next.y / bounds.h,
        w: next.w / bounds.w,
        h: next.h / bounds.h,
      })
    }, () => undefined)
  }

  return (
    <div className="tl-crop">
      {/* Затемнение четырьмя прямоугольниками — так же, как в кропе
          фотографии: одна общая рамка «дырой» не рисуется. */}
      <div className="tl-cdim" style={{ left: 0, right: 0, top: 0, height: pct(crop.y) }} />
      <div className="tl-cdim" style={{ left: 0, right: 0, top: pct(crop.y + crop.h), bottom: 0 }} />
      <div className="tl-cdim" style={{ left: 0, width: pct(crop.x), top: pct(crop.y), height: pct(crop.h) }} />
      <div className="tl-cdim" style={{ left: pct(crop.x + crop.w), right: 0, top: pct(crop.y), height: pct(crop.h) }} />
      <div className="tl-cbox" style={boxStyle(crop)} />
      {/* Саму рамку можно ТАЩИТЬ: кадрируют обычно не «сделать меньше», а
          «сдвинуть на лицо», и без переноса пришлось бы подгонять четырьмя
          углами по очереди. */}
      <div className="tl-cmove" style={boxStyle(crop)} onPointerDown={dragBody} />
      {CORNERS.map((corner) => (
        <div
          key={corner}
          className={`tl-ch ${corner}`}
          style={cornerStyle(crop, corner)}
          onPointerDown={(event) => dragCorner(event, corner)}
        />
      ))}
    </div>
  )
}
