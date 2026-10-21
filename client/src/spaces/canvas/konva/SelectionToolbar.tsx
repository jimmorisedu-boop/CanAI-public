import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconArchive, IconDownload, IconGrid } from '../../../ui/icons'
import { useDismissOnOutsidePointer } from '../../../ui/dismissOnOutside'
import { showErrorToast, showToast } from '../toastBus'
import type { CanvasItem } from './types'
import { downloadItemsAsZip } from './zipExport'
import type { CanvasStore } from './canvasStore'
import { defaultGridColumns } from './mediaGridLayout'
import { archiveSelection } from './archiveSelection'
import { useCanvasAnchor } from './useCanvasAnchor'
import { itemAabb } from './geometry'
import { scheduleFocusRestore } from '../../../tablet/TabletPopover'
import type { SelectionAlignment, SelectionArrangement } from './selectionGeometry'
import { placeArrangePanel } from './arrangePlacement'
import { hits } from '../../../ui/hotkeys'
import { useT } from '../../../i18n/context.js'


type SelectionAction =
  | { kind: 'align'; value: SelectionAlignment }
  | { kind: 'layout'; value: SelectionArrangement }

const ALIGNMENTS: Array<{ value: SelectionAlignment; label: string; hint: string }> = [
  { value: 'left', label: 'Left', hint: 'Align left edges' },
  { value: 'center-x', label: 'Centre X', hint: 'Align horizontal centres' },
  { value: 'right', label: 'Right', hint: 'Align right edges' },
  { value: 'top', label: 'Top', hint: 'Align top edges' },
  { value: 'center-y', label: 'Centre Y', hint: 'Align vertical centres' },
  { value: 'bottom', label: 'Bottom', hint: 'Align bottom edges' },
]

const ARRANGEMENTS: Array<{ value: SelectionArrangement; label: string }> = [
  { value: 'row', label: 'Row' },
  { value: 'column', label: 'Column' },
  { value: 'grid', label: 'Grid' },
]

// Floating controls above a multi-selection. Arrange is intentionally a single
// entry point: the old +/- grid strip consumed the toolbar and rearranged the
// board on every tap, making it hard to reach the other actions.
export function SelectionToolbar({ items, store, box }: {
  items: CanvasItem[]
  store: CanvasStore
  /** Shared selection bounds in world coordinates. */
  box: { x: number; y: number; right: number; bottom?: number }
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const [action, setAction] = useState<SelectionAction>({ kind: 'layout', value: 'grid' })
  const [columns, setColumns] = useState(String(defaultGridColumns(items.length)))
  const [gap, setGap] = useState('32')
  const [pinned, setPinned] = useState(false)
  const selectionKey = items.map((item) => item.id).join(',')
  const ids = items.map((item) => item.id)
  const canEdit = store.canMutateItems(ids)

  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelPositionRef = useRef<{ left: number; top: number } | null>(null)
  panelPositionRef.current = panelPosition
  const anchorRef = useCanvasAnchor<HTMLDivElement>(
    store,
    ids,
    { x: (box.x + box.right) / 2, y: box.y, screenOffsetY: -44, bounds: items.map(itemAabb) },
    pinned,
  )

  const closePanel = (restoreFocus = true) => {
    store.finalizeArrangePreview()
    setPanelOpen(false)
    if (restoreFocus) scheduleFocusRestore(triggerRef.current)
  }

  const previewAction = (
    nextAction: SelectionAction,
    nextColumns = columns,
    nextGap = gap,
  ): void => {
    if (!canEdit) return
    if (nextAction.kind === 'align') {
      store.previewAlignSelection(ids, nextAction.value)
      return
    }
    const parsedGap = Number(nextGap)
    if (!Number.isFinite(parsedGap)) return
    const safeGap = Math.min(160, Math.max(0, parsedGap))
    if (nextAction.value === 'row') {
      store.previewArrangeInRow(ids, { gap: safeGap })
    } else if (nextAction.value === 'column') {
      store.previewArrangeInColumn(ids, { gap: safeGap })
    } else {
      const parsedColumns = Number(nextColumns)
      if (!Number.isFinite(parsedColumns)) return
      const safeColumns = Math.min(items.length, Math.max(1, Math.round(parsedColumns)))
      store.previewArrangeInGrid(ids, { columns: safeColumns, gap: safeGap })
    }
  }

  useEffect(() => {
    store.finalizeArrangePreview()
    setColumns(String(defaultGridColumns(items.length)))
    setGap('32')
    setAction({ kind: 'layout', value: 'grid' })
    setPanelOpen(false)
    setPinned(false)
  }, [items.length, selectionKey, store])

  useEffect(() => () => {
    store.finalizeArrangePreview()
  }, [store])

  // The trigger follows the selection; the panel is portalled so the canvas'
  // overflow clipping and prompt dock stacking context cannot cover it.
  useLayoutEffect(() => {
    if (!panelOpen) return
    const updatePlacement = () => {
      const node = rootRef.current
      const panel = panelRef.current
      if (!node || !panel) return
      const panelRect = panel.getBoundingClientRect()
      const viewportNode = node.closest('.konva-wrap') as HTMLElement | null
      const hostRect = viewportNode?.getBoundingClientRect() ?? {
        left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      }
      const camera = store.getCamera()
      const selected = {
        left: hostRect.left + camera.x + box.x * camera.scale,
        top: hostRect.top + camera.y + box.y * camera.scale,
        right: hostRect.left + camera.x + box.right * camera.scale,
        bottom: hostRect.top + camera.y + (box.bottom ?? box.y) * camera.scale,
      }
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft ?? 0
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportWidth = viewport?.width && viewport.width > 0 ? viewport.width : window.innerWidth
      const viewportHeight = viewport?.height && viewport.height > 0 ? viewport.height : window.innerHeight
      const dock = document.querySelector<HTMLElement>('.prompt-dock')?.getBoundingClientRect()
      const notice = document.querySelector<HTMLElement>('.notice-corner')?.getBoundingClientRect()
      const viewportBottom = viewportTop + viewportHeight
      const safeViewport = {
        left: Math.max(viewportLeft, hostRect.left),
        top: Math.max(viewportTop, hostRect.top),
        right: Math.min(viewportLeft + viewportWidth, hostRect.right),
        bottom: Math.min(viewportBottom, hostRect.bottom),
      }
      const reservedBottom = Math.max(
        dock && dock.top < viewportBottom ? viewportBottom - dock.top : 0,
        notice && notice.top < viewportBottom ? viewportBottom - notice.top : 0,
      )
      const placement = placeArrangePanel(
        selected,
        { width: panelRect.width, height: panelRect.height },
        safeViewport.right > safeViewport.left && safeViewport.bottom > safeViewport.top
          ? safeViewport
          : { left: viewportLeft, top: viewportTop, right: viewportLeft + viewportWidth, bottom: viewportBottom },
        reservedBottom,
        panelPositionRef.current,
      )
      setPanelPosition((previous) => (
        previous && previous.left === placement.left && previous.top === placement.top
          ? previous
          : { left: placement.left, top: placement.top }
      ))
    }
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.visualViewport?.addEventListener('scroll', updatePlacement)
    window.visualViewport?.addEventListener('resize', updatePlacement)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePlacement)
    if (observer && panelRef.current) observer.observe(panelRef.current)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.visualViewport?.removeEventListener('scroll', updatePlacement)
      window.visualViewport?.removeEventListener('resize', updatePlacement)
      observer?.disconnect()
    }
  }, [panelOpen, store, box.x, box.y, box.right, box.bottom])

  useEffect(() => {
    if (!panelOpen) return
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-arrange-control="true"]')?.focus()
    })
    const closeWithEscape = (event: KeyboardEvent) => {
      const target = event.target
      const isNativeInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      if ((hits('canvas.undo', event) || hits('canvas.redo', event)) && !isNativeInput) {
        // Close/finalize first, then let the board-level shortcut choose its
        // local or cloud-aware undo implementation.
        closePanel()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePanel()
    }
    window.addEventListener('keydown', closeWithEscape, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', closeWithEscape, true)
    }
  }, [panelOpen, store])

  useDismissOnOutsidePointer(panelOpen, rootRef, closePanel, (target) => (
    Boolean(panelRef.current && target instanceof Node && panelRef.current.contains(target))
  ))

  async function download(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const { ok, failed } = await downloadItemsAsZip(items)
      if (ok === 0) showErrorToast(t('Failed to download the selection'))
      else if (failed > 0) showToast(t('Downloaded {0} of {1} — some files are unavailable', { 0: ok, 1: ok + failed }))
    } catch {
      showErrorToast(t('Failed to download the selection'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={anchorRef}
      className="konva-item-toolbar selection-toolbar konva-anchored"
      onPointerEnter={() => setPinned(true)}
      onPointerLeave={() => setPinned(false)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div ref={rootRef} className="selection-arrange">
        <button
          ref={triggerRef}
          type="button"
          className="konva-tool-btn selection-arrange-trigger"
          title={t('Arrange selection')}
          aria-label={t('Arrange selection')}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={() => {
            if (panelOpen) {
              closePanel()
              return
            }
            setPanelOpen(true)
            setPanelPosition(null)
            setPinned(true)
          }}
        >
          <IconGrid size={16} /> <span>{t('Arrange')}</span>
        </button>
      </div>
      {panelOpen && typeof document !== 'undefined' && createPortal(
          <div
            ref={panelRef}
            className="selection-arrange-panel selection-arrange-panel-portal"
            role="dialog"
            aria-label={t('Arrange selection')}
            style={panelPosition
              ? { left: panelPosition.left, top: panelPosition.top }
              : { left: -9999, top: -9999 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <section className="selection-arrange-section" aria-labelledby="selection-align-label">
              <h3 id="selection-align-label">{t('Align')}</h3>
              <div className="selection-arrange-options" role="group" aria-label={t('Align selection')}>
                {ALIGNMENTS.map((entry) => {
                  const active = action.kind === 'align' && action.value === entry.value
                  return (
                    <button
                      key={entry.value}
                      type="button"
                      data-arrange-control="true"
                      className={`selection-arrange-option${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      title={t(entry.hint)}
                      disabled={!canEdit}
                      onClick={() => {
                        const next = { kind: 'align', value: entry.value } as const
                        setAction(next)
                        previewAction(next)
                      }}
                    >
                      {t(entry.label)}
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="selection-arrange-section" aria-labelledby="selection-layout-label">
              <h3 id="selection-layout-label">{t('Layout')}</h3>
              <div className="selection-arrange-options selection-arrange-layout" role="group" aria-label={t('Layout selection')}>
                {ARRANGEMENTS.map((entry) => {
                  const active = action.kind === 'layout' && action.value === entry.value
                  return (
                    <button
                      key={entry.value}
                      type="button"
                      data-arrange-control="true"
                      className={`selection-arrange-option${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      disabled={!canEdit}
                      onClick={() => {
                        const next = { kind: 'layout', value: entry.value } as const
                        setAction(next)
                        previewAction(next)
                      }}
                    >
                      {t(entry.label)}
                    </button>
                  )
                })}
              </div>
            </section>

            <div className="selection-arrange-fields">
              <label>
                <span>{t('Columns')}</span>
                <input
                  type="number"
                  min={1}
                  max={items.length}
                  step={1}
                  value={columns}
                  disabled={action.kind !== 'layout' || action.value !== 'grid' || !canEdit}
                  onChange={(event) => {
                    const next = event.target.value
                    setColumns(next)
                    previewAction(action, next, gap)
                  }}
                />
              </label>
              <label>
                <span>{t('Gap')}</span>
                <input
                  type="number"
                  min={0}
                  max={160}
                  step={4}
                  value={gap}
                  disabled={action.kind !== 'layout' || !canEdit}
                  onChange={(event) => {
                    const next = event.target.value
                    setGap(next)
                    previewAction(action, columns, next)
                  }}
                />
              </label>
            </div>
          </div>,
          document.body,
        )}
      <button
        type="button"
        className="konva-tool-btn"
        title={t('Move selection to Archive ({0}) — Shift+Delete', { 0: items.length })}
        aria-label={t('Move selection to Archive')}
        disabled={!canEdit}
        onClick={() => archiveSelection(store, ids)}
      >
        <IconArchive />
      </button>
      <button
        type="button"
        className="konva-tool-btn"
        title={t('Download selection ({0}) as ZIP', { 0: items.length })}
        aria-label={t('Download selection as ZIP')}
        disabled={busy}
        onClick={() => void download()}
      >
        <IconDownload />
      </button>
    </div>
  )
}
