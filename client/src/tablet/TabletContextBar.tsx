import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconArchive,
  IconCompare,
  IconCrop,
  IconDownload,
  IconDuplicate,
  IconFit,
  IconFitAll,
  IconGrid,
  IconPin,
  IconSketch,
  IconSound,
  IconText,
  IconTimeline,
  IconToBack,
  IconToFront,
  IconTrash,
  IconMagic,
} from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { ACTION_LABEL, type InspectorAction } from './inspectorModel'
import { contextActionsFor, type ContextAction } from './contextActionModel'
import { placeContextBar } from './contextBarPlacement'
import { TabletPopover, useAnchor } from './TabletPopover'
import { TabletArrangeControls } from './TabletArrangeControls'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useBoardHistory } from './boardHistory'
import { hits } from '../ui/hotkeys'
import { useT } from '../i18n/context.js'


const ICONS: Record<ContextAction, React.ReactNode> = {
  view: <IconFit size={19} />,
  resize: <IconFitAll size={19} />,
  grid: <IconGrid size={19} />,
  sketch: <IconSketch size={19} />,
  crop: <IconCrop size={19} />,
  clip: <IconTimeline size={19} />,
  'extract-audio': <IconSound size={19} />,
  compare: <IconCompare size={19} />,
  'edit-text': <IconText size={19} />,
  duplicate: <IconDuplicate size={19} />,
  pin: <IconPin size={19} />,
  front: <IconToFront size={19} />,
  back: <IconToBack size={19} />,
  download: <IconDownload size={19} />,
  archive: <IconArchive size={19} />,
  delete: <IconTrash size={19} />,
}

const labelOf = (action: ContextAction) => action === 'grid' ? 'Arrange' : ACTION_LABEL[action]

export function TabletContextBar({
  store,
  items,
  selectionRect,
  busyNote,
  onAction,
  onDetails,
}: {
  store: CanvasStore
  items: CanvasItem[]
  selectionRect: DOMRect | null
  busyNote?: string | null
  onAction(action: InspectorAction, items: CanvasItem[]): void
  onDetails?(id: string): void
}) {
  const t = useT()
  const history = useBoardHistory()
  const ref = useRef<HTMLDivElement>(null)
  const more = useAnchor()
  const arrange = useAnchor()
  const [box, setBox] = useState<{ left: number; top: number; side: 'above' | 'below' | 'sheet' } | null>(null)
  const { primary, overflow } = contextActionsFor(items)
  const mutationBlockReason = ''

  const closeArrange = () => {
    store.finalizeArrangePreview()
    arrange.close()
  }

  useEffect(() => {
    if (!arrange.anchor) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return
      if (!hits('canvas.undo', event) && !hits('canvas.redo', event)) return
      const target = event.target
      const nativeInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      if (nativeInput) return
      event.preventDefault()
      event.stopPropagation()
      closeArrange()
      if (hits('canvas.redo', event)) history.redo()
      else history.undo()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [arrange.anchor, history, store])

  useEffect(() => () => {
    store.finalizeArrangePreview()
  }, [store, items.map((item) => item.id).join(',')])

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !selectionRect) return
    const update = () => {
      const viewport = window.visualViewport
      const topbar = document.querySelector<HTMLElement>('.tablet-topbar')?.getBoundingClientRect()
      const dock = document.querySelector<HTMLElement>('.tablet-dock')?.getBoundingClientRect()
      const offsetLeft = viewport?.offsetLeft ?? 0
      const offsetTop = viewport?.offsetTop ?? 0
      const right = offsetLeft + (viewport?.width ?? window.innerWidth)
      const bottom = offsetTop + (viewport?.height ?? window.innerHeight)
      setBox(placeContextBar(
        selectionRect,
        { width: node.offsetWidth, height: node.offsetHeight },
        {
          left: offsetLeft + 12,
          right: right - 12,
          top: Math.max(offsetTop + 12, (topbar?.bottom ?? offsetTop) + 8),
          bottom: bottom - 12,
        },
        dock,
      ))
    }
    update()
    window.addEventListener('resize', update)
    // Масштаб интерфейса меняет transform дока без обязательного resize.
    // Пересчитываем безопасное место панели сразу после такого жеста.
    window.addEventListener('canai-tablet-ui-scale', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    const dock = document.querySelector<HTMLElement>('.tablet-dock')
    const observer = typeof ResizeObserver === 'undefined' || !dock
      ? null
      : new ResizeObserver(update)
    if (observer && dock) observer.observe(dock)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('canai-tablet-ui-scale', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [selectionRect, primary.length, overflow.length, busyNote])

  if (!selectionRect || items.length === 0) return null

  const run = (action: ContextAction, event?: { currentTarget: EventTarget | null }) => {
    if (action === 'grid') {
      if (event) arrange.open(event)
      return
    }
    onAction(action, items)
  }

  return (
    <>
      <div
        ref={ref}
        className={`tablet-context-bar ${box?.side ?? 'below'}`}
        role="toolbar"
        aria-label={items.length > 1 ? t('Actions, selected {0}', { 0: items.length }) : t('Object actions')}
        style={box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 }}
      >
        {items.length > 1 && <span className="tablet-context-count">{items.length}</span>}
        {items.length === 1 && (items[0].prompt || items[0].modelId) && onDetails && <button
          type="button" className="tablet-context-action" aria-label={t('Generation settings')} title={t('Generation settings')}
          onClick={() => onDetails(items[0].id)}><IconMagic size={19} /></button>}
        {primary.slice(0, 3).map((action) => {
          const disabled = false
          const actionLabel = t(labelOf(action))
          const blockReason = mutationBlockReason.startsWith('Busy: ')
            ? t('Busy: {0}', { 0: mutationBlockReason.slice('Busy: '.length) })
            : t(mutationBlockReason)
          return (
          <button
            key={action}
            type="button"
            className="tablet-context-action"
            disabled={disabled}
            title={disabled ? blockReason : actionLabel}
            aria-label={disabled ? `${actionLabel}. ${blockReason}` : actionLabel}
            aria-haspopup={action === 'grid' ? 'dialog' : undefined}
            aria-expanded={action === 'grid' ? Boolean(arrange.anchor) : undefined}
            onClick={(event) => run(action, event)}
          >
            {ICONS[action]}
            <span>{actionLabel}</span>
          </button>
          )
        })}
        {overflow.length > 0 && (
          <button type="button" className="tablet-context-more" aria-label={t('More actions')} title={t('More actions')} onClick={more.open}>
            <span aria-hidden="true">•••</span>
          </button>
        )}
        {busyNote && <span className="tablet-context-progress" role="status">{tabletSystemMessage(busyNote, t('Working…'))}</span>}
      </div>

      {arrange.anchor && (
        <TabletPopover
          anchor={arrange.anchor}
          align="center"
          label={t('Arrange selection')}
          fallbackSheet
          avoidRect={selectionRect}
          onClose={closeArrange}
        >
          <TabletArrangeControls
            store={store}
            ids={items.map((item) => item.id)}
            disabled={false}
            disabledReason={mutationBlockReason}
          />
        </TabletPopover>
      )}

      {more.anchor && (
        <TabletPopover anchor={more.anchor} align="center" label={t('More actions')} fallbackSheet onClose={more.close}>
          {overflow.map((action) => (
            (() => {
              const disabled = false
              const actionLabel = t(ACTION_LABEL[action])
              const blockReason = mutationBlockReason.startsWith('Busy: ')
                ? t('Busy: {0}', { 0: mutationBlockReason.slice('Busy: '.length) })
                : t(mutationBlockReason)
              return (
                <button
                  key={action}
                  type="button"
                  className={`tablet-menu-item ${action === 'archive' ? 'archive' : ''}`}
                  disabled={disabled}
                  title={disabled ? blockReason : undefined}
                  onClick={() => { more.close(); run(action) }}
                >
                  {ICONS[action]}
                  <span>{actionLabel}</span>
                </button>
              )
            })()
          ))}
        </TabletPopover>
      )}
    </>
  )
}
