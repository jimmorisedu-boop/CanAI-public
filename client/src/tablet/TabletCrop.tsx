import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { applyCropInBackground } from '../spaces/canvas/konva/cropApply'
import { notify } from '../spaces/canvas/notifications'
import {
  RATIO_PRESETS,
  centeredRect,
  clampMove,
  resizeFromCorner,
  resizeFromEdge,
  type Rect,
} from '../spaces/canvas/konva/cropMath'
import { cropSessionForItem } from '../spaces/canvas/konva/cropState'
import { TabletFullScreen } from './TabletFullScreen'
import { confirmDiscardDraft } from './confirmDiscardDraft'
import { CropFields } from './CropFields'
import { CROP_HANDLE_SAFE_MARGIN, fitCropPreview } from './cropViewModel'
import { InlineNotice } from '../ui/InlineNotice'
import { previewSrc } from './remoteSession'
import { tabletSystemMessage } from './tabletSystemMessage'
import type { TabletMediaUploader } from './runtime'
import type { CanvasItem } from '../spaces/canvas/konva/types'

// Обрезка картинки пальцем.
//
// Математика ОБЩАЯ с компьютером (cropMath) — иначе пропорции и минимальный
// размер разошлись бы между устройствами. Планшетное здесь только управление:
// ручки крупные и вынесены ЗА кромку кадра, чтобы палец не закрывал ровно то
// место, которое кадрируешь.

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e'
const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se']
const EDGES: Handle[] = ['n', 's', 'w', 'e']

export function tabletCropModelForItem(sourceItem: CanvasItem | undefined): {
  item: CanvasItem | undefined
  bounds: { w: number; h: number }
  initialRect: Rect
} {
  const cropSession = sourceItem ? cropSessionForItem(sourceItem) : null
  const item = cropSession?.item
  const bounds = { w: item?.w ?? 1, h: item?.h ?? 1 }
  return {
    item,
    bounds,
    initialRect: cropSession?.savedRect ?? centeredRect(bounds, null),
  }
}

export function TabletCrop({
  store,
  itemId,
  upload,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  upload: TabletMediaUploader
  onClose(): void
}) {
  const sourceItem = store.getItem(itemId)
  // Метаданные кропа хранят неизменяемый исходник и прежнюю рамку. Каждую
  // сессию открываем на этом исходнике, чтобы повторный кроп (в том числе
  // после перезагрузки) снова показывал весь оригинал.
  const cropModel = tabletCropModelForItem(sourceItem)
  const item = cropModel.item
  const bounds = cropModel.bounds
  const initialRect = cropModel.initialRect
  const [ratio, setRatio] = useState<number | null>(null)
  const [rect, setRect] = useState<Rect>(() => initialRect)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [viewZoom, setViewZoom] = useState(1)
  const drag = useRef<{ id: number; handle: Handle | 'move'; from: { x: number; y: number }; start: Rect; target: HTMLElement } | null>(null)
  const busyRef = useRef(false)
  const discardPromptRef = useRef(false)

  // Кадр вписываем в рабочую область сами: элементу <img> нельзя доверить
  // раскладку, по которой считается рамка (на компьютере эта же ошибка уже
  // стоила растянутого превью в таймлайне).
  useLayoutEffect(() => {
    const node = stageRef.current
    if (!node) return
    const measure = () => {
      const style = window.getComputedStyle(node)
      const px = (value: string) => Number.parseFloat(value) || 0
      const horizontalPadding = px(style.paddingLeft) + px(style.paddingRight)
      const verticalPadding = px(style.paddingTop) + px(style.paddingBottom)
      const boxW = node.clientWidth - horizontalPadding
      const boxH = node.clientHeight - verticalPadding
      if (boxW < 2 || boxH < 2) return
      setViewport({ w: boxW, h: boxH })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [bounds.w, bounds.h])

  const display = fitCropPreview(bounds, viewport, CROP_HANDLE_SAFE_MARGIN, viewZoom)

  const pointOf = useCallback((event: ReactPointerEvent): { x: number; y: number } => {
    const frame = stageRef.current?.querySelector('.tablet-crop-frame')?.getBoundingClientRect()
    return {
      x: (event.clientX - (frame?.left ?? 0)) / (display.scale || 1),
      y: (event.clientY - (frame?.top ?? 0)) / (display.scale || 1),
    }
  }, [display.scale])

  if (!item) return null

  const startDrag = (handle: Handle | 'move') => (event: ReactPointerEvent) => {
    event.stopPropagation()
    if (busyRef.current || drag.current || event.button !== 0) return
    event.preventDefault()
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      // Захват — удобство, а не условие: жест обязан работать и без него.
    }
    drag.current = { id: event.pointerId, handle, from: pointOf(event), start: rect, target: event.currentTarget as HTMLElement }
  }

  const onMove = (event: ReactPointerEvent) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const point = pointOf(event)
    if (current.handle === 'move') {
      setRect(clampMove({
        ...current.start,
        x: current.start.x + (point.x - current.from.x),
        y: current.start.y + (point.y - current.from.y),
      }, bounds))
      return
    }
    // Keep the point grabbed within the 44px hit area under the finger.
    // Absolute pointer coordinates otherwise make the frame jump on contact.
    point.x = current.start.x + (current.handle.includes('e') ? current.start.w : 0) + point.x - current.from.x
    point.y = current.start.y + (current.handle.includes('s') ? current.start.h : 0) + point.y - current.from.y
    if (CORNERS.includes(current.handle)) {
      // Pointer coordinates are absolute within the image. Always resolve the
      // frame from the geometry captured at pointerdown; using the last React
      // render here makes a rapid sequence of pointermoves depend on render
      // timing and can make the opposite corner drift.
      setRect(resizeFromCorner(current.start, current.handle as 'nw' | 'ne' | 'sw' | 'se', point, bounds, ratio))
      return
    }
    setRect(resizeFromEdge(current.start, current.handle as 'n' | 's' | 'w' | 'e', point, bounds))
  }

  const endDrag = (event: ReactPointerEvent) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    if (event.type === 'pointerup') onMove(event)
    drag.current = null
    try { current.target.releasePointerCapture(current.id) } catch { /* already released */ }
  }

  const apply = async () => {
    // ⚠️ Замок синхронный (ref), а не на состоянии: состояние доезжает лишь на
    // следующий рендер, и два быстрых нажатия успевали пройти оба — на
    // компьютере это уже давало две копии каждого куска.
    if (busyRef.current) return
    const full = rect.x <= 0.5 && rect.y <= 0.5 && rect.w >= bounds.w - 1 && rect.h >= bounds.h - 1
    // В первой сессии полная рамка уже является текущим исходником — upload не
    // нужен. При повторном кропе полная рамка означает «вернуть оригинал» и
    // должна пройти через applyCrop.
    if (full && !item.crop) {
      onClose()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      // Кусок вырезан — экран закрывается, файл едет фоном на карточке с
      // процентами (пункт 3.6). Сбой загрузки после закрытия — всплывашкой.
      await applyCropInBackground(store, item, rect, upload, (failure) => {
        notify({ kind: 'error', message: tabletSystemMessage(failure, 'Could not crop') })
      })
      onClose()
    } catch (error) {
      setError(tabletSystemMessage(error, 'Could not crop'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const close = async (baseline: Rect = { x: 0, y: 0, w: bounds.w, h: bounds.h }) => {
    if (busyRef.current || discardPromptRef.current) return
    const dirty = rect.x !== baseline.x || rect.y !== baseline.y || rect.w !== baseline.w || rect.h !== baseline.h
    if (!dirty) {
      onClose()
      return
    }
    discardPromptRef.current = true
    try {
      if (await confirmDiscardDraft(true)) onClose()
    } finally {
      discardPromptRef.current = false
    }
  }

  return (
    <TabletFullScreen
      title="Crop"
      onCancel={() => void close(initialRect)}
      tone="dark"
      center={
        <div className="tablet-crop-controls">
          <div className="ui-toggle" role="group" aria-label="Aspect ratio">
            {RATIO_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={ratio === preset.value ? 'on' : ''}
                aria-pressed={ratio === preset.value}
                onClick={() => {
                  setRatio(preset.value)
                  setRect(centeredRect(bounds, preset.value))
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="tablet-crop-view-controls" role="group" aria-label="Preview zoom">
            <button
              type="button"
              className="ui-icon-btn"
              aria-label="Zoom preview out"
              disabled={display.zoom <= 0.5}
              onClick={() => setViewZoom((value) => Math.max(0.5, value / 1.25))}
            >−</button>
            <span className="tablet-zoom-value" aria-live="polite">{Math.round(display.zoom * 100)} %</span>
            <button
              type="button"
              className="ui-icon-btn"
              aria-label="Zoom preview in"
              disabled={display.zoom >= 1}
              onClick={() => setViewZoom((value) => Math.min(1, value * 1.25))}
            >+</button>
            <button type="button" className="ui-btn quiet" onClick={() => setViewZoom(1)}>Fit</button>
          </div>
        </div>
      }
      primary={
        <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Cropping…' : 'Apply'}
        </button>
      }
      footer={
        <>
          <details className="tablet-crop-precise">
            <summary>Exact dimensions</summary>
            <CropFields rect={rect} bounds={bounds} ratio={ratio} disabled={busy} onChange={setRect} />
          </details>
          <span className="tablet-full-gap" />
          <span className="tablet-hint">One undo step restores the entire frame</span>
        </>
      }
    >
      {error && <InlineNotice className="tablet-error" tone="error" title={tabletSystemMessage(error, 'Could not crop')} onDismiss={() => setError(null)} />}
      <div className="tablet-crop-stage" ref={stageRef}>
        <div
          className="tablet-crop-frame"
          style={{ width: display.w, height: display.h }}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          <img src={previewSrc(item.src ?? '')} alt="" draggable={false} />
          <div className="tablet-crop-shade" />
          <div
            className="tablet-crop-window"
            style={{
              left: rect.x * display.scale,
              top: rect.y * display.scale,
              width: rect.w * display.scale,
              height: rect.h * display.scale,
            }}
            onPointerDown={startDrag('move')}
          >
            <div className="tablet-crop-preview-clip"><img
              src={previewSrc(item.src ?? '')}
              alt=""
              draggable={false}
              style={{
                width: display.w,
                height: display.h,
                marginLeft: -rect.x * display.scale,
                marginTop: -rect.y * display.scale,
              }}
            /></div>
            <span className="tablet-crop-thirds" aria-hidden="true" />
            {CORNERS.map((corner) => (
              <span
                key={corner}
                className={`tablet-crop-handle ${corner}`}
                onPointerDown={startDrag(corner)}
                role="presentation"
              />
            ))}
            {!ratio && EDGES.map((edge) => (
              <span
                key={edge}
                className={`tablet-crop-edge ${edge}`}
                onPointerDown={startDrag(edge)}
                role="presentation"
              />
            ))}
          </div>
        </div>
      </div>
    </TabletFullScreen>
  )
}
