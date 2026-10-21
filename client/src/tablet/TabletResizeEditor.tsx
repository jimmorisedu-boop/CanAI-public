import { useEffect, useRef, useState } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { TabletDialog } from './TabletDialog'
import { confirmDiscardDraft } from './confirmDiscardDraft'
import { useT } from '../i18n/context.js'


const MIN_SIZE = 24
const MAX_SIZE = 10000

/** Apply a committed tablet resize as one document mutation. */
export function resizeBoardItem(store: CanvasStore, itemId: string, width: number, height: number): boolean {
  const item = store.getItem(itemId)
  if (!item || !store.canMutateItems([itemId])) return false
  if (item.w === width && item.h === height) return true
  store.updateItem(itemId, { w: width, h: height })
  return true
}

function displaySize(value: number): string {
  return String(Math.max(MIN_SIZE, Math.round(value)))
}

function parsedSize(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(parsed)))
}

function itemTitle(item: CanvasItem): string {
  if (item.kind === 'image') return 'Image'
  if (item.kind === 'video') return 'Video'
  if (item.kind === 'audio') return 'Track'
  if (item.kind === 'text') return 'Text'
  return 'Link'
}

/**
 * Явный resize существующего объекта.
 *
 * Поля живут локально до «Применить», поэтому ввод не создаёт историю по
 * каждому символу. CanvasStore получает один patch с шириной и высотой — один
 * шаг Undo и сохранение обычным путём.
 */
export function TabletResizeEditor({
  store,
  itemId,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  onClose(): void
}) {
  const t = useT()
  const item = store.getItem(itemId)
  const widthRef = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(() => displaySize(item?.w ?? MIN_SIZE))
  const [height, setHeight] = useState(() => displaySize(item?.h ?? MIN_SIZE))
  const [locked, setLocked] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    widthRef.current?.focus()
    widthRef.current?.select()
  }, [])

  if (!item) return null

  const ratio = item.w > 0 && item.h > 0 ? item.w / item.h : 1
  const initialWidth = displaySize(item.w)
  const initialHeight = displaySize(item.h)
  const dirty = width !== initialWidth || height !== initialHeight

  const setWidthValue = (value: string) => {
    setWidth(value)
    const next = parsedSize(value)
    if (locked && next !== null) setHeight(displaySize(next / ratio))
  }

  const setHeightValue = (value: string) => {
    setHeight(value)
    const next = parsedSize(value)
    if (locked && next !== null) setWidth(displaySize(next * ratio))
  }

  const close = async () => {
    if (!await confirmDiscardDraft(dirty)) return
    onClose()
  }

  const apply = () => {
    const nextWidth = parsedSize(width)
    const nextHeight = parsedSize(height)
    if (nextWidth === null || nextHeight === null) {
      setError('Enter positive dimensions')
      return
    }
    if (nextWidth === item.w && nextHeight === item.h) {
      onClose()
      return
    }
    if (!store.canMutateItems([item.id])) {
      setError('Another participant is editing this object')
      return
    }
    resizeBoardItem(store, item.id, nextWidth, nextHeight)
    onClose()
  }

  return (
    <TabletDialog
      title={t('Object size')}
      onClose={close}
      wide
      actions={
        <>
          <button type="button" className="ui-btn quiet" onClick={close}>{t('Cancel')}</button>
          <button type="button" className="ui-btn primary" onClick={apply}>{t('Apply')}</button>
        </>
      }
    >
      <div className="tablet-resize-editor">
        <p className="tablet-resize-title">{itemTitle(item)}</p>
        <p className="tablet-resize-note">{t('This changes the canvas card size. The original file stays unchanged.')}</p>
        <div className="tablet-resize-fields">
          <label>
            <span>{t('Width, px')}</span>
            <input
              ref={widthRef}
              className="ui-field"
              type="number"
              inputMode="numeric"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step="1"
              value={width}
              onChange={(event) => setWidthValue(event.target.value)}
            />
          </label>
          <label>
            <span>{t('Height, px')}</span>
            <input
              className="ui-field"
              type="number"
              inputMode="numeric"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step="1"
              value={height}
              onChange={(event) => setHeightValue(event.target.value)}
            />
          </label>
        </div>
        <label className="tablet-resize-lock">
          <input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />
          <span>{t('Keep aspect ratio')}</span>
        </label>
        {error && <p className="tablet-resize-error" role="alert">{error}</p>}
      </div>
    </TabletDialog>
  )
}
