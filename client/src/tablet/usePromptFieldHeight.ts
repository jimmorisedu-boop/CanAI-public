import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type RefObject } from 'react'
import { promptFieldHeightFromDrag } from './visualViewportModel'

/** Ручка растит область вверх; нижний край dock остаётся на месте. */
export function usePromptFieldHeight(field: RefObject<HTMLElement>, maxHeight: number, expand: () => void, minHeight = 44) {
  const [height, setHeight] = useState<number | null>(null)
  const drag = useRef<{ id: number; y: number; height: number; scale: number; target: HTMLButtonElement } | null>(null)
  const cancel = () => {
    const start = drag.current
    drag.current = null
    if (start) try { start.target.releasePointerCapture(start.id) } catch { /* already released */ }
  }
  useEffect(() => {
    window.addEventListener('canai-tablet-ui-scale', cancel)
    window.addEventListener('blur', cancel)
    return () => { cancel(); window.removeEventListener('canai-tablet-ui-scale', cancel); window.removeEventListener('blur', cancel) }
  }, [])
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current
    if (!start || start.id !== event.pointerId) return
    setHeight(Math.max(minHeight, promptFieldHeightFromDrag(start.height, event.clientY - start.y, start.scale, maxHeight)))
  }
  return {
    height,
    handle: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        const fieldNode = field.current
        if (event.button !== 0 || !event.isPrimary || !fieldNode) return
        event.preventDefault()
        const scale = Number(getComputedStyle(fieldNode).getPropertyValue('--tablet-panel-scale')) || 1
        const initial = fieldNode.getBoundingClientRect().height / scale
        drag.current = { id: event.pointerId, y: event.clientY, height: initial, scale, target: event.currentTarget }
        setHeight(initial)
        expand()
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer capture unavailable */ }
      },
      onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
        if (drag.current?.id !== event.pointerId) return
        move(event)
        cancel()
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        expand()
        const current = height ?? field.current?.offsetHeight ?? 44
        setHeight(event.key === 'Home' ? minHeight : event.key === 'End' ? maxHeight : Math.max(minHeight, promptFieldHeightFromDrag(current, event.key === 'ArrowUp' ? -32 : 32, 1, maxHeight)))
      },
    },
  }
}
