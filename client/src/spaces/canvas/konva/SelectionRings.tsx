import Konva from 'konva'
import type { RefObject } from 'react'
import { Shape } from 'react-konva'
import { SELECTION_COLOR, SELECTION_RING_PX, selectionRing, type SelectionFrame } from './selectionRing'

/** Что объект сказал о себе; у незнакомого узла — его собственные границы без скругления. */
function frameOf(node: Konva.Node): SelectionFrame {
  const frame = node.getAttr('selectionFrame') as SelectionFrame | undefined
  if (frame && Number.isFinite(frame.w) && Number.isFinite(frame.h)) return frame
  const rect = node.getClientRect({ skipTransform: true, skipShadow: true, skipStroke: true })
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, radius: 0 }
}

/**
 * Кольца выделения (см. selectionRing.ts) — одна фигура в слое трансформера,
 * поверх всех объектов.
 *
 * ⚠️ Кольцо рисуется по ЖИВОМУ положению узла, взятому в момент отрисовки, а
 * не по стору: при переносе и растягивании стор молчит до отпускания, а узел
 * уже едет. Трансформер подписан на движение своих узлов и на каждое
 * перерисовывает свой слой — кольца едут вместе с ним без отдельной подписки.
 */
export function SelectionRings({ transformer }: { transformer: RefObject<Konva.Transformer | null> }) {
  return (
    <Shape
      stroke={SELECTION_COLOR}
      strokeWidth={SELECTION_RING_PX}
      strokeScaleEnabled={false}
      perfectDrawEnabled={false}
      listening={false}
      sceneFunc={(context, shape) => {
        const nodes = transformer.current?.nodes() ?? []
        if (nodes.length === 0) return
        const toShape = shape.getAbsoluteTransform().copy().invert()
        context.beginPath()
        for (const node of nodes) {
          const absolute = node.getAbsoluteTransform()
          const [a, b] = absolute.getMatrix()
          const ring = selectionRing(frameOf(node), Math.hypot(a, b))
          if (!ring) continue
          const m = toShape.copy().multiply(absolute).getMatrix()
          context.save()
          context.transform(m[0], m[1], m[2], m[3], m[4], m[5])
          context.translate(ring.x, ring.y)
          Konva.Util.drawRoundedRectPath(context, ring.w, ring.h, ring.radius)
          context.closePath()
          context.restore()
        }
        context.strokeShape(shape)
      }}
    />
  )
}
