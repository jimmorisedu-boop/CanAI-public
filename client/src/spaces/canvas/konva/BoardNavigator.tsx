import { useEffect, useMemo, useRef, useState } from 'react'
import { IconCollapse, IconMap } from '../../../ui/icons'
import type { CanvasStore } from './canvasStore'
import { itemAabb } from './geometry'
import { boardNavigatorCameraAt, boardNavigatorLayout, boardNavigatorWorldPoint } from './boardNavigatorMath'
import type { BoardNavigatorLayout } from './boardNavigatorMath'
import { useCameraVersion, useContentVersion } from './useStore'
import { useT } from '../../../i18n/context.js'


const MAP = { w: 208, h: 124 }
const SESSION_KEY = 'canai:board-navigator-collapsed'

function initiallyCollapsed(): boolean {
  try { return window.sessionStorage.getItem(SESSION_KEY) === '1' } catch { return false }
}

export function BoardNavigator({ store, viewport }: { store: CanvasStore; viewport: { w: number; h: number } }) {
  const t = useT()
  const contentVersion = useContentVersion(store)
  const cameraVersion = useCameraVersion(store)
  const [collapsed, setCollapsed] = useState(initiallyCollapsed)
  const [dragLayout, setDragLayout] = useState<BoardNavigatorLayout | null>(null)
  const activePointer = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const shapes = useMemo(() => [
    ...store.getRenderableItems().map((item) => ({ bounds: itemAabb(item), selected: store.getSelectedIds().has(item.id) })),
    ...store.getPending().map((item) => ({ bounds: { x: item.x, y: item.y, w: item.w, h: item.h }, selected: false })),
  ], [store, contentVersion])
  const camera = store.getCamera()
  const currentLayout = useMemo(
    () => boardNavigatorLayout(shapes.map((shape) => shape.bounds), camera, viewport, MAP),
    // Camera and content subscriptions make the map follow both local and network boards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shapes, cameraVersion, viewport.w, viewport.h],
  )
  const layout = dragLayout ?? currentLayout

  useEffect(() => {
    if (collapsed || !layout) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.round(MAP.w * dpr)
    canvas.height = Math.round(MAP.h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, MAP.w, MAP.h)

    const style = getComputedStyle(canvas)
    const itemColor = style.color
    const accent = style.getPropertyValue('--accent').trim() || itemColor
    for (const shape of shapes) {
      const rect = shape.bounds
      if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) continue
      ctx.globalAlpha = shape.selected ? 0.9 : 0.52
      ctx.fillStyle = shape.selected ? accent : itemColor
      ctx.fillRect(
        rect.x * layout.scale + layout.offsetX,
        rect.y * layout.scale + layout.offsetY,
        Math.max(2, rect.w * layout.scale),
        Math.max(2, rect.h * layout.scale),
      )
    }
    const view = layout.viewport
    ctx.globalAlpha = 1
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.strokeRect(
      view.x * layout.scale + layout.offsetX,
      view.y * layout.scale + layout.offsetY,
      view.w * layout.scale,
      view.h * layout.scale,
    )
  }, [collapsed, layout, shapes])

  function toggle(): void {
    const next = !collapsed
    setCollapsed(next)
    try { window.sessionStorage.setItem(SESSION_KEY, next ? '1' : '0') } catch { /* storage may be unavailable */ }
  }

  function navigate(clientX: number, clientY: number, projection: BoardNavigatorLayout): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const point = boardNavigatorWorldPoint({
      x: Math.max(0, Math.min(MAP.w, (clientX - rect.left) * MAP.w / rect.width)),
      y: Math.max(0, Math.min(MAP.h, (clientY - rect.top) * MAP.h / rect.height)),
    }, projection)
    const camera = store.getCamera()
    const next = boardNavigatorCameraAt(point, camera, viewport)
    if (camera.x === next.x && camera.y === next.y) return
    store.noteManualCameraInteraction()
    store.setCamera(next)
  }

  if (viewport.w <= 0 || viewport.h <= 0) return null
  return (
    <div className={`board-navigator${collapsed ? ' is-collapsed' : ''}`}>
      {collapsed ? (
        <button type="button" className="board-navigator-restore" onClick={toggle} aria-label={t('Show board minimap')} aria-expanded={false} title={t('Show minimap')}>
          <IconMap size={18} />
        </button>
      ) : (
        <>
          <div className="board-navigator-header">
            <span><IconMap size={16} />  {t('Board map')}</span>
            <button type="button" onClick={toggle} aria-label={t('Collapse minimap')} aria-expanded={true} title={t('Collapse minimap')}>
              <IconCollapse size={16} />
            </button>
          </div>
          <div
            className="board-navigator-map"
            role="button"
            tabIndex={shapes.length ? 0 : -1}
            aria-label={t('Board minimap: click or drag to navigate; arrow keys move the view')}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              if (event.button !== 0 || !layout || shapes.length === 0) return
              activePointer.current = event.pointerId
              setDragLayout(layout)
              event.currentTarget.setPointerCapture(event.pointerId)
              event.currentTarget.focus({ preventScroll: true })
              navigate(event.clientX, event.clientY, layout)
            }}
            onPointerMove={(event) => {
              if (activePointer.current === event.pointerId && dragLayout) navigate(event.clientX, event.clientY, dragLayout)
            }}
            onPointerUp={(event) => {
              if (activePointer.current !== event.pointerId) return
              activePointer.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
              setDragLayout(null)
            }}
            onPointerCancel={() => { activePointer.current = null; setDragLayout(null) }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && layout && shapes.length > 0) {
                event.preventDefault()
                const point = boardNavigatorWorldPoint({ x: MAP.w / 2, y: MAP.h / 2 }, layout)
                store.noteManualCameraInteraction()
                store.setCamera(boardNavigatorCameraAt(point, store.getCamera(), viewport))
                return
              }
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
              event.preventDefault()
              const camera = store.getCamera()
              const dx = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
              const dy = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
              store.noteManualCameraInteraction()
              store.setCamera({ ...camera, x: camera.x + dx * viewport.w / 4, y: camera.y + dy * viewport.h / 4 })
            }}
          >
            <canvas ref={canvasRef} className="board-navigator-canvas" aria-hidden="true" />
            {shapes.length === 0 && <span className="board-navigator-empty">{t('No objects yet')}</span>}
          </div>
        </>
      )}
    </div>
  )
}
