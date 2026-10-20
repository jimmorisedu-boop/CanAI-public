import Konva from 'konva'
import { Circle, Group, Line, Rect as KRect } from 'react-konva'
import { clampMove, resizeFromCorner, resizeFromEdge, type Rect } from './cropMath'
import type { CanvasItem } from './types'

const SHADE = 'rgba(26, 26, 31, 0.55)'
const M = 100000 // затемнение накрывает весь видимый мир

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Edge = 'n' | 's' | 'w' | 'e'

// Konva-часть режима кропа: рисуется в системе координат картинки (Group с её
// поворотом), поэтому окно всегда выровнено по самой картинке.
export function CropOverlay({
  item,
  rect,
  ratio,
  scale,
  onRect,
}: {
  item: CanvasItem
  rect: Rect
  ratio: number | null
  scale: number // масштаб камеры — чтобы ручки были постоянного экранного размера
  onRect: (r: Rect) => void
}) {
  const bounds = { w: item.w, h: item.h }
  const handleR = 7 / scale
  const strokeW = 2 / scale

  function cornerPos(c: Corner): { x: number; y: number } {
    return {
      x: c === 'nw' || c === 'sw' ? rect.x : rect.x + rect.w,
      y: c === 'nw' || c === 'ne' ? rect.y : rect.y + rect.h,
    }
  }
  function edgePos(e: Edge): { x: number; y: number } {
    if (e === 'n') return { x: rect.x + rect.w / 2, y: rect.y }
    if (e === 's') return { x: rect.x + rect.w / 2, y: rect.y + rect.h }
    if (e === 'w') return { x: rect.x, y: rect.y + rect.h / 2 }
    return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }

  function onCornerDrag(c: Corner, e: Konva.KonvaEventObject<DragEvent>): void {
    const p = { x: e.target.x(), y: e.target.y() }
    const next = resizeFromCorner(rect, c, p, bounds, ratio)
    onRect(next)
    const snap = cornerPos(c) // после onRect rect ещё старый — ставим по next
    void snap
    const np = {
      x: c === 'nw' || c === 'sw' ? next.x : next.x + next.w,
      y: c === 'nw' || c === 'ne' ? next.y : next.y + next.h,
    }
    e.target.position(np)
  }

  function onEdgeDrag(edge: Edge, e: Konva.KonvaEventObject<DragEvent>): void {
    const p = { x: e.target.x(), y: e.target.y() }
    const next = resizeFromEdge(rect, edge, p, bounds)
    onRect(next)
    const np =
      edge === 'n'
        ? { x: next.x + next.w / 2, y: next.y }
        : edge === 's'
          ? { x: next.x + next.w / 2, y: next.y + next.h }
          : edge === 'w'
            ? { x: next.x, y: next.y + next.h / 2 }
            : { x: next.x + next.w, y: next.y + next.h / 2 }
    e.target.position(np)
  }

  const thirdW = rect.w / 3
  const thirdH = rect.h / 3

  return (
    <Group x={item.x} y={item.y} rotation={item.rotation ?? 0}>
      {/* затемнение вокруг окна */}
      <KRect x={-M} y={-M} width={2 * M} height={M + rect.y} fill={SHADE} listening={false} />
      <KRect x={-M} y={rect.y + rect.h} width={2 * M} height={M} fill={SHADE} listening={false} />
      <KRect x={-M} y={rect.y} width={M + rect.x} height={rect.h} fill={SHADE} listening={false} />
      <KRect x={rect.x + rect.w} y={rect.y} width={M} height={rect.h} fill={SHADE} listening={false} />

      {/* тело окна — перетаскивание */}
      <KRect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="rgba(0,0,0,0.01)"
        draggable
        onDragMove={(e) => {
          const next = clampMove({ ...rect, x: e.target.x(), y: e.target.y() }, bounds)
          onRect(next)
          e.target.position({ x: next.x, y: next.y })
        }}
        onMouseEnter={(e) => {
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = 'move'
        }}
        onMouseLeave={(e) => {
          const stage = e.target.getStage()
          if (stage) stage.container().style.cursor = 'default'
        }}
      />

      {/* сетка третей */}
      {[1, 2].map((i) => (
        <Line
          key={`v${i}`}
          points={[rect.x + thirdW * i, rect.y, rect.x + thirdW * i, rect.y + rect.h]}
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={1 / scale}
          listening={false}
        />
      ))}
      {[1, 2].map((i) => (
        <Line
          key={`h${i}`}
          points={[rect.x, rect.y + thirdH * i, rect.x + rect.w, rect.y + thirdH * i]}
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={1 / scale}
          listening={false}
        />
      ))}

      {/* рамка */}
      <KRect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        stroke="#ffffff"
        strokeWidth={strokeW}
        listening={false}
      />

      {/* угловые ручки */}
      {(['nw', 'ne', 'sw', 'se'] as const).map((c) => {
        const p = cornerPos(c)
        return (
          <Circle
            key={c}
            x={p.x}
            y={p.y}
            radius={handleR}
            fill="#ffffff"
            stroke="#d33f21"
            strokeWidth={strokeW}
            draggable
            onDragMove={(e) => onCornerDrag(c, e)}
          />
        )
      })}

      {/* кромки — только в свободном режиме */}
      {!ratio &&
        (['n', 's', 'w', 'e'] as const).map((edge) => {
          const p = edgePos(edge)
          return (
            <Circle
              key={edge}
              x={p.x}
              y={p.y}
              radius={handleR * 0.8}
              fill="#ffffff"
              stroke="#d33f21"
              strokeWidth={strokeW}
              draggable
              onDragMove={(e) => onEdgeDrag(edge, e)}
            />
          )
        })}
    </Group>
  )
}
