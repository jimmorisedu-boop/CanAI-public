import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { IconEraser, IconSketch, IconUndo } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { SWATCHES } from '../spaces/canvas/konva/SketchPalette'
import { bakeSketchToNewImage } from '../spaces/canvas/konva/sketchExport'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { notify } from '../spaces/canvas/notifications'
import { TabletFullScreen } from './TabletFullScreen'
import type { ProjectSource } from '../types'
import { confirmDiscardDraft } from './confirmDiscardDraft'
import { InlineNotice } from '../ui/InlineNotice'
import { previewSrc } from './remoteSession'
import { SketchPrompt } from './SketchPrompt'
import type { TabletMediaUploader } from './runtime'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


// Скетч поверх картинки.
//
// Штрихи живут в общем сторе (startStroke/extendStroke), поэтому и склейка
// общая с компьютером: «Готово» кладёт результат НОВОЙ картинкой рядом, а
// оригинал остаётся чистым. Планшетное здесь — рисование пальцем и то, что
// промпт стоит прямо в режиме: дока снизу в полноэкранном режиме не видно.

const SIZES = [4, 10, 18, 30]

export function TabletSketch({
  store,
  itemId,
  projectId,
  projectSource,
  upload,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  projectId: string
  projectSource: ProjectSource
  upload: TabletMediaUploader
  onClose(): void
}) {
  const t = useT()
  useContentVersion(store)
  const item = store.getItem(itemId)
  const [color, setColor] = useState(SWATCHES[0]!)
  const [size, setSize] = useState(10)
  const [tool, setTool] = useState<'draw' | 'erase'>('draw')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [promptDirty, setPromptDirty] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [display, setDisplay] = useState({ w: 0, h: 0, scale: 1 })
  const drawing = useRef(false)
  const busyRef = useRef(false)

  const bounds = { w: item?.w ?? 1, h: item?.h ?? 1 }

  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const measure = () => {
      const boxW = node.clientWidth
      const boxH = node.clientHeight
      if (boxW < 2 || boxH < 2) return
      const scale = Math.min(boxW / bounds.w, boxH / bounds.h)
      setDisplay({ w: bounds.w * scale, h: bounds.h * scale, scale })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [bounds.w, bounds.h])

  // Незавершённый рисунок за собой убираем: штрихи не входят ни в историю, ни
  // в сохранение доски, и оставленные висели бы поверх холста до перезагрузки.
  useEffect(() => () => store.clearStrokes(), [store])

  const toWorld = useCallback((event: ReactPointerEvent): { x: number; y: number } => {
    const frame = stageRef.current?.querySelector('.tablet-sketch-frame')?.getBoundingClientRect()
    const base = store.getItem(itemId)
    return {
      x: (base?.x ?? 0) + (event.clientX - (frame?.left ?? 0)) / display.scale,
      y: (base?.y ?? 0) + (event.clientY - (frame?.top ?? 0)) / display.scale,
    }
  }, [display.scale, itemId, store])

  if (!item) return null

  const strokes = store.getStrokes().filter((stroke) => {
    for (let index = 0; index < stroke.points.length; index += 2) {
      const x = stroke.points[index]!
      const y = stroke.points[index + 1]!
      if (x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h) return true
    }
    return false
  })

  const done = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const baked = await bakeSketchToNewImage(store, itemId, upload)
      if (!baked) notify({ kind: 'info', message: t('Nothing to draw — the image has no strokes') })
      store.clearStrokes()
      onClose()
    } catch (error) {
      setError(tabletSystemMessage(error, t('Could not build sketch')))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const close = async () => {
    if (busyRef.current || !await confirmDiscardDraft(strokes.length > 0 || promptDirty)) return
    store.clearStrokes()
    onClose()
  }

  return (
    <TabletFullScreen
      title={t('Sketch overlay')}
      onCancel={close}
      tone="dark"
      center={
        <div className="tablet-brushes">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={`tablet-swatch ${color === swatch && tool === 'draw' ? 'on' : ''}`}
              style={{ background: swatch }}
              aria-label={t('Color {0}', { 0: swatch })}
              aria-pressed={color === swatch && tool === 'draw'}
              onClick={() => {
                setColor(swatch)
                setTool('draw')
              }}
            />
          ))}
          <span className="tablet-brush-sep" />
          {SIZES.map((value) => (
            <button
              key={value}
              type="button"
              className={`tablet-brush-size ${size === value ? 'on' : ''}`}
              aria-label={t('Thickness {0}', { 0: value })}
              aria-pressed={size === value}
              onClick={() => setSize(value)}
            >
              <i style={{ width: Math.min(value, 22), height: Math.min(value, 22) }} />
            </button>
          ))}
          <span className="tablet-brush-sep" />
          <button
            type="button"
            className={`ui-icon-btn ${tool === 'erase' ? 'on' : ''}`}
            aria-label={t('Eraser')}
            aria-pressed={tool === 'erase'}
            onClick={() => setTool(tool === 'erase' ? 'draw' : 'erase')}
          >
            {tool === 'erase' ? <IconSketch size={18} /> : <IconEraser size={18} />}
          </button>
          <button
            type="button"
            className="ui-icon-btn"
            aria-label={t('Undo stroke')}
            disabled={!store.canUndoStroke()}
            onClick={() => store.undoStroke()}
          >
            <IconUndo size={18} />
          </button>
        </div>
      }
      primary={
        <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void done()}>
          {busy ? t('Building…') : t('Done')}
        </button>
      }
      footer={<SketchPrompt store={store} projectId={projectId} projectSource={projectSource} itemId={itemId} onDirtyChange={setPromptDirty} />}
    >
      {error && <InlineNotice className="tablet-error" tone="error" title={tabletSystemMessage(error, t('Could not build sketch'))} onDismiss={() => setError(null)} />}
      <div className="tablet-sketch-stage" ref={stageRef}>
        <div
          className="tablet-sketch-frame"
          style={{ width: display.w, height: display.h }}
          onPointerDown={(event) => {
            try {
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
            } catch {
              // Рисуем и без захвата — потеря захвата не повод обрывать штрих.
            }
            const point = toWorld(event)
            drawing.current = true
            store.startStroke(color, size, point.x, point.y, tool)
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return
            const point = toWorld(event)
            store.extendStroke(point.x, point.y)
          }}
          onPointerUp={() => { drawing.current = false }}
          onPointerCancel={() => { drawing.current = false }}
        >
          <img src={previewSrc(item.src ?? '')} alt="" draggable={false} />
          <svg
            className="tablet-sketch-ink"
            viewBox={`0 0 ${bounds.w} ${bounds.h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {strokes.map((stroke, index) => (
              <polyline
                key={index}
                points={pointsToPath(stroke.points, item.x, item.y)}
                fill="none"
                stroke={stroke.tool === 'erase' ? '#0e0f12' : stroke.color}
                strokeWidth={stroke.size}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        </div>
      </div>
    </TabletFullScreen>
  )
}

/** Мировые точки штриха → координаты внутри кадра картинки. */
function pointsToPath(points: readonly number[], originX: number, originY: number): string {
  const parts: string[] = []
  for (let index = 0; index < points.length; index += 2) {
    parts.push(`${points[index]! - originX},${points[index + 1]! - originY}`)
  }
  return parts.join(' ')
}
