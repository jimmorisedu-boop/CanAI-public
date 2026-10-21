import { useEffect, useState } from 'react'
import { IconGrid } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { SelectionAlignment, SelectionArrangement } from '../spaces/canvas/konva/selectionGeometry'
import { useT } from '../i18n/context.js'


const ALIGNMENTS: Array<{ value: SelectionAlignment; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center-x', label: 'Centre X' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Top' },
  { value: 'center-y', label: 'Centre Y' },
  { value: 'bottom', label: 'Bottom' },
]

const ARRANGEMENTS: Array<{ value: SelectionArrangement; label: string }> = [
  { value: 'row', label: 'Row' },
  { value: 'column', label: 'Column' },
  { value: 'grid', label: 'Grid' },
]

function defaultColumns(count: number): number {
  return Math.max(2, Math.round(Math.sqrt(Math.max(1, count))))
}

/**
 * Shared staged controls for multi-selection arrangement.
 *
 * This component is used by the live tablet context bar and kept available to
 * the inspector fallback. Inputs preview immediately; the store persists one
 * grouped mutation when the surrounding popover closes.
 */
export function TabletArrangeControls({
  store,
  ids,
  disabled = false,
  disabledReason,
}: {
  store: CanvasStore
  ids: string[]
  disabled?: boolean
  disabledReason?: string
}) {
  const t = useT()
  const [action, setAction] = useState<
    { kind: 'align'; value: SelectionAlignment }
    | { kind: 'layout'; value: SelectionArrangement }
  >({ kind: 'layout', value: 'grid' })
  const [columns, setColumns] = useState(String(defaultColumns(ids.length)))
  const [gap, setGap] = useState('24')
  const selectionKey = ids.join(',')

  useEffect(() => {
    setAction({ kind: 'layout', value: 'grid' })
    setColumns(String(defaultColumns(ids.length)))
    setGap('24')
  }, [selectionKey, ids.length])

  useEffect(() => () => {
    store.finalizeArrangePreview()
  }, [store, selectionKey])

  const preview = (
    nextAction: typeof action,
    nextColumns = columns,
    nextGap = gap,
  ) => {
    if (disabled || ids.length < 2) return
    if (nextAction.kind === 'align') {
      store.previewAlignSelection(ids, nextAction.value)
      return
    }
    const parsedGap = Number(nextGap)
    if (!Number.isFinite(parsedGap)) return
    const safeGap = Math.min(160, Math.max(0, parsedGap))
    const arrangement = nextAction.kind === 'layout' ? nextAction.value : action.value
    if (arrangement === 'row') store.previewArrangeInRow(ids, { gap: safeGap })
    else if (arrangement === 'column') store.previewArrangeInColumn(ids, { gap: safeGap })
    else {
      const parsedColumns = Number(nextColumns)
      if (!Number.isFinite(parsedColumns)) return
      const safeColumns = Math.min(ids.length, Math.max(1, Math.round(parsedColumns)))
      store.previewArrangeInGrid(ids, { columns: safeColumns, gap: safeGap })
    }
  }

  return (
    <div className="tablet-grid-controls" aria-label={t('Arrange selection')}>
      <div className="tablet-arrange-group" role="group" aria-label={t('Align selection')}>
        <span className="tablet-arrange-label">{t('Align')}</span>
        <div className="tablet-arrange-options">
          {ALIGNMENTS.map((entry) => {
            const active = action.kind === 'align' && action.value === entry.value
            return <button
              key={entry.value}
              type="button"
              className={`tablet-arrange-option${active ? ' is-active' : ''}`}
              disabled={disabled}
              aria-pressed={active}
              title={disabled ? disabledReason : t(entry.label)}
              onClick={() => {
                const next = { kind: 'align', value: entry.value } as const
                setAction(next)
                preview(next)
              }}
            >{t(entry.label)}</button>
          })}
        </div>
      </div>
      <div className="tablet-arrange-group" role="group" aria-label={t('Layout selection')}>
        <span className="tablet-arrange-label"><IconGrid size={16} />  {t('Layout')}</span>
        <div className="tablet-arrange-options tablet-arrange-layout">
          {ARRANGEMENTS.map((entry) => {
            const active = action.kind === 'layout' && action.value === entry.value
            return <button
              key={entry.value}
              type="button"
              className={`tablet-arrange-option${active ? ' is-active' : ''}`}
              disabled={disabled}
              aria-pressed={active}
              title={disabled ? disabledReason : t(entry.label)}
              onClick={() => {
                const next = { kind: 'layout', value: entry.value } as const
                setAction(next)
                preview(next)
              }}
            >{t(entry.label)}</button>
          })}
        </div>
      </div>
      <div className="tablet-arrange-fields">
        <label>
          <span>{t('Columns')}</span>
          <input
            type="number"
            min={1}
            max={ids.length}
            step={1}
            value={columns}
            aria-label={t('Columns')}
            disabled={disabled || action.kind !== 'layout' || action.value !== 'grid'}
            onChange={(event) => {
              const next = event.target.value
              setColumns(next)
              preview(action, next, gap)
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
            aria-label={t('Gap')}
            disabled={disabled || action.kind !== 'layout'}
            onChange={(event) => {
              const next = event.target.value
              setGap(next)
              preview(action, columns, next)
            }}
          />
        </label>
      </div>
    </div>
  )
}
