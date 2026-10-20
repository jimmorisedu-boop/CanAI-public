import { useLayoutEffect, useRef } from 'react'
import type { CanvasStore } from './canvasStore'
const subscribeAnnotationCamera = (_listener: (camera: { x: number; y: number; scale: number }) => void): (() => void) => () => {}
import { dragOffsetFor, getCanvasDrag, subscribeCanvasDrag } from './itemDragBus'
import { useCanvasCornerDockReserve } from './useCanvasCornerDockReserve'
import type { Bounds } from './geometry'

export interface CanvasAnchorPoint {
  /** Мировые координаты точки, над которой стоит панель. */
  x: number
  y: number
  /** Сдвиг в ЭКРАННЫХ пикселях: панель висит над объектом, а не на нём. */
  screenOffsetY: number
  /** Реальные рамки объектов: пустое место между ними не считается видимым выделением. */
  bounds: readonly Bounds[]
}

/**
 * Держать HTML-панель над объектом холста.
 *
 * ⚠️ Позиция считается ЗДЕСЬ, а не пропсом из React-рендера. Причин две, и обе
 * дают одно и то же — «панель едет с задержкой» (жалобы 07.09.2026):
 *
 *  • при панораме и зуме Konva двигает сцену каждый кадр, а в стор камера
 *    попадает раз в 50 мс (`updateCameraThrottled`) — панель отставала от
 *    холста ровно на этот интервал;
 *  • при переносе объекта стор вообще молчит до отпускания: двигается только
 *    нода, иначе каждый кадр жеста стал бы шагом отмены.
 *
 * Поэтому камера берётся из синхронной шины (`annotationCameraBus`, куда её
 * пишет KonvaCanvas на каждый кадр жеста), смещение переноса — из своей
 * (`itemDragBus`), а результат кладётся прямо в стиль. Тот же приём, что у
 * меток обсуждения.
 */
/** Где панель окажется на экране: чистая арифметика, её и проверяет тест. */
export function anchorScreenPosition(
  camera: { x: number; y: number; scale: number },
  point: Pick<CanvasAnchorPoint, 'x' | 'y' | 'screenOffsetY'>,
  drag: { dx: number; dy: number } = { dx: 0, dy: 0 },
): { left: number; top: number } {
  return {
    left: camera.x + (point.x + drag.dx) * camera.scale,
    top: camera.y + (point.y + drag.dy) * camera.scale + point.screenOffsetY,
  }
}

/** left — середина панели (translateX(-50%)), top — её верхний край. */
export function clampAnchorToViewport(
  position: { left: number; top: number },
  viewport: { w: number; h: number },
  panel: { w: number; h: number },
): { left: number; top: number } {
  if (viewport.w <= 0 || viewport.h <= 0) return position
  const gapX = Math.min(8, Math.max(0, (viewport.w - panel.w) / 2))
  const gapY = Math.min(8, Math.max(0, (viewport.h - panel.h) / 2))
  return {
    left: panel.w > viewport.w ? viewport.w / 2
      : Math.max(gapX + panel.w / 2, Math.min(viewport.w - gapX - panel.w / 2, position.left)),
    top: Math.max(gapY, Math.min(Math.max(0, viewport.h - gapY - panel.h), position.top)),
  }
}

/** Панель принадлежит видимым объектам, а не точке, зажатой у края экрана. */
export function placeCanvasToolbar(
  camera: { x: number; y: number; scale: number },
  point: CanvasAnchorPoint,
  viewport: { w: number; h: number },
  panel: { w: number; h: number },
  drag: { dx: number; dy: number } = { dx: 0, dy: 0 },
  bottomReserve = 0,
): { left: number; top: number } | null {
  if (viewport.w <= 0 || viewport.h <= 0 || camera.scale <= 0) return null
  const visible = point.bounds.flatMap((box) => {
    const x = camera.x + (box.x + drag.dx) * camera.scale
    const y = camera.y + (box.y + drag.dy) * camera.scale
    const right = x + box.w * camera.scale
    const bottom = y + box.h * camera.scale
    const clipped = {
      left: Math.max(0, x), right: Math.min(viewport.w, right),
      top: Math.max(0, y), bottom: Math.min(viewport.h, bottom),
    }
    return clipped.right > clipped.left && clipped.bottom > clipped.top
      ? [{ ...clipped, objectTop: y, objectBottom: bottom }]
      : []
  })
  if (visible.length === 0) return null

  const available = {
    w: viewport.w,
    h: Math.min(viewport.h, Math.max(panel.h + 16, viewport.h - bottomReserve)),
  }
  const left = (Math.min(...visible.map((box) => box.left)) + Math.max(...visible.map((box) => box.right))) / 2
  const gap = Math.max(8, -point.screenOffsetY - panel.h)
  const above = Math.min(...visible.map((box) => box.objectTop)) - panel.h - gap
  const below = Math.max(...visible.map((box) => box.objectBottom)) + gap
  // Сначала над объектом, затем под его видимым нижним краем. Только большой
  // объект, занявший весь экран, получает панель внутри своей видимой части.
  const fits = (top: number) => top >= 8 && top + panel.h <= available.h - 8
  const top = fits(above) ? above : fits(below) ? below
    : Math.min(...visible.map((box) => box.top)) + gap
  return clampAnchorToViewport({ left, top }, available, panel)
}

export function useCanvasAnchor<T extends HTMLElement>(
  store: CanvasStore,
  ids: readonly string[],
  anchor: CanvasAnchorPoint,
  /** Панель «прибита»: пока курсор на ней, за выделением она не бегает. */
  frozen = false,
): React.RefObject<T> {
  const ref = useRef<T>(null)
  const viewportRef = useRef<HTMLElement | null>(null)
  // Нижний док бывает разной высоты: кнопки не должны прятаться за ним.
  const bottomReserve = useCanvasCornerDockReserve(viewportRef, true)
  const state = useRef({ ids, anchor, frozen, bottomReserve })
  state.current = { ids, anchor, frozen, bottomReserve }
  const applyRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    const viewport = element?.parentElement
    if (!element || !viewport) return
    viewportRef.current = viewport
    let camera = store.getCamera()
    let bounds = { w: 0, h: 0 }
    let panel = { w: 0, h: 0 }
    const apply = (nextCamera = camera): void => {
      camera = nextCamera
      const { anchor: point, ids: targets, frozen: pinned, bottomReserve: reserve } = state.current
      const placement = placeCanvasToolbar(camera, point, bounds, panel, dragOffsetFor(getCanvasDrag(), targets), reserve)
      element.style.visibility = placement ? '' : 'hidden'
      if (!placement) return
      const position = pinned && element.style.left && element.style.top
        ? { left: parseFloat(element.style.left), top: parseFloat(element.style.top) }
        : placement
      const { left, top } = clampAnchorToViewport(position, {
        w: bounds.w,
        h: Math.min(bounds.h, Math.max(panel.h + 16, bounds.h - reserve)),
      }, panel)
      element.style.left = `${left}px`
      element.style.top = `${top}px`
    }
    // Замеры только при изменении размеров: пан/зум не вызывает layout каждый кадр.
    const measure = (): void => {
      const wasHidden = bounds.w <= 0 || bounds.h <= 0
      bounds = { w: viewport.clientWidth, h: viewport.clientHeight }
      panel = { w: element.offsetWidth, h: element.offsetHeight }
      apply(wasHidden ? store.getCamera() : camera)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(element)
    applyRef.current = apply
    const offCamera = subscribeAnnotationCamera((nextCamera) => {
      // Шина общая для досок: скрытая вкладка сохраняет собственную камеру.
      if (bounds.w > 0 && bounds.h > 0) apply(nextCamera)
    })
    const offStore = store.subscribeCamera(() => apply(store.getCamera()))
    const offDrag = subscribeCanvasDrag(() => apply())
    return () => {
      observer.disconnect()
      offCamera(); offStore(); offDrag()
      applyRef.current = null
      viewportRef.current = null
    }
  }, [store])

  // Смена самого объекта (другое выделение, изменившийся размер) — обычный
  // рендер: пересчитываем сразу, не дожидаясь следующего движения камеры.
  useLayoutEffect(() => {
    applyRef.current?.()
  }, [store, anchor.x, anchor.y, anchor.screenOffsetY, anchor.bounds, frozen, ids, bottomReserve])

  return ref
}
