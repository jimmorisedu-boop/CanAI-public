import { useCallback, useEffect, useRef, useState } from 'react'

// Зум колесом и панорама левой кнопкой. Общий для сравнения и таймлайна —
// приём из видео-просмотрщика пользователя (Lmd_sku): ОДИН transform
// применяется ко всем слоям сразу, поэтому слои не надо синхронизировать
// между собой — они синхронны по построению. В сравнении так держатся
// панели, в таймлайне — кадр вместе с рамкой кадрирования.

export type ZoomState = { scale: number; x: number; y: number }

const MIN_SCALE = 1
// потолок высокий: «100%» у крупного оригинала в маленькой рамке — это
// легко 10× и больше, а обрезать натуральный размер нельзя
const MAX_SCALE = 24
const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 }

export function zoomTransform({ scale, x, y }: ZoomState): string {
  return scale <= 1.001 ? 'none' : `translate(${x}px, ${y}px) scale(${scale})`
}

/**
 * Новое состояние при зуме К ТОЧКЕ: точка под курсором остаётся на месте.
 *
 * `point` — позиция курсора в координатах рамки (от её левого верхнего угла),
 * `frame` — размер рамки. Содержимое стоит по центру рамки, а transform-origin
 * по умолчанию тоже центр, поэтому центр рамки — единственная неподвижная
 * точка масштаба, и от неё считается смещение. Чистая функция: её проверяет
 * useSharedZoom.test.ts, не поднимая DOM.
 */
export function pointZoom(
  prev: ZoomState,
  nextScale: number,
  point: { x: number; y: number },
  frame: { width: number; height: number },
): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
  if (scale <= 1.001) return { ...IDENTITY }
  const cx = frame.width / 2
  const cy = frame.height / 2
  // где эта точка лежит в невзумленных координатах рамки
  const fitX = cx + (point.x - cx - prev.x) / prev.scale
  const fitY = cy + (point.y - cy - prev.y) / prev.scale
  return {
    scale,
    x: point.x - cx - (fitX - cx) * scale,
    y: point.y - cy - (fitY - cy) * scale,
  }
}

// containerRef — стабильная обёртка, на которую вешается колесо. Через
// React-проп onWheel это не работает: React слушает wheel ПАССИВНО, и
// preventDefault внутри молча отваливается (в консоли «Unable to
// preventDefault inside passive event listener»), а страница под оверлеем
// продолжает прокручиваться. Поэтому — нативный слушатель с passive: false.
export function useSharedZoom(
  containerRef: React.RefObject<HTMLElement>,
  options?: {
    /** Вернуть предел пана при данном масштабе, или null — не ограничивать.
     *  Таймлайн передаёт clampPan (кадр не должен уезжать за край); сравнение
     *  не передаёт — поведение прежнее. */
    bounds?: (scale: number) => { x: number; y: number } | null
    /** Колесо приближает К КУРСОРУ, а не к центру рамки. Таймлайн включает —
     *  у приближённого кадра смотрят туда, куда навели; сравнение не
     *  включает: у него колесо крутит общий центр обеих панелей. */
    zoomToCursor?: boolean
  },
) {
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY)
  // зеркало состояния: pointerdown должен прочитать текущий зум СИНХРОННО.
  // Через setZoom(prev => …) это не работает — обновитель React выполняется
  // уже после обработчика, и первый pointermove не находил начатый drag.
  const zoomRef = useRef<ZoomState>(IDENTITY)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: ZoomState } | null>(null)

  const apply = useCallback((next: ZoomState) => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale))
    let x = next.x
    let y = next.y
    const bounds = options?.bounds?.(scale)
    if (bounds) {
      if (!(scale > 1.001)) { x = 0; y = 0 }
      else {
        x = Math.max(-bounds.x, Math.min(bounds.x, x))
        y = Math.max(-bounds.y, Math.min(bounds.y, y))
      }
    }
    const clamped: ZoomState = scale > 1.001 ? { scale, x, y } : { scale, x: 0, y: 0 }
    zoomRef.current = clamped
    setZoom(clamped)
  }, [options])

  const reset = useCallback(() => apply(IDENTITY), [apply])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const prev = zoomRef.current
      // Нормализуем дельту: deltaMode page/line переводим в сопоставимый сдвиг,
      // чтобы страница прокрутки не уводила зум в один прыжок.
      let delta = event.deltaY
      if (event.deltaMode === 1) delta *= 16
      else if (event.deltaMode === 2) delta *= 60
      const factor = delta < 0 ? 1.15 : 1 / 1.15
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
      // вышли на единицу — возвращаем кадр в центр, иначе он останется уехавшим
      if (scale <= 1.001) {
        apply(IDENTITY)
        return
      }
      if (options?.zoomToCursor) {
        const rect = el.getBoundingClientRect()
        apply(pointZoom(
          prev,
          scale,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          { width: rect.width, height: rect.height },
        ))
        return
      }
      const ratio = scale / prev.scale
      apply({ scale, x: prev.x * ratio, y: prev.y * ratio })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerRef, apply, options])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    const prev = zoomRef.current
    if (prev.scale <= 1.001) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: prev,
    }
  }, [])

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      apply({
        scale: drag.origin.scale,
        x: drag.origin.x + (event.clientX - drag.startX),
        y: drag.origin.y + (event.clientY - drag.startY),
      })
    },
    [apply],
  )

  const endDrag = useCallback((event: React.PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }, [])

  // Зум к точке: точка под курсором остаётся на месте. Нужен двойному клику —
  // он приближает до 100% именно туда, куда ткнули, а не в центр кадра.
  const zoomToPoint = useCallback(
    (nextScale: number, point: { x: number; y: number }, frame: { width: number; height: number }) => {
      apply(pointZoom(zoomRef.current, nextScale, point, frame))
    },
    [apply],
  )

  return {
    zoom,
    zoomed: zoom.scale > 1.001,
    reset,
    zoomToPoint,
    surfaceProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  }
}
