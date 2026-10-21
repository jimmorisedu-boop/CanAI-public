import Konva from 'konva'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Group, Layer, Line, Rect, Stage, Transformer } from 'react-konva'
import { getCropTarget, onCropTarget, setCropTarget } from '../cropBus'
import { cropSessionForItem } from './cropState'
import { CompareMarks } from '../compare/CompareMarks'
import { useCompareSession } from '../compare/useCompareSession'
import { requestImageEdit } from '../editorBus'
import { getSketchTarget, setSketchTarget } from '../sketchBus'
import { notify } from '../notifications'
import { CanvasStore } from './canvasStore'
import { usePortalTarget } from '../../../ui/usePortalTarget'
import { readingOrder } from './readingOrder'
import type { CanvasItem } from './types'
import { AudioItem, ImageItem, PendingItem, TextItem, VideoItem } from './CanvasItems'
import { GifItem } from './GifItem'
import { isAnimatedImageItem } from './animatedImageItem'
import { quantizeScale } from './cameraScale'
const prewarmList = (..._args: unknown[]) => [] as unknown[]
const prewarmSignature = (..._args: unknown[]) => ''
const sendPrewarm = (_entries: unknown[]) => {}
import { setImageLoadFocus } from './media'
import { LinkItem } from './LinkItem'
import { ContextMenu, type MenuState } from './ContextMenu'
import { boardMediaUploader } from './boardUploader'
import { applyCropInBackground } from './cropApply'
import { centeredRect, type Rect as CropRect } from './cropMath'
import { CropOverlay } from './CropOverlay'
import { CropToolbar } from './CropToolbar'
import { ExportButton } from './ExportButton'
import { importFilesAt } from './importMedia'
import { mediaFilesFromClipboard } from './clipboardMedia'
import {
  canvasClipboardFromSystem,
  hasClipboard,
  pasteCanvasItems,
  syncInternalClipboardFromSystem,
  clipboardMirrorFailed,
} from './clipboard'
import { canvasPasteArbiter } from './pasteArbiter'
import { decidePaste } from './pasteDecision'
import { classifyCanvasTextPaste } from './mediaLinkUrl'
import { mediaLinkController } from './mediaLinkController'
import type { ProjectRef } from '../../../types'
import { itemAabb, rectIntersects } from './geometry'
import { isItemToolbarEligible, ItemToolbar } from './ItemToolbar'
import { SelectionToolbar } from './SelectionToolbar'
import { SketchPalette, SWATCHES, type Brush } from './SketchPalette'
import { TextEditOverlay } from './TextEditOverlay'
import { useCanvasHotkeys } from './useCanvasHotkeys'
import { useCameraVersion, useContentVersion, useEditableSelection, useGuidesVersion } from './useStore'
import { chooseCanvasViewportSize } from './canvasVisibility'
import { pointerToWorld } from './canvasPointer'
import { GenerationFocusOverlay } from './GenerationFocusOverlay'
import { GenerationSeriesCues } from './GenerationSeriesCues'
import { safeViewportFromOcclusions, type SafeEdgeOcclusion } from './canvasSafeArea'
import type { Rect as SeriesRect } from './generationSeriesGeometry'
import { isMacroText } from '../libraryFile'
import { MACRO_PASTE_HINT, macroRowHovered, routeMacroPaste } from '../macroPasteRoute'
const publishAnnotationCamera = (_camera: unknown) => {}
const publishBoardMarquee = (_rect: unknown) => {}
import { useGenerationSeriesReveal } from './useGenerationSeriesReveal'
import { CanvasCorner, CORNER_NARROW_BELOW } from './CanvasCorner'
const useBoardFollow = (_store: unknown, _size: unknown, _visible?: unknown) => ({ publishCamera: (_camera: unknown) => {}, resizeViewport: (_size: unknown) => {} })
import { useCanvasCornerDockReserve } from './useCanvasCornerDockReserve'
import { SelectionRings } from './SelectionRings'
import { SELECTION_COLOR, SELECTION_GROUP_COLOR, selectionPadding } from './selectionRing'
import { useNavigationMode } from '../../../settings/navigationMode'
import { useT } from '../../../i18n/context.js'
import { nextCameraFromWheel } from './canvasWheel'
import { cancelActiveCanvasDrag, cancelPendingCanvasDrag, installAltCopyKeys } from './itemHelpers'
import {
  canvasPixelRatio,
  canvasCullPadding,
  canvasRenderCamera,
  canvasViewForCamera,
  shouldRebaseCanvasView,
  visibleCanvasEntries,
} from './canvasPerformance'

// перетаскивание объектов — только левой кнопкой: средняя кнопка над картинкой
// не тащит её, а панорамирует канвас (midPan в onStageMouseDown)
Konva.dragButtons = [0]
// Три полноэкранных слоя на DPR 2–3 расходуют в 4–9 раз больше пикселей.
// 1.5 сохраняет чёткий Onest/контент и заметно снижает fill-rate на 4K/Retina.
Konva.pixelRatio = canvasPixelRatio(typeof window === 'undefined' ? 1 : window.devicePixelRatio)

// Картинки/видео тянем только за углы: keepRatio не даёт их исказить.
/** Невидимый запас вокруг ручки трансформера: полоса, которую Konva рисует в
 *  карту попаданий поверх самой ручки. 22 даёт ±14 px по диагонали. */
const ANCHOR_HIT_STROKE = 22

const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
// У текста доступны ВСЕ ручки (см. stepTextTransform): угол — пропорциональный
// масштаб вместе со шрифтом, бок — только ширина и перенос строк, верх/низ —
// только высота, разворачивающая скрытый текст. keepRatio действует лишь на углы.
const TEXT_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]

const WHEEL_GESTURE_END_MS = 140

// верхняя граница + горизонтальный центр bbox нескольких объектов — куда
// поставить SelectionToolbar (тот же принцип, что и одиночный ItemToolbar)
function selectionTopBounds(items: CanvasItem[]): { x: number; y: number; right: number; bottom: number } {
  const boxes = items.map(itemAabb)
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.x + b.w)),
    bottom: Math.max(...boxes.map((b) => b.y + b.h)),
  }
}

function sameRect(a: SeriesRect, b: SeriesRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function sameRectList(a: SeriesRect[], b: SeriesRect[]): boolean {
  return a.length === b.length && a.every((rect, index) => {
    const other = b[index]
    return other !== undefined && sameRect(rect, other)
  })
}

/** Пауза после движения камеры, прежде чем слать новый список прогрева. */
const PREWARM_DELAY_MS = 400

export function KonvaCanvas({
  store,
  projectId,
  projectRef = { source: 'local', id: projectId },
  readOnly = false,
  sketching,
  sketchBusy,
  onSketchDone,
  onSketchCancel,
  visible = true,
}: {
  store: CanvasStore
  projectId: string
  projectRef?: ProjectRef
  readOnly?: boolean
  sketching: boolean
  sketchBusy: boolean
  onSketchDone: () => void
  onSketchCancel: () => void
  visible?: boolean
}) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const layerRef = useRef<Konva.Layer>(null)
  const contentGroupRef = useRef<Konva.Group>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const drawing = useRef(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const follow = useBoardFollow(store, size, visible)
  const cornerDockReserve = useCanvasCornerDockReserve(
    wrapRef,
    size.w > 0 && size.w < CORNER_NARROW_BELOW,
    '.canvas-corner',
  )
  const [generationLayout, setGenerationLayout] = useState<{
    safeViewport: SeriesRect
    obstacles: SeriesRect[]
  }>({ safeViewport: { x: 0, y: 0, w: 0, h: 0 }, obstacles: [] })
  const lastValidSizeRef = useRef<{ w: number; h: number } | null>(null)
  const visibilityRedrawRafRef = useRef<number | null>(null)
  const wheelRedrawRafRef = useRef<number | null>(null)
  const wheelEndTimerRef = useRef<number | null>(null)
  const wheelPreviewCameraRef = useRef<{ scale: number; x: number; y: number } | null>(null)
  const wheelRenderedCameraRef = useRef<{ scale: number; x: number; y: number } | null>(null)
  const wheelGestureActiveRef = useRef(false)
  const desiredContentListeningRef = useRef(true)
  const [brush, setBrush] = useState<Brush>({ tool: 'draw', color: SWATCHES[0], size: 6 })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const importControllers = useRef(new Set<AbortController>())

  // кроп
  const [cropTarget, setCropTargetState] = useState<string | null>(getCropTarget())
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [cropRatio, setCropRatio] = useState<number | null>(null)
  const [cropBusy, setCropBusy] = useState(false)
  const exportPortal = usePortalTarget('top-bar-export-portal')
  const navigationMode = useNavigationMode()

  // рамка выделения (marquee): в мировых координатах
  const marqueeStart = useRef<{ x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<CropRect | null>(null)
  const promptBlurringClick = useRef(false)

  // панорама средней кнопкой
  const midPan = useRef<{ px: number; py: number; camX: number; camY: number } | null>(null)
  const stagePanActiveRef = useRef(false)

  // «Добавить картинку/видео» из контекстного меню — точка клика ждём в ref,
  // пока не сработает нативный файловый диалог
  const importAt = useRef<{ x: number; y: number } | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)

  useContentVersion(store)
  useCameraVersion(store)
  useGuidesVersion(store)
  const editableSelection = useEditableSelection(store)

  const items = store.getItems()
  const renderItems = store.getRenderableItems()
  const pending = store.getPending()
  const cam = store.getCamera()
  // Ступень масштаба для экранных превью: одна на все фигуры и огрублённая,
  // иначе каждая картинка перезапрашивалась бы на каждом кадре зума.
  const previewScale = quantizeScale(cam.scale)
  const selected = store.getSelectedIds()

  useEffect(() => () => {
    for (const controller of importControllers.current) controller.abort()
    importControllers.current.clear()
  }, [])

  function startImportBatch(files: File[], world: { x: number; y: number }): void {
    if (files.length === 0) return
    const controller = new AbortController()
    importControllers.current.add(controller)
    void importFilesAt(store, files, world, {}, controller.signal, projectRef)
      .catch((err) => {
        // Сообщение уходит в ОБЩУЮ стопку правого нижнего угла, как все
        // остальные. Своя плашка вверху по центру холста была четвёртым
        // местом для сообщений: человек ищет ответ там, где привык, и
        // пропускает отказ (найдено прогоном 20.08.2026). replaceKey — чтобы
        // партия из десяти файлов не выстроила десять одинаковых плашек.
        if (controller.signal.aborted) return
        notify({
          kind: 'error',
          message: err instanceof Error ? err.message : t('Failed to import file'),
          replaceKey: 'import-error',
        })
      })
      .finally(() => importControllers.current.delete(controller))
  }
  const strokes = store.getStrokes()
  const guides = store.getGuides()

  // Local cache of the camera to avoid reading stale values from the store
  // before the throttled store update has been committed/rendered.
  const cameraRef = useRef(store.getCamera())
  useEffect(() => {
    // An unrelated React render must not snap an active imperative wheel
    // preview back to the last camera committed to the store.
    const imperativeCameraActive = wheelGestureActiveRef.current
      || stagePanActiveRef.current
      || midPan.current !== null
      || nextCam.current !== null
    if (!imperativeCameraActive) cameraRef.current = cam
    const rendered = canvasRenderCamera(cam, cameraRef.current, imperativeCameraActive)
    publishAnnotationCamera(rendered)
    follow.publishCamera(rendered)
  }, [cam])

  // Картинки сетевой доски грузятся от центра кадра (пункт 3.5, Ф-5): очередь
  // загрузок спрашивает, где он сейчас, — камера за время очереди могла уехать.
  const sizeRef = useRef(size)
  sizeRef.current = size
  useEffect(() => {
    setImageLoadFocus(() => {
      const camera = cameraRef.current
      const view = sizeRef.current
      if (!(camera.scale > 0) || view.w <= 0 || view.h <= 0) return null
      return { x: (view.w / 2 - camera.x) / camera.scale, y: (view.h / 2 - camera.y) / camera.scale }
    })
    return () => setImageLoadFocus(null)
  }, [])

  // Прогрев превью всей доски своим сервером (пункт 3.5, Ф-5). Список — от
  // центра кадра; тот же список второй раз не шлём, а после жеста ждём, пока
  // камера встанет.
  const prewarmSent = useRef('')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const camera = cameraRef.current
      const entries = prewarmList(store.getItems(), {
        x: camera.x, y: camera.y, scale: camera.scale, width: size.w, height: size.h,
      }, window.devicePixelRatio || 1)
      const signature = prewarmSignature(entries)
      if (signature === prewarmSent.current) return
      prewarmSent.current = signature
      sendPrewarm(entries)
    }, PREWARM_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [items, previewScale, cam.x, cam.y, size.w, size.h, store])

  const nextCam = useRef<{ scale: number; x: number; y: number } | null>(null)
  const cameraCommitTimer = useRef<number | null>(null)

  const commitCameraNow = () => {
    if (cameraCommitTimer.current !== null) {
      window.clearTimeout(cameraCommitTimer.current)
      cameraCommitTimer.current = null
    }
    if (!nextCam.current) return
    const camera = nextCam.current
    nextCam.current = null
    store.setCamera(camera)
  }

  const updateCameraThrottled = (newCam: { scale: number; x: number; y: number }) => {
    cameraRef.current = newCam
    publishAnnotationCamera(newCam)
    follow.publishCamera(newCam)
    nextCam.current = newCam
    const stage = stageRef.current
    if (stage) {
      stage.position({ x: newCam.x, y: newCam.y })
      stage.scale({ x: newCam.scale, y: newCam.scale })
      stage.batchDraw()
    }
    // Движение остаётся кадровым через сам Konva, а React/store и автосейв
    // получают не 60, а максимум 20 обновлений в секунду.
    if (cameraCommitTimer.current === null) {
      cameraCommitTimer.current = window.setTimeout(commitCameraNow, 50)
    }
  }

  const drawWheelPreviewNow = () => {
    if (wheelRedrawRafRef.current !== null) {
      cancelAnimationFrame(wheelRedrawRafRef.current)
      wheelRedrawRafRef.current = null
    }
    const preview = wheelPreviewCameraRef.current
    if (!preview) return
    wheelPreviewCameraRef.current = null
    const stage = stageRef.current
    if (!stage) return
    stage.position({ x: preview.x, y: preview.y })
    stage.scale({ x: preview.scale, y: preview.scale })
    publishAnnotationCamera(preview)
    follow.publishCamera(preview)
    // The content group is non-listening during the gesture, so its expensive
    // hit graph is not rebuilt for every intermediate wheel frame.
    stage.batchDraw()
  }

  const finishWheelGesture = () => {
    if (wheelEndTimerRef.current !== null) {
      window.clearTimeout(wheelEndTimerRef.current)
      wheelEndTimerRef.current = null
    }
    if (!wheelGestureActiveRef.current) return
    drawWheelPreviewNow()
    wheelGestureActiveRef.current = false
    wheelRenderedCameraRef.current = null
    contentGroupRef.current?.listening(desiredContentListeningRef.current)
    const camera = cameraRef.current
    const stored = store.getCamera()
    if (stored.x !== camera.x || stored.y !== camera.y || stored.scale !== camera.scale) {
      store.setCamera(camera)
    } else {
      layerRef.current?.batchDraw()
    }
  }

  // Марки рамки выделения тоже шлются на каждый сырой pointermove — троттлим
  // до rAF тем же приёмом, что и камеру, иначе на 250+ объектах перерисовка
  // (и пересчёт культинга) при рамке выделения происходит чаще экрана.
  const nextMarquee = useRef<CropRect | null>(null)
  const marqueeRafId = useRef<number | null>(null)
  const updateMarqueeThrottled = (rect: CropRect) => {
    nextMarquee.current = rect
    if (marqueeRafId.current === null) {
      marqueeRafId.current = requestAnimationFrame(() => {
        if (nextMarquee.current) {
          setMarquee(nextMarquee.current)
          nextMarquee.current = null
        }
        marqueeRafId.current = null
      })
    }
  }
  // Явное завершение (mouseup/blur): отменяем ЗАПЛАНИРОВАННЫЙ кадр — иначе
  // он может «догнать» уже после setMarquee(null) и вернуть рамку на экран.
  function finishMarquee(): void {
    if (marqueeRafId.current !== null) {
      cancelAnimationFrame(marqueeRafId.current)
      marqueeRafId.current = null
    }
    nextMarquee.current = null
    setMarquee(null)
  }

  // Cancel any pending animation frames on unmount
  useEffect(() => {
    return () => {
      cancelActiveCanvasDrag(store)
      store.getCollaboration()?.setPreview(null)
      publishCanvasCursor(null)
      if (wheelEndTimerRef.current !== null) {
        window.clearTimeout(wheelEndTimerRef.current)
        wheelEndTimerRef.current = null
      }
      if (wheelRedrawRafRef.current !== null) {
        cancelAnimationFrame(wheelRedrawRafRef.current)
        wheelRedrawRafRef.current = null
      }
      if (wheelGestureActiveRef.current) store.setCamera(cameraRef.current)
      wheelGestureActiveRef.current = false
      if (stagePanActiveRef.current) store.setCamera(cameraRef.current)
      stagePanActiveRef.current = false
      commitCameraNow()
      if (marqueeRafId.current !== null) {
        cancelAnimationFrame(marqueeRafId.current)
        marqueeRafId.current = null
      }
    }
  }, [store])

  // A lease request can outlive the Konva drag that initiated it. Pointer end
  // and focus loss invalidate that request, so a late selection ack cannot
  // resurrect a gesture after the user has already released the mouse.
  useEffect(() => {
    const finish = () => cancelPendingCanvasDrag(store)
    const cancel = () => cancelActiveCanvasDrag(store)
    const endEvents = ['mouseup', 'touchend', 'pointerup'] as const
    const cancelEvents = ['touchcancel', 'pointercancel', 'blur'] as const
    for (const event of endEvents) window.addEventListener(event, finish)
    for (const event of cancelEvents) window.addEventListener(event, cancel)
    return () => {
      for (const event of endEvents) window.removeEventListener(event, finish)
      for (const event of cancelEvents) window.removeEventListener(event, cancel)
      cancelActiveCanvasDrag(store)
    }
  }, [store])

  // Перенос с Alt кладёт копию (см. altDragCopy): клавишу слушаем и тогда,
  // когда мышь стоит, — исходник должен показаться на месте сразу.
  useEffect(() => installAltCopyKeys(store), [store])

  const cropping = Boolean(cropTarget)
  const compareSession = useCompareSession()
  // набор кандидатов: клик по объекту добавляет его в сравнение (см.
  // selectOnClick), поэтому обычное выделение рамкой на это время выключаем
  const comparePicking = compareSession?.phase === 'picking' ? compareSession : null
  const interactive = !readOnly && !sketching && !cropping
  // Рамка, ручки и панель над объектом — это ВИД, и он не ждёт ответа сервера
  // об аренде (см. looksMutable). Право на правку по-прежнему у canMutateItems.
  function canDragItem(id: string): boolean {
    // The first drag is allowed to reach itemHelpers, which pauses it while
    // the collaboration controller acquires the lease. The helper restores
    // the node until the ack arrives; gating here would require a second click.
    void id
    return interactive
  }
  const spaceHeld = useCanvasHotkeys(store, interactive && !editingTextId && visible, size, pointerWorld)
  desiredContentListeningRef.current = interactive && !spaceHeld
  const { safeViewport, obstacles } = generationLayout
  const { cues, showSeries } = useGenerationSeriesReveal({
    store,
    projectId,
    viewport: safeViewport,
    obstacles,
    enabled: visible && !sketching && !cropping,
  })

  // вход/выход из режима кропа
  useEffect(
    () =>
      onCropTarget((id) => {
        setCropTargetState(id)
        if (id) {
          const item = store.getItem(id)
          if (item) {
            const session = cropSessionForItem(item)
            setCropRect(session.savedRect ?? centeredRect({ w: session.item.w, h: session.item.h }, null))
            setCropRatio(null)
            store.setSelection([])
          }
        } else {
          setCropRect(null)
        }
      }),
    [store],
  )

  // размер контейнера → Stage + стор (для размещения по центру видимой области)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const canvasMain = el.closest('.canvas-main')
    const safeEdgeElements = canvasMain
      ? [...canvasMain.querySelectorAll<HTMLElement>('[data-canvas-safe-edge]')]
      : []
    let measured = false
    const apply = () => {
      const next = chooseCanvasViewportSize(
        { w: el.clientWidth, h: el.clientHeight },
        { w: window.innerWidth, h: window.innerHeight },
        lastValidSizeRef.current,
      )
      if (!next) return

      const previous = lastValidSizeRef.current
      lastValidSizeRef.current = next
      setSize((current) => (current.w === next.w && current.h === next.h ? current : next))

      if (!measured) {
        store.setContainerSize(next.w, next.h)
        measured = true
      } else if (!previous || previous.w !== next.w || previous.h !== next.h) {
        follow.resizeViewport(next)
      }

      const wrapRect = el.getBoundingClientRect()
      if (![wrapRect.left, wrapRect.top, wrapRect.width, wrapRect.height].every(Number.isFinite)
        || wrapRect.width <= 0
        || wrapRect.height <= 0) return

      const occlusions: SafeEdgeOcclusion[] = []
      for (const element of safeEdgeElements) {
        const edge = element.dataset.canvasSafeEdge
        if (edge !== 'bottom' && edge !== 'right') continue
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        if (element.hidden
          || element.getClientRects().length === 0
          || style.display === 'none'
          || style.visibility === 'hidden'
          || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
          || rect.width <= 0
          || rect.height <= 0) continue
        occlusions.push({
          edge,
          rect: {
            x: rect.left - wrapRect.left,
            y: rect.top - wrapRect.top,
            w: rect.width,
            h: rect.height,
          },
        })
      }
      const safeViewport = safeViewportFromOcclusions(
        { x: 0, y: 0, w: next.w, h: next.h },
        occlusions,
      )
      const obstacles = occlusions.map(({ rect }) => rect)
      store.setGenerationSafeViewport(safeViewport)
      setGenerationLayout((current) => (
        sameRect(current.safeViewport, safeViewport) && sameRectList(current.obstacles, obstacles)
          ? current
          : { safeViewport, obstacles }
      ))
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    safeEdgeElements.forEach((element) => ro.observe(element))

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        store.getCollaboration()?.setVisible?.(true)
        apply()
        if (visibilityRedrawRafRef.current !== null) {
          cancelAnimationFrame(visibilityRedrawRafRef.current)
        }
        visibilityRedrawRafRef.current = requestAnimationFrame(() => {
          visibilityRedrawRafRef.current = null
          stageRef.current?.batchDraw()
        })
      } else {
        cancelActiveCanvasDrag(store)
        store.setGuides([])
        store.getCollaboration()?.setVisible?.(false)
      }
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (visibilityRedrawRafRef.current !== null) {
        cancelAnimationFrame(visibilityRedrawRafRef.current)
        visibilityRedrawRafRef.current = null
      }
    }
  }, [store])

  // При изменении размера Stage браузер очищает холст Canvas — принудительно перерисовываем
  useEffect(() => {
    if (size.w > 0 && size.h > 0) {
      stageRef.current?.batchDraw()
      layerRef.current?.batchDraw()
      trRef.current?.getLayer()?.batchDraw()
    }
  }, [size])

  // привязка трансформера к выделению (картинки/видео/текст — у всех есть
  // onTransformEnd, пересчитывающий scale в w/h без деформации содержимого)
  const selKey = [...selected].sort().join(',')
  useEffect(() => {
    const tr = trRef.current
    const layer = layerRef.current
    if (!tr || !layer) return
    if (!interactive || !editableSelection) {
      tr.nodes([])
      return
    }
    // ⚠️ Один обход слоя на все выделенные, а не обход на каждый: эффект
    // перезапускается на каждую чужую правку (меняются items), и при трёх
    // сотнях выделенных объектов это были сотни тысяч посещённых узлов на
    // правку коллеги — 7–23 мс (пункт 3.8, находка С-8).
    const wanted = new Set([...selected].filter((id) => id !== editingTextId))
    const byId = new Map<string, Konva.Node>()
    if (wanted.size > 0) {
      for (const node of layer.find((n: Konva.Node) => wanted.has(n.id()))) {
        if (!byId.has(node.id())) byId.set(node.id(), node)
      }
    }
    const nodes = [...wanted].flatMap((id) => {
      const node = byId.get(id)
      return node ? [node] : []
    })
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, items, pending, interactive, editableSelection, store, editingTextId])

  function viewportCenterWorld(): { x: number; y: number } {
    const c = cameraRef.current
    return { x: (size.w / 2 - c.x) / c.scale, y: (size.h / 2 - c.y) / c.scale }
  }

  function pointerWorld(): { x: number; y: number } | undefined {
    const stage = stageRef.current
    return pointerToWorld(stage?.getPointerPosition() ?? null, cameraRef.current)
  }

  function clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }
    const rect = stage.container().getBoundingClientRect()
    const c = cameraRef.current
    return { x: (clientX - rect.left - c.x) / c.scale, y: (clientY - rect.top - c.y) / c.scale }
  }

  function publishCanvasCursor(_point: { x: number; y: number } | null): void {}

  // Мышь сохраняет прежний ступенчатый зум. В режиме тачпада обычный wheel
  // панорамирует двумя пальцами, а браузерный ctrl+wheel (pinch) плавно зумит.
  function onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    if (!wheelGestureActiveRef.current) {
      wheelGestureActiveRef.current = true
      wheelRenderedCameraRef.current = store.getCamera()
      contentGroupRef.current?.listening(false)
      store.noteManualCameraInteraction()
    }
    const c = cameraRef.current
    const rect = stage.container().getBoundingClientRect()
    const pointer = stage.getPointerPosition() ?? { x: e.evt.clientX - rect.left, y: e.evt.clientY - rect.top }
    const newCamera = nextCameraFromWheel(c, pointer, e.evt, navigationMode)
    cameraRef.current = newCamera
    wheelPreviewCameraRef.current = newCamera
    if (wheelRedrawRafRef.current === null) {
      wheelRedrawRafRef.current = requestAnimationFrame(() => {
        wheelRedrawRafRef.current = null
        drawWheelPreviewNow()
      })
    }

    // Usually React does no work until the gesture ends. On a long zoom-out we
    // rebase only when the true viewport leaves the padded culling guard, so
    // newly exposed objects appear without returning to 20 commits per second.
    const renderedCamera = wheelRenderedCameraRef.current
    if (renderedCamera && shouldRebaseCanvasView(
      renderedCamera,
      newCamera,
      size,
      canvasCullPadding(renderedCamera.scale),
    )) {
      wheelRenderedCameraRef.current = newCamera
      store.setCamera(newCamera)
    }

    if (wheelEndTimerRef.current !== null) window.clearTimeout(wheelEndTimerRef.current)
    wheelEndTimerRef.current = window.setTimeout(finishWheelGesture, WHEEL_GESTURE_END_MS)
  }

  function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
    setMenu(null)
    const activeEl = document.activeElement
    if (activeEl && activeEl.tagName === 'TEXTAREA' && activeEl.closest('.prompt-bar')) {
      promptBlurringClick.current = true
    } else {
      promptBlurringClick.current = false
    }
    // средняя кнопка — панорама из любого места
    if (e.evt.button === 1) {
      e.evt.preventDefault()
      store.noteManualCameraInteraction()
      const c = cameraRef.current
      midPan.current = { px: e.evt.clientX, py: e.evt.clientY, camX: c.x, camY: c.y }
      return
    }
    if (readOnly) return
    if (sketching) {
      drawing.current = true
      const w = pointerWorld()
      if (!w) return
      store.startStroke(brush.color, brush.size, w.x, w.y, brush.tool)
      return
    }

    // рамка выделения: левая кнопка по пустому месту (не Space-панорама).
    // В режиме набора сравнения её нет: промах мимо картинки не должен
    // обнулять уже набранное (marqueeStart остаётся null → clearSelection
    // в handleWindowMouseUp не вызовется)
    if (!cropping && !comparePicking && !spaceHeld && e.evt.button === 0 && e.target === stageRef.current) {
      marqueeStart.current = pointerWorld() ?? null
    }
  }

  // Глобальные обработчики для плавного перетаскивания и рисования за пределами канваса/над оверлеями
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (midPan.current) {
        const c = cameraRef.current
        updateCameraThrottled({
          scale: c.scale,
          x: midPan.current.camX + (e.clientX - midPan.current.px),
          y: midPan.current.camY + (e.clientY - midPan.current.py),
        })
        return
      }
      if (sketching && drawing.current) {
        const w = clientToWorld(e.clientX, e.clientY)
        store.extendStroke(w.x, w.y)
        return
      }
      if (marqueeStart.current) {
        const s = marqueeStart.current
        const p = clientToWorld(e.clientX, e.clientY)
        updateMarqueeThrottled({
          x: Math.min(s.x, p.x),
          y: Math.min(s.y, p.y),
          w: Math.abs(p.x - s.x),
          h: Math.abs(p.y - s.y),
        })
      }
    }

    const handleWindowMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        midPan.current = null
        commitCameraNow()
      }
      if (e.button === 0) {
        drawing.current = false
        if (marqueeStart.current) {
          const s = marqueeStart.current
          const p = clientToWorld(e.clientX, e.clientY)
          const rect = {
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            w: Math.abs(p.x - s.x),
            h: Math.abs(p.y - s.y),
          }
          if (rect.w > 3 || rect.h > 3) {
            // ⚠️ Порядок — «как читают» (сверху вниз, слева направо), а НЕ
            // порядок появления объектов в холсте. Из этого порядка берутся
            // номера референсов @1/@2, и человек ждёт, что первым будет левый
            // (жалоба 27.08.2026). Выбор поштучно клавишами/кликом порядок не
            // меняет — там его назначил сам человек.
            const hit = readingOrder(
              store.getSelectableItems().filter((i) => rectIntersects(rect, itemAabb(i))),
            ).map((i) => i.id)
            if (e.shiftKey) {
              const merged = new Set([...store.getSelectedIds(), ...hit])
              store.setSelection([...merged])
            } else {
              store.setSelection(hit)
            }
            // ⚠️ Метки и стикеры живут в СВОЁМ слое поверх Konva и в
            // getSelectableItems не входят: обведёшь несколько значков — не
            // выделится ни один (жалоба 09.09.2026). Сообщаем рамку слою
            // меток, он сам решит, что в неё попало.
            publishBoardMarquee({ ...rect, add: e.shiftKey })
          } else {
            // Клик по пустому месту холста
            if (!promptBlurringClick.current) {
              store.clearSelection()
            }
          }
          marqueeStart.current = null
          finishMarquee()
        }
        promptBlurringClick.current = false
      }
    }

    const handleWindowBlur = () => {
      cancelActiveCanvasDrag(store)
      store.setGuides([])
      store.getCollaboration()?.setPreview(null)
      publishCanvasCursor(null)
      if (stagePanActiveRef.current) {
        stagePanActiveRef.current = false
        stageRef.current?.stopDrag()
        store.setCamera(cameraRef.current)
      }
      midPan.current = null
      drawing.current = false
      marqueeStart.current = null
      finishMarquee()
    }

    window.addEventListener('mousemove', handleWindowMouseMove)
    window.addEventListener('mouseup', handleWindowMouseUp)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove)
      window.removeEventListener('mouseup', handleWindowMouseUp)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [sketching, store])

  function onContextMenu(e: Konva.KonvaEventObject<PointerEvent>): void {
    e.evt.preventDefault()
    if (!interactive) return
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const x = e.evt.clientX - rect.left
    const y = e.evt.clientY - rect.top

    // ищем объект под курсором по id Konva-нод (сами фигуры и их группы)
    let node: Konva.Node | null = e.target === stageRef.current ? null : e.target
    let itemId: string | null = null
    while (node) {
      const id = node.id()
      if (id && store.getItem(id)) {
        itemId = id
        break
      }
      node = node.getParent()
    }
    if (itemId && !store.getSelectedIds().has(itemId)) store.select(itemId)
    const c = cameraRef.current
    const world = { x: (x - c.x) / c.scale, y: (y - c.y) / c.scale }
    setMenu({ x, y, itemId, world })
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    if (readOnly) return
    const stage = stageRef.current
    stage?.setPointersPositions(e as unknown as Event)
    const world = pointerWorld() ?? viewportCenterWorld()
    startImportBatch(Array.from(e.dataTransfer.files), world)
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!visible || readOnly) return
      const target = e.target as HTMLElement | null

      const mediaFiles = mediaFilesFromClipboard(e.clipboardData)
      const text = e.clipboardData?.getData('text') ?? ''
      const systemClipboard = canvasClipboardFromSystem(text)
      const systemCanvasItems = systemClipboard.items
      syncInternalClipboardFromSystem(text)
      const choice = decidePaste({
        hasMediaFiles: mediaFiles.length > 0,
        focusInInput: Boolean(
          target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
        ),
        clipboardText: text,
        hasInternalItems: systemCanvasItems.length > 0 || hasClipboard(),
        mirrorFailed: clipboardMirrorFailed(),
      })

      // Макрос в буфере — дело ряда макросов (useMacroClipboard), а не холста:
      // раньше Ctrl+V с макросом в буфере клал на доску его JSON текстовым
      // объектом. Чей ход, решает macroPasteRoute; файлы из буфера и поле
      // ввода он оставляет как были.
      const macroRoute = routeMacroPaste({
        macroInClipboard: isMacroText(text),
        choice,
        overMacroRow: macroRowHovered(),
      })
      if (macroRoute !== 'canvas') {
        // Своя копия объектов свежее макроса, оставшегося в системном буфере, —
        // вставляем её, как вставили бы при любом постороннем тексте там.
        if (macroRoute === 'objects' && canvasPasteArbiter.settle(false)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        canvasPasteArbiter.cancel()
        // Курсор над рядом макросов — вставит ряд. Иначе вставлять нечего, и
        // молчать нельзя: человек не знает, куда вести курсор.
        if (macroRoute !== 'row') {
          notify({ kind: 'info', message: t(MACRO_PASTE_HINT), replaceKey: 'macro-paste-hint' })
        }
        return
      }

      if (choice === 'media') {
        canvasPasteArbiter.settle(true)
        e.preventDefault()
        e.stopPropagation()
        const c = cameraRef.current
        const world = { x: (size.w / 2 - c.x) / c.scale, y: (size.h / 2 - c.y) / c.scale }
        startImportBatch(mediaFiles, world)
        return
      }

      // фокус в поле ввода — вставляет браузер, холст не вмешивается
      if (choice === 'input') {
        canvasPasteArbiter.cancel()
        return
      }

      // Внешняя копия свежее внутреннего буфера — отменяем вставку объектов,
      // иначе давнее Ctrl+C по холсту навсегда перебивало бы вставку текста.
      if (choice === 'text') {
        canvasPasteArbiter.cancel()
        e.preventDefault()
        e.stopPropagation()
        const world = pointerWorld() ?? viewportCenterWorld()
        const pasted = classifyCanvasTextPaste(text)
        if (pasted.kind === 'link') void mediaLinkController.previewPastedLink(store, pasted.url, world)
        else store.placeText(pasted.text, world)
        return
      }

      if (choice === 'internal') {
        if (systemCanvasItems.length > 0) {
          canvasPasteArbiter.settle(true)
          e.preventDefault()
          e.stopPropagation()
          // ⚠️ Через общую дверь, а не прямо в стор: на сетевой доске файлы
          // сперва переезжают на сервер команды, иначе вставятся призраки
          // (см. pasteCanvasItems). Место берём СЕЙЧАС — перенос файлов
          // занимает время, а указатель за это время уедет.
          void pasteCanvasItems(store, systemCanvasItems, pointerWorld() ?? viewportCenterWorld(), size, {
            origin: systemClipboard.origin,
          })
          return
        }
        if (canvasPasteArbiter.settle(false)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        // Запланированной вставки нет: это paste БЕЗ Ctrl+V (меню браузера,
        // средняя кнопка). Внутренний буфер сюда не относится — если пришёл
        // текст, кладём его на холст, как было раньше.
        if (text.trim()) {
          e.preventDefault()
          e.stopPropagation()
          const world = pointerWorld() ?? viewportCenterWorld()
          const pasted = classifyCanvasTextPaste(text)
          if (pasted.kind === 'link') void mediaLinkController.previewPastedLink(store, pasted.url, world)
          else store.placeText(pasted.text, world)
        }
        return
      }

      canvasPasteArbiter.cancel()
    }
    window.addEventListener('paste', onPaste, { capture: true })
    return () => window.removeEventListener('paste', onPaste, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, store, visible, readOnly])

  // «Добавить картинку/видео» из контекстного меню пустого места: запоминаем
  // точку клика и открываем нативный файловый диалог
  function requestAddMedia(kind: 'image' | 'video', world: { x: number; y: number }): void {
    importAt.current = world
    ;(kind === 'image' ? imageInputRef : videoInputRef).current?.click()
  }

  function onMediaPicked(e: React.ChangeEvent<HTMLInputElement>): void {
    const world = importAt.current ?? pointerWorld() ?? viewportCenterWorld()
    const files = e.target.files
    if (files) startImportBatch(Array.from(files), world)
    e.target.value = ''
  }

  // «Добавить текст»: пустая карточка в точке клика, сразу открываем инлайн-
  // редактор; если закрыть без ввода — closeTextEdit уберёт пустышку
  function addTextAt(world: { x: number; y: number }): void {
    const id = store.placeText('', world)
    void store.withSelection([id], () => setEditingTextId(id))
  }

  function onMenuAdd(kind: 'image' | 'video' | 'text', world: { x: number; y: number }): void {
    if (kind === 'text') addTextAt(world)
    else requestAddMedia(kind, world)
  }

  function closeTextEdit(id: string): void {
    if (!store.getItem(id)?.text?.trim()) store.removeItems([id])
    setEditingTextId(null)
  }

  // одиночное выделение картинки/видео → плавающее меню; групповое (2+) →
  // компактный тулбар с массовым скачиванием, над общим bbox выделения
  const sel = store.getRenderableSelectedItems()
  const solo = sel.length === 1 && isItemToolbarEligible(sel[0]) ? sel[0] : null
  const selectionBox = sel.length > 1 ? selectionTopBounds(sel) : null
  const transformAnchors = sel.length === 1 && sel[0].kind === 'text' ? TEXT_ANCHORS : CORNER_ANCHORS
  const cropItem = cropTarget ? store.getItem(cropTarget) : null
  const cropSession = cropItem ? cropSessionForItem(cropItem) : null
  const cropDisplayItem = cropSession?.item ?? null
  const sketchTarget = sketching ? store.getItem(getSketchTarget() ?? '') : null
  const editingText = editingTextId ? store.getItem(editingTextId) : null
  // Сколько объектов держит трансформер: у одного — только кольцо, у группы —
  // ещё и общая рамка (редактируемый текст трансформер не цепляет).
  const transformedCount = [...selected].filter((id) => id !== editingTextId).length

  // Культинг: запас зависит от масштаба. На fit-to-board не раздуваем мировую
  // область до четырёх viewport'ов, но при обычном масштабе сохраняем прежний
  // запас для плавного панорамирования.
  // (выделенное — всегда: к нему привязаны Transformer и тулбар).
  // Konva не отсекает сам: без этого сотни фигур рисуются на каждый кадр.
  const hasSize = size.w > 0 && size.h > 0
  const cullPadding = canvasCullPadding(cam.scale)
  const view = canvasViewForCamera(cam, size, cullPadding)
  const visibleItems = hasSize
    ? visibleCanvasEntries(renderItems, view, selected, itemAabb)
    : renderItems
  const visiblePending = hasSize
    ? visibleCanvasEntries(pending, view, selected)
    : pending
  const hasOverlayLayer = Boolean(sketchTarget) || strokes.length > 0
    || guides.length > 0
    || Boolean(marquee || (cropItem && cropRect) || comparePicking)

  async function applyCropNow(): Promise<void> {
    if (!cropItem || !cropRect || cropBusy) return
    if (!store.canMutateItems([cropItem.id])) return
    setCropBusy(true)
    const failed = (err: unknown) => {
      console.warn('[CanAI] crop failed:', err)
      notify({ kind: 'error', message: err instanceof Error ? err.message : t('Failed to apply crop') })
    }
    try {
      // Режим закрывается, как только кусок вырезан; файл едет фоном на
      // карточке с процентами (пункт 3.6).
      await applyCropInBackground(store, cropDisplayItem ?? cropItem, cropRect, boardMediaUploader(projectRef), failed)
      setCropTarget(null)
    } catch (err) {
      failed(err)
    } finally {
      setCropBusy(false)
    }
  }

  const cursor = spaceHeld ? 'grab' : sketching ? 'crosshair' : 'default'
  const stageCamera = canvasRenderCamera(
    cam,
    cameraRef.current,
    wheelGestureActiveRef.current
      || stagePanActiveRef.current
      || midPan.current !== null
      || nextCam.current !== null,
  )

  return (
    <div
      ref={wrapRef}
      className="konva-wrap"
      tabIndex={0}
      style={{ outline: 'none' }}
      onMouseDown={(e) => {
        // Не перехватываем фокус, если кликнули в текстовое поле ввода или оверлей редактирования
        const target = e.target as HTMLElement | null
        if (target && (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(target.tagName) || target.isContentEditable)) return
        // Фокусируемся на холсте при клике по нему, чтобы хоткеи и вставка (Ctrl+V) шли на холст
        wrapRef.current?.focus({ preventScroll: true })
      }}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={stageCamera.x}
        y={stageCamera.y}
        scaleX={stageCamera.scale}
        scaleY={stageCamera.scale}
        draggable={spaceHeld && !sketching}
        onWheel={onWheel}
        onMouseMove={() => publishCanvasCursor(stageRef.current?.getPointerPosition() ?? null)}
        /* ⚠️ Уход указателя с холста НЕ гасит курсор у коллег. Промпт-бар,
           полка ассетов, шапка — всё это свой интерфейс поверх той же доски,
           и стоит человеку туда заехать, как его курсор пропадал у всех:
           «сбивает» (жалоба 08.09.2026). Курсор остаётся там, где его
           оставили, — это честно: человек всё ещё на доске. Гасим его только
           когда он с доски УШЁЛ: вкладка спрятана (setVisible), окно
           потеряло фокус или холст размонтирован. */
        onMouseDown={onStageMouseDown}
        onDragStart={(e) => {
          if (e.target === stageRef.current) {
            stagePanActiveRef.current = true
            store.noteManualCameraInteraction()
          }
        }}
        onDragMove={(e) => {
          const stage = stageRef.current
          if (e.target !== stage || !stage) return
          cameraRef.current = { scale: stage.scaleX(), x: stage.x(), y: stage.y() }
          publishAnnotationCamera(cameraRef.current)
          follow.publishCamera(cameraRef.current)
        }}
        onDragEnd={(e) => {
          const stage = stageRef.current
          if (e.target !== stage || !stage) return
          cameraRef.current = { scale: stage.scaleX(), x: stage.x(), y: stage.y() }
          stagePanActiveRef.current = false
          store.setCamera(cameraRef.current)
        }}
        onContextMenu={onContextMenu}
        style={{ cursor }}
      >
        {/* слой контента: только видимые фигуры (культинг) */}
        <Layer ref={layerRef}>
          <Group ref={contentGroupRef} listening={interactive && !spaceHeld}>
            {visibleItems.map((item) => {
              // GIF — картинка с плеером, как у видео (GifItem).
              if (item.kind === 'image' && isAnimatedImageItem(item)) return (
                <GifItem
                  key={item.id}
                  item={item.id === cropTarget && cropDisplayItem ? cropDisplayItem : item}
                  store={store}
                  draggable={canDragItem(item.id)}
                  selected={selected.has(item.id)}
                  persistNaturalSize={item.id !== cropTarget}
                  viewScale={previewScale}
                />
              )
              if (item.kind === 'image') return (
                <ImageItem
                  key={item.id}
                  item={item.id === cropTarget && cropDisplayItem ? cropDisplayItem : item}
                  store={store}
                  draggable={canDragItem(item.id)}
                  selected={selected.has(item.id)}
                  persistNaturalSize={item.id !== cropTarget}
                  viewScale={previewScale}
                />
              )
              if (item.kind === 'video') return <VideoItem key={item.id} item={item} store={store} draggable={canDragItem(item.id)} selected={selected.has(item.id)} viewScale={previewScale} />
              if (item.kind === 'audio') return <AudioItem key={item.id} item={item} store={store} draggable={canDragItem(item.id)} selected={selected.has(item.id)} />
              if (item.kind === 'link') return <LinkItem key={item.id} item={item} store={store} projectId={projectId} draggable={canDragItem(item.id)} selected={selected.has(item.id)} />
              return (
                <TextItem
                  key={item.id}
                  item={item}
                  store={store}
                  draggable={canDragItem(item.id)}
                  isEditing={editingTextId === item.id}
                  onEditText={(id) => {
                    void store.withSelection([id], () => setEditingTextId(id))
                  }}
                />
              )
            })}
            {/* карточки-заглушки будущих результатов (спиннеры/ошибки) */}
            {visiblePending.map((p) => (
              <PendingItem key={p.id} p={p} store={store} draggable={canDragItem(p.id)} selected={selected.has(p.id)} viewScale={previewScale} />
            ))}
          </Group>
        </Layer>

        {/* слой оверлеев: штрихи скетча, рамка, кроп — их перерисовка не
            трогает канвас со всеми картинками (это отдельный <canvas>) */}
        {hasOverlayLayer && <Layer listening={cropping}>
          {strokes.map((s, i) => (
            <Line
              key={i}
              points={s.points}
              stroke={s.color}
              strokeWidth={s.size}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation={s.tool === 'erase' ? 'destination-out' : 'source-over'}
              listening={false}
            />
          ))}
          {sketchTarget && (
            <Rect
              x={sketchTarget.x}
              y={sketchTarget.y}
              width={sketchTarget.w}
              height={sketchTarget.h}
              stroke="#e0554e"
              strokeWidth={2 / cam.scale}
              dash={[8 / cam.scale, 6 / cam.scale]}
              listening={false}
            />
          )}
          {/* смарт-гайды выравнивания при перетаскивании */}
          {guides.map((g, i) => (
            <Line
              key={`guide-${i}`}
              points={g}
              stroke="#d33f21"
              strokeWidth={1 / cam.scale}
              dash={[4 / cam.scale, 4 / cam.scale]}
              listening={false}
            />
          ))}
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill="rgba(211, 63, 33, 0.08)"
              stroke="#d33f21"
              strokeWidth={1 / cam.scale}
              listening={false}
            />
          )}
          {cropDisplayItem && cropRect && (
            <CropOverlay item={cropDisplayItem} rect={cropRect} ratio={cropRatio} scale={cam.scale} onRect={setCropRect} />
          )}
          {comparePicking && (
            <CompareMarks session={comparePicking} items={visibleItems} scale={cam.scale} />
          )}
        </Layer>}

        <GenerationFocusOverlay store={store} scale={cam.scale} />

        {/* слой трансформера: выделение поверх всего — кольца и ручки */}
        {interactive && editableSelection && selected.size > 0 && (
          <Layer>
            <SelectionRings transformer={trRef} />
            <Transformer
              ref={trRef}
              keepRatio={true}
              enabledAnchors={transformAnchors}
              rotateEnabled={false}
              flipEnabled={false}
              // ⚠️ Рамка выделения лежит РОВНО на крае объекта, а не снаружи
              // его обводки: иначе Konva мерит объект вместе с толщиной
              // рамки, и красная линия отходила от кадра (жалоба 30.09.2026).
              ignoreStroke
              // ⚠️ Выделение — скруглённое кольцо с зазором (SelectionRings),
              // а не квадрат Konva: квадрат не повторял скругление объекта
              // (решение пользователя 30.09.2026). Свою рамку трансформер
              // рисует только у группы — тонкую и тихую, это общая рамка,
              // за которую тянут всю группу; ручки стоят на углах колец.
              borderEnabled={transformedCount > 1}
              borderStroke={SELECTION_GROUP_COLOR}
              padding={selectionPadding(transformedCount)}
              anchorStroke={SELECTION_COLOR}
              anchorFill="#ffffff"
              anchorSize={9}
              anchorCornerRadius={9 / 2}
              // ⚠️ Зона ПОПАДАНИЯ ручки шире самой ручки. Замер 20.09.2026:
              // девятипиксельный квадрат ловит нажатие в ±3 px от центра, и
              // промах на четыре пикселя уходил в пустой холст — то есть
              // начинал рамку выделения и СТИРАЛ выделение целиком. На мелком
              // выделении попасть было почти нельзя: человек тянул угол и
              // каждый раз терял всё, что набрал (жалоба 19.09.2026 с записью
              // экрана, «не хочет увеличивать»). После правки ловится ±14 px,
              // вид ручки прежний — растить её на экране незачем.
              anchorStyleFunc={(anchor) => { anchor.hitStrokeWidth(ANCHOR_HIT_STROKE) }}
              boundBoxFunc={(oldBox, newBox) => (newBox.width < 20 || newBox.height < 20 ? oldBox : newBox)}
            />
          </Layer>
        )}
      </Stage>

      <CanvasCorner
        store={store}
        viewport={size}
        showNavigator={visible && !sketching && !cropping}
        dockBottomReserve={cornerDockReserve}
      />

      <GenerationSeriesCues cues={cues} onShow={showSeries} />

      {solo && interactive && editableSelection && (
        <ItemToolbar
          item={solo}
          store={store}
          onEdit={(id) => {
            const item = store.getItem(id)
            if (item?.src) requestImageEdit({ shapeId: id, src: item.src, name: item.name || 'image' })
          }}
          onSketch={(id) => setSketchTarget(id)}
          onCrop={(id) => setCropTarget(id)}
        />
      )}

      {selectionBox && interactive && editableSelection && (
        <SelectionToolbar
          items={sel}
          store={store}
          box={{ x: selectionBox.x, y: selectionBox.y, right: selectionBox.right, bottom: selectionBox.bottom }}
        />
      )}

      {sketching && (
        <SketchPalette
          brush={brush}
          onBrush={setBrush}
          busy={sketchBusy}
          canUndo={store.canUndoStroke()}
          canRedo={store.canRedoStroke()}
          onUndo={() => store.undoStroke()}
          onRedo={() => store.redoStroke()}
          onCancel={onSketchCancel}
          onDone={onSketchDone}
        />
      )}

      {cropping && cropDisplayItem && (
        <CropToolbar
          ratio={cropRatio}
          busy={cropBusy}
          onRatio={(r) => {
            setCropRatio(r)
            setCropRect(centeredRect({ w: cropDisplayItem.w, h: cropDisplayItem.h }, r))
          }}
          onApply={() => void applyCropNow()}
          onCancel={() => setCropTarget(null)}
        />
      )}

      {menu && (
        <ContextMenu store={store} menu={menu} viewport={size} onAdd={onMenuAdd} onClose={() => setMenu(null)} />
      )}

      {editingText && (
        <TextEditOverlay store={store} item={editingText} onClose={() => closeTextEdit(editingText.id)} />
      )}

      {/* скрытые файловые диалоги для «Добавить картинку/видео» из контекстного меню */}
      <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={onMediaPicked} />
      <input ref={videoInputRef} type="file" accept="video/*" multiple hidden onChange={onMediaPicked} />

      {(() => {
        if (!visible) return null
        return exportPortal
          ? createPortal(<ExportButton items={items} project={projectRef} />, exportPortal)
          : null
      })()}
    </div>
  )
}
