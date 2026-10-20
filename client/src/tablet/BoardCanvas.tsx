import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useCameraVersion, useContentVersion } from '../spaces/canvas/konva/useStore'
import { boardLockKey, lockedIdsFromKey } from './boardLocks'
import { GESTURE_FRAME_MS } from '../spaces/canvas/konva/groupDrag'
import {
  LONG_PRESS_MS,
  fitCamera,
  hitTest,
  isDoubleTap,
  isViewerItem,
  movedFar,
  panBy,
  pinchGeometry,
  pinchTo,
  screenDeltaToWorld,
  screenToWorld,
  shouldReleasePromptFocus,
  snapDragToContent,
  visibleOnScreen,
  zoomAt,
  type Camera,
  type Point,
  type TapRecord,
} from './boardGestures'
import { MemoBoardItemView } from './BoardItemView'
import type { TabletMediaUploader } from './runtime'
import { applyBoardDrop, dropTargetAt } from './boardDrops'
import { TabletStoreSnapGuides } from './TabletSnapGuides'
import { useBoardHistory } from './boardHistory'
import { BoardObjectNavigator } from './BoardObjectNavigator'
import { boardObjectLabel, revealBoardObject, useBoardObjectNavigation } from './boardObjectNavigation'
const useBoardFollow = (_store: unknown, _viewport: unknown) => ({ resizeViewport: (_size: unknown) => {} })
import { createPortal } from 'react-dom'
import { usePortalTarget } from '../ui/usePortalTarget'
import { createGestureAdmission } from '../spaces/canvas/konva/gestureAdmission'
import { bindBoardPointerRecovery, releaseBoardPointers } from './boardPointerRecovery'

// Доска пальцами.
//
// Рисует DOM, а не Konva: планшету не нужен ни движок канваса, ни всё, что за
// ним тянется. Источник правды тот же `CanvasStore`, что и на компьютере, —
// значит доска на обоих устройствах живёт по одним правилам, а не «почти так
// же».
//
// Перетаскивание НЕ трогает стор до отпускания: объект едет прямой правкой
// стиля, а стор узнаёт о переезде один раз. Иначе каждый кадр жеста стал бы
// отдельным шагом отмены (и заодно перерисовкой всей доски) — тот же приём,
// что на компьютере, где во время жеста двигается нода Konva, а не документ.

export function BoardCanvas({
  store,
  upload,
  readOnly,
  multiSelect,
  showObjects = false,
  chromeHidden = false,
  onLongPress,
  onDoubleTap,
  onBackgroundTap,
  onSelectionRect,
  onGestureStart,
  onResizeGesture,
}: {
  store: CanvasStore
  upload?: TabletMediaUploader
  readOnly?: boolean
  multiSelect?: boolean
  showObjects?: boolean
  chromeHidden?: boolean
  onLongPress(itemId: string, at: Point): void
  onDoubleTap?(itemId: string): void
  onBackgroundTap?(): void
  onSelectionRect?(rect: DOMRect | null): void
  onGestureStart?(): void
  onResizeGesture?(itemId: string, at: Point): void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const history = useBoardHistory()
  const [viewport, setViewport] = useState({ w: 1024, h: 768 })
  const follow = useBoardFollow(store, viewport)
  const [controlsHidden, setControlsHidden] = useState(false)
  const hideControls = () => { setControlsHidden(true); onGestureStart?.() }
  const measuredViewport = useRef<{ w: number; h: number } | null>(null)
  const fittedRef = useRef(false)
  useContentVersion(store)
  useCameraVersion(store)
  // Из совместной работы доске нужен только набор закрытых объектов: кадры
  // чужих курсоров её больше не перерисовывают (пункт 3.8, С-9).
  const lockKey = useSyncExternalStore(store.subscribeCollaboration, () => boardLockKey(store))
  const locked = useMemo(() => lockedIdsFromKey(lockKey), [lockKey])

  const camera = store.getCamera()
  const items = store.getRenderableItems()
  const pending = store.getPending()
  const selected = store.getSelectedIds()
  const selectedItem = items.find((item) => selected.has(item.id))
  const reveal = (id: string) => revealBoardObject(store, id, viewport)
  const activate = (id: string) => {
    if (readOnly) return
    reveal(id)
    onLongPress(id, { x: viewport.w / 2, y: viewport.h / 2 })
  }
  const onKeyDown = useBoardObjectNavigation(store, reveal, activate, Boolean(readOnly))

  const pointers = useRef(new Map<number, Point>())
  const historyGesture = useRef(false)
  const gestureCamera = useRef<Camera | null>(null)
  const pinch = useRef<{ camera: Camera; center: Point; distance: number } | null>(null)
  const dragAdmission = useRef(createGestureAdmission())
  const pan = useRef<{ from: Point; camera: Camera; moved: boolean } | null>(null)
  const selectionTap = useRef<{ hit: string; doubleTap: boolean; tap: TapRecord } | null>(null)
  const lastTap = useRef<TapRecord | null>(null)
  const drag = useRef<{
    pointerId: number
    ids: string[]
    origins: Map<string, Point>
    /** Размеры переносимых — запомнены при захвате: за перенос они не меняются. */
    sizes: Map<string, { w: number; h: number; rotation?: number }>
    /** Когда ушёл последний кадр жеста коллегам — см. GESTURE_FRAME_MS. */
    previewSentAt: number
    from: Point
    lastPoint: Point
    moved: boolean
    awaiting: boolean
    denied: boolean
    hit: string
    delta: Point
    doubleTap: boolean
    tap: TapRecord
  } | null>(null)
  const longPress = useRef<number | null>(null)
  const selectionFrame = useRef<number | null>(null)
  const marquee = useRef<{ pointerId: number; from: Point; to: Point; base: string[]; pen: boolean } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const rectangle = (from: Point, to: Point) => ({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) })
  const clearMarquee = () => { marquee.current = null; setMarqueeRect(null) }
  const startMarquee = (pointerId: number, point: Point, pen: boolean) => {
    clearLongPress()
    if (drag.current) releaseNodes(drag.current.ids)
    dragAdmission.current.cancel()
    drag.current = null
    pan.current = null
    pinch.current = null
    selectionTap.current = null
    lastTap.current = null
    store.setGuides([])
    store.getCollaboration()?.setPreview(null)
    const from = screenToWorld(store.getCamera(), point)
    marquee.current = { pointerId, from, to: from, base: multiSelect ? [...store.getSelectedIds()] : [], pen }
    setMarqueeRect(rectangle(from, from))
  }


  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    measuredViewport.current = null
    fittedRef.current = false
    const measure = () => {
      const next = { w: host.clientWidth, h: host.clientHeight }
      if (next.w <= 0 || next.h <= 0) return

      const previous = measuredViewport.current
      if (!previous) {
        store.setContainerSize(next.w, next.h)
      } else if (previous.w !== next.w || previous.h !== next.h) {
        // Нижний док и инспектор меняют доступную область холста. Сохраняем
        // мировую точку в центре экрана, чтобы контент не уезжал под панели.
        follow.resizeViewport(next)
      }
      measuredViewport.current = next
      setViewport(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [store])

  // Первое открытие доски: показываем её целиком, а не угол в никуда.
  useEffect(() => {
    if (fittedRef.current || items.length === 0 || viewport.w < 2) return
    const current = store.getCamera()
    fittedRef.current = true
    if (current.x === 0 && current.y === 0 && current.scale === 1) {
      store.setCamera(fitCamera(items, viewport))
    }
  }, [items, viewport, store])

  const board = useMemo(() => [...items, ...pending], [items, pending])
  const visible = useMemo(
    () => visibleOnScreen(board, camera, viewport, selected),
    [board, camera, viewport, selected],
  )

  const clearLongPress = () => {
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current)
      longPress.current = null
    }
  }

  const nodeOf = (id: string): HTMLElement | null =>
    hostRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`) ?? null

  const measureSelection = () => {
    const rects = [...selected].map(nodeOf).filter((node): node is HTMLElement => Boolean(node)).map((node) => node.getBoundingClientRect())
    if (rects.length === 0) {
      onSelectionRect?.(null)
      return
    }
    const left = Math.min(...rects.map((rect) => rect.left))
    const right = Math.max(...rects.map((rect) => rect.right))
    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.bottom))
    onSelectionRect?.(DOMRect.fromRect({ x: left, y: top, width: right - left, height: bottom - top }))
  }

  const scheduleSelectionMeasure = () => {
    if (selectionFrame.current !== null) return
    selectionFrame.current = window.requestAnimationFrame(() => {
      selectionFrame.current = null
      measureSelection()
    })
  }

  useEffect(() => {
    scheduleSelectionMeasure()
    return () => {
      if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current)
      selectionFrame.current = null
    }
    // camera/content changes already rerender this component; the selected key
    // makes Set mutations explicit to the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.x, camera.y, camera.scale, viewport.w, viewport.h, [...selected].join(','), items])

  const shiftNodes = (ids: readonly string[], delta: Point) => {
    // Ноды находятся внутри уже масштабированного world-слоя, поэтому сюда
    // приходит уже пересчитанный мировой путь пальца с поправкой магнита.
    for (const id of ids) {
      const node = nodeOf(id)
      if (node) {
        node.classList.add('dragging')
        node.style.transform = `translate3d(${delta.x}px, ${delta.y}px, 0)`
      }
    }
  }

  const releaseNodes = (ids: readonly string[]) => {
    for (const id of ids) {
      const node = nodeOf(id)
      if (node) {
        node.classList.remove('dragging')
        node.style.transform = ''
      }
    }
  }

  const publishCursor = (point: Point | null) => {
    const collaboration = store.getCollaboration()
    if (!collaboration) return
    collaboration.setCursor(point ? screenToWorld(store.getCamera(), point) : null)
  }

  const pointOf = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const rect = hostRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const moveActiveDrag = (moving: NonNullable<typeof drag.current>, point: Point): void => {
    if (moving.awaiting || moving.denied) return
    if (!moving.moved && !movedFar(moving.from, point)) return
    if (!moving.moved) {
      moving.moved = true
      moving.doubleTap = false
      lastTap.current = null
      clearLongPress()
    }
    if (readOnly || !store.canMutateItems(moving.ids)) return
    const scale = store.getCamera().scale
    const rawDelta = screenDeltaToWorld(
      { x: point.x - moving.from.x, y: point.y - moving.from.y },
      scale,
    )
    const snap = snapDragToContent(board, moving.ids, moving.hit, rawDelta, scale)
    moving.delta = snap.delta
    store.setGuides(snap.guides)
    shiftNodes(moving.ids, snap.delta)
    // ⚠️ Кадр жеста — из запомненного при захвате и не чаще, чем сервер его
    // принимает (пункт 3.8, С-9): раньше на КАЖДОЕ движение пальца собиралась
    // карта всех объектов доски, а кадр уходил без притормаживания — лишнее
    // сервер всё равно выбрасывает (тот же приём, что на компьютере).
    const now = Date.now()
    if (now - moving.previewSentAt >= GESTURE_FRAME_MS) {
      moving.previewSentAt = now
      store.getCollaboration()?.setPreview(moving.ids.flatMap((id) => {
        const size = moving.sizes.get(id)
        const origin = moving.origins.get(id)
        return size && origin
          ? [{ id, x: origin.x + moving.delta.x, y: origin.y + moving.delta.y, w: size.w, h: size.h, rotation: size.rotation }]
          : []
      }))
    }
    scheduleSelectionMeasure()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement
      && shouldReleasePromptFocus({
        tagName: activeElement.tagName,
        inTabletPrompt: Boolean(activeElement.closest('.tablet-prompt')),
      })
    ) {
      activeElement.blur()
    }
    // Кнопки на самих объектах (играть, отменить) забирают касание себе.
    if (event.target instanceof Element && event.target.closest('[data-tablet-interactive]')) return
    if (pointers.current.size === 0) setControlsHidden(false)
    const point = pointOf(event)
    publishCursor(point)
    // Захват указателя — удобство, а не условие работы: если браузер его не
    // даёт, жест обязан продолжаться (тот же урок, что в таймлайне, где
    // неудавшийся захват молча убивал перетаскивание стыка).
    try {
      hostRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // продолжаем без захвата
    }
    if (pointers.current.size === 0) gestureCamera.current = store.getCamera()
    pointers.current.set(event.pointerId, point)

    if (pointers.current.size >= 3 || historyGesture.current) {
      clearMarquee()
      historyGesture.current = true
      dragAdmission.current.cancel()
      store.getCollaboration()?.setPreview(null)
      if (drag.current) releaseNodes(drag.current.ids)
      if (gestureCamera.current) store.setCamera(gestureCamera.current)
      drag.current = null
      pan.current = null
      pinch.current = null
      selectionTap.current = null
      lastTap.current = null
      clearLongPress()
      store.setGuides([])
      return
    }

    // Pencil с удержанным пальцем рисует рамку, а не начинает щипок.
    if (marquee.current?.pen && pointers.current.size <= 2) return
    if (event.pointerType === 'pen' && pointers.current.size === 2) {
      startMarquee(event.pointerId, point, true)
      return
    }
    const geometry = pinchGeometry([...pointers.current.values()])
    if (geometry) {
      store.noteManualCameraInteraction()
      hideControls()
      clearMarquee()
      // Второй палец отменяет всё, что начал первый: щипок важнее.
      dragAdmission.current.cancel()
      store.getCollaboration()?.setPreview(null)
      if (drag.current) releaseNodes(drag.current.ids)
      store.setGuides([])
      lastTap.current = null
      pinch.current = { camera: store.getCamera(), ...geometry }
      pan.current = null
      selectionTap.current = null
      drag.current = null
      clearLongPress()
      return
    }

    const hit = hitTest(board, screenToWorld(store.getCamera(), point))
    if (hit) {
      const hitItem = board.find((candidate) => candidate.id === hit)
      const tap: TapRecord = { itemId: hit, at: point, timestamp: Date.now() }
      const doubleTap = isViewerItem(hitItem) && isDoubleTap(lastTap.current, tap)
      if (multiSelect || readOnly) {
        selectionTap.current = { hit, doubleTap, tap }
        pan.current = { from: point, camera: store.getCamera(), moved: false }
        return
      }
      const ids = selected.has(hit) && selected.size > 1 ? [...selected] : [hit]
      const origins = new Map<string, Point>()
      const sizes = new Map<string, { w: number; h: number; rotation?: number }>()
      const boardById = new Map(board.map((candidate) => [candidate.id, candidate]))
      for (const id of ids) {
        const item = boardById.get(id)
        if (!item) continue
        origins.set(id, { x: item.x, y: item.y })
        sizes.set(id, { w: item.w, h: item.h, rotation: 'rotation' in item ? item.rotation : undefined })
      }
      const moving = {
        pointerId: event.pointerId,
        ids: [...origins.keys()],
        origins,
        sizes,
        previewSentAt: 0,
        from: point,
        lastPoint: point,
        moved: false,
        awaiting: false,
        denied: false,
        hit,
        delta: { x: 0, y: 0 },
        doubleTap,
        tap,
      }
      drag.current = moving
      const armLongPress = () => {
        clearLongPress()
        longPress.current = window.setTimeout(() => {
          longPress.current = null
          if (!drag.current || drag.current !== moving || drag.current.moved || moving.awaiting || moving.denied) return
          const hitItem = board.find((candidate) => candidate.id === hit)
          drag.current = null
          lastTap.current = null
          releaseBoardPointers(pointers.current, hostRef.current)
          pointers.current.clear()
          store.setGuides([])
          if (onResizeGesture && hitItem && (hitItem.kind === 'image' || hitItem.kind === 'video')) {
            onResizeGesture(hit, point)
          } else {
            onLongPress(hit, point)
          }
        }, LONG_PRESS_MS)
      }
      if (store.canMutateItems(moving.ids)) {
        armLongPress()
        return
      }
      // Keep the first drag alive while the collaboration controller asks for
      // the lease. During this phase pointer moves are remembered, but they do
      // not pan the board or mutate item styles.
      moving.awaiting = true
      dragAdmission.current.begin(
        () => store.withSelection(moving.ids, () => {}),
        () => {
          if (drag.current !== moving || !pointers.current.has(moving.pointerId)) return
          if (!store.canMutateItems(moving.ids)) {
            moving.awaiting = false
            moving.denied = true
            return
          }
          moving.awaiting = false
          if (movedFar(moving.from, moving.lastPoint)) moveActiveDrag(moving, moving.lastPoint)
          else armLongPress()
        },
        () => {
          if (drag.current !== moving) return
          moving.awaiting = false
          moving.denied = true
        },
      )
      return
    }
    if (event.pointerType === 'pen') {
      startMarquee(event.pointerId, point, true)
      return
    }
    pan.current = { from: point, camera: store.getCamera(), moved: false }
    clearLongPress()
    longPress.current = window.setTimeout(() => {
      if (pointers.current.size === 1 && pan.current && !pan.current.moved) startMarquee(event.pointerId, point, false)
    }, 350)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointOf(event)
    publishCursor(point)
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, point)
    if (historyGesture.current) return
    if (marquee.current) {
      if (event.pointerId === marquee.current.pointerId) {
        marquee.current.to = screenToWorld(store.getCamera(), point)
        setMarqueeRect(rectangle(marquee.current.from, marquee.current.to))
      }
      return
    }

    const geometry = pinchGeometry([...pointers.current.values()])
    if (pinch.current && geometry) {
      store.noteManualCameraInteraction()
      store.setCamera(pinchTo(pinch.current, geometry))
      return
    }

    const moving = drag.current
    if (moving) {
      if (movedFar(moving.from, point)) hideControls()
      moving.lastPoint = point
      if (moving.awaiting || moving.denied) return
      moveActiveDrag(moving, point)
      return
    }

    const panning = pan.current
    if (!panning) return
    if (!panning.moved && !movedFar(panning.from, point)) return
    store.noteManualCameraInteraction()
    if (!panning.moved) panning.camera = store.getCamera()
    clearLongPress()
    panning.moved = true
    hideControls()
    lastTap.current = null
    store.setCamera(panBy(panning.camera, point.x - panning.from.x, point.y - panning.from.y))
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const moving = drag.current
    const panning = pan.current
    const selecting = selectionTap.current
    const wasPinching = Boolean(pinch.current)
    if (moving?.awaiting) dragAdmission.current.cancel()
    pointers.current.delete(event.pointerId)
    if (pointers.current.size === 0) publishCursor(pointOf(event))
    try { hostRef.current?.releasePointerCapture(event.pointerId) } catch { /* capture is optional */ }
    if (historyGesture.current) {
      store.getCollaboration()?.setPreview(null)
      if (pointers.current.size === 0) historyGesture.current = false
      return
    }
    if (marquee.current) {
      if (event.pointerId !== marquee.current.pointerId) return
      const frame = rectangle(marquee.current.from, screenToWorld(store.getCamera(), pointOf(event)))
      const ids = board.filter((item) => item.x <= frame.x + frame.w && item.x + item.w >= frame.x && item.y <= frame.y + frame.h && item.y + item.h >= frame.y).map((item) => item.id)
      store.setSelection([...new Set([...marquee.current.base, ...ids])])
      clearMarquee()
      clearLongPress()
      return
    }
    if (pointers.current.size === 0) pinch.current = null
    drag.current = null
    pan.current = null
    selectionTap.current = null
    clearLongPress()
    store.setGuides([])

    if (wasPinching) return
    if (moving) {
      if (!moving.moved) {
        const item = board.find((candidate) => candidate.id === moving.hit)
        if (moving.doubleTap && isViewerItem(item) && onDoubleTap) {
          // Второй tap сохраняет выбор первого и открывает отдельный просмотр.
          // Геометрию объекта и историю здесь не трогаем.
          if (!store.getSelectedIds().has(moving.hit)) store.select(moving.hit)
          lastTap.current = null
          onDoubleTap(moving.hit)
        } else {
          store.select(moving.hit, Boolean(multiSelect))
          lastTap.current = isViewerItem(item) ? moving.tap : null
        }
        return
      }
      releaseNodes(moving.ids)
      if (readOnly) return
      if (!store.canMutateItems(moving.ids)) {
        store.getCollaboration()?.setPreview(null)
        return
      }
      // Отпустили над полкой или архивом — объект туда и уходит, а по доске не
      // едет. Пальцем это единственный способ закрепить ассет: правой кнопки,
      // которой это делают на компьютере, здесь нет.
      const drop = dropTargetAt(event.clientX, event.clientY)
      if (drop && applyBoardDrop(store, drop, moving.ids, history.undo)) {
        store.getCollaboration()?.setPreview(null)
        return
      }
      // Один шаг истории на весь жест: стор до этой строки о переезде не знал.
      store.updatePositions(
        moving.ids.map((id) => {
          const origin = moving.origins.get(id)!
          return { id, x: origin.x + moving.delta.x, y: origin.y + moving.delta.y }
        }),
      )
      store.getCollaboration()?.setPreview(null)
      return
    }
    if (panning && !panning.moved) {
      if (selecting) {
        const item = board.find((candidate) => candidate.id === selecting.hit)
        if (selecting.doubleTap && isViewerItem(item) && onDoubleTap) {
          if (!store.getSelectedIds().has(selecting.hit)) store.select(selecting.hit)
          lastTap.current = null
          onDoubleTap(selecting.hit)
        } else {
          store.select(selecting.hit, Boolean(multiSelect))
          lastTap.current = isViewerItem(item) ? selecting.tap : null
        }
      } else {
        store.setSelection([])
        lastTap.current = null
      }
      onBackgroundTap?.()
    }
  }

  const cancelPointer = (measure = true) => {
    dragAdmission.current.cancel()
    if (drag.current) releaseNodes(drag.current.ids)
    drag.current = null
    pan.current = null
    pinch.current = null
    selectionTap.current = null
    lastTap.current = null
    clearLongPress()
    store.setGuides([])
    store.getCollaboration()?.setPreview(null)
    publishCursor(null)
    releaseBoardPointers(pointers.current, hostRef.current)
    clearMarquee()
    pointers.current.clear()
    historyGesture.current = false
    gestureCamera.current = null
    if (measure) scheduleSelectionMeasure()
  }

  useEffect(() => {
    const onBlur = () => cancelPointer()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancelPointer()
      store.getCollaboration()?.setVisible?.(document.visibilityState === 'visible')
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      cancelPointer(false)
    }
  }, [store])

  const recovery = useRef({ finishPointer, cancelPointer })
  recovery.current = { finishPointer, cancelPointer }
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return bindBoardPointerRecovery(host, {
      has: id => pointers.current.has(id), any: () => pointers.current.size > 0,
      finish: event => recovery.current.finishPointer(event as unknown as ReactPointerEvent<HTMLDivElement>),
      cancel: () => recovery.current.cancelPointer(),
    })
  }, [store])

  return (
    <div
      ref={hostRef}
      className="tablet-board"
      tabIndex={0}
      role="region"
      aria-label="Canvas. Arrow keys select objects, Shift selects a range, Space toggles selection, Enter opens actions"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={() => cancelPointer()}
      onWheel={(event) => {
        store.noteManualCameraInteraction()
        // К планшету бывает подключена мышь или трекпад — им тоже надо жить.
        const rect = hostRef.current?.getBoundingClientRect()
        const pointer = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
        const current = store.getCamera()
        store.setCamera(zoomAt(current, pointer, current.scale * Math.exp(-event.deltaY * 0.0015)))
      }}
    >
      {showObjects && !chromeHidden && <BoardObjectNavigator store={store} readOnly={readOnly} reveal={reveal} onActivate={activate} />}
      <span className="tablet-board-selection-status" role="status" aria-live="polite">
        {selected.size === 1 && selectedItem ? boardObjectLabel(selectedItem) : `Selected: ${selected.size}`}
      </span>
      <div
        className="tablet-board-world"
        style={{
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          transformOrigin: '0 0',
          // Скругление и обводка выделения карточек держат экранный размер
          // (tablet.css, .tablet-item-inner): слой масштабируется, они — нет.
          '--tablet-inverse-scale': String(1 / camera.scale),
        } as CSSProperties}
      >
        {visible.map((item) => (
          <MemoBoardItemView
            key={item.id}
            item={item}
            selected={!chromeHidden && selected.has(item.id)}
            scale={camera.scale}
            pixelRatio={window.devicePixelRatio || 1}
            selectionMode={Boolean(multiSelect)}
            groupSelected={selected.size > 1}
            controlsHidden={controlsHidden}
            onDetails={onDoubleTap}
            store={store}
            upload={upload}
            readOnly={readOnly || locked === null || locked.has(item.id)}
            playbackOnly={readOnly}
          />
        ))}
        {marqueeRect && <div className="tablet-marquee" style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h, borderWidth: 1 / camera.scale }} />}
        <TabletStoreSnapGuides store={store} scale={camera.scale} />
      </div>
    </div>
  )
}
