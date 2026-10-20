import type { DragEvent } from 'react'
import type { Macro } from '../../api'
import { IconDownload, IconDuplicate, IconEdit, IconTrash } from '../../ui/icons'
import { macroRunnable } from '../nodes/macroPersistence'
import type { GraphSnapshot } from '../nodes/types'
import { MACRO_SLOT_COUNT, describeMacro } from './macroLibraryModel'

export interface MacroRowRename {
  value: string
  onChange(value: string): void
  onCommit(): void
  onCancel(): void
}

export interface MacroRowDrag {
  dragging: boolean
  over: boolean
  enabled: boolean
  onStart(event: DragEvent<HTMLElement>): void
  onOver(event: DragEvent<HTMLElement>): void
  onDrop(event: DragEvent<HTMLElement>): void
  onEnd(): void
}

export function MacroLibraryRow({
  macro, unit, busy, full, rename, drag,
  onOpen, onMove, onGiveSlot, onRenameStart, onDuplicate, onExport, onRemove,
}: {
  macro: Macro
  unit: [string, string, string]
  busy: boolean
  full: boolean
  rename: MacroRowRename | null
  drag: MacroRowDrag
  onOpen(): void
  onMove(delta: number): void
  onGiveSlot(): void
  onRenameStart(): void
  onDuplicate(): void
  onExport(): void
  onRemove(): void
}) {
  const graph = macro.graph as Partial<GraphSnapshot>
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const ready = macroRunnable({ nodes, edges: Array.isArray(graph?.edges) ? graph.edges : [] })
  const orphan = macro.slot == null
  return (
    <article
      className={`macro-lib-row ${orphan ? 'orphan' : ''} ${drag.dragging ? 'dragging' : ''} ${drag.over ? 'over' : ''}`}
      draggable={drag.enabled && !orphan && !rename && !busy}
      onDragStart={drag.onStart}
      onDragOver={drag.onOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onEnd}
    >
      <span className={`macro-lib-slot ${orphan ? 'none' : ''}`} aria-hidden="true">
        {orphan ? '—' : (macro.slot ?? 0) + 1}
      </span>
      <button
        type="button"
        className="macro-lib-open"
        disabled={Boolean(rename) || busy}
        aria-label={`Open "${macro.name}" in the node editor`}
        title="Open in workflow editor"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (!event.altKey) return
          if (event.key === 'ArrowUp') { event.preventDefault(); onMove(-1) }
          if (event.key === 'ArrowDown') { event.preventDefault(); onMove(1) }
        }}
      />
      <div className="macro-lib-text">
        {rename ? (
          <input
            className="macro-lib-rename"
            value={rename.value}
            autoFocus
            aria-label="New name"
            onChange={(event) => rename.onChange(event.target.value)}
            onBlur={rename.onCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename.onCommit()
              if (event.key === 'Escape') rename.onCancel()
            }}
          />
        ) : <strong>{macro.name}</strong>}
        <small className={orphan ? 'warn' : undefined}>
          {describeMacro({ orphan, ready, nodeCount: nodes.length, unit })}
        </small>
      </div>

      {orphan && !full && (
        <button type="button" className="macro-lib-fix" disabled={busy} onClick={onGiveSlot}>
          Assign a slot
        </button>
      )}

      <button
        type="button"
        className="icon-btn macro-lib-act"
        aria-label={`Rename "${macro.name}"`}
        title="Rename"
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); onRenameStart() }}
      >
        <IconEdit size={15} />
      </button>
      <button
        type="button"
        className="icon-btn macro-lib-act"
        aria-label={`Duplicate "${macro.name}"`}
        title={full ? `All ${MACRO_SLOT_COUNT} slots are occupied — free one` : 'Duplicate'}
        disabled={full || busy}
        onClick={(event) => { event.stopPropagation(); onDuplicate() }}
      >
        <IconDuplicate size={15} />
      </button>
      <button
        type="button"
        className="icon-btn macro-lib-act"
        aria-label={`Save "${macro.name}" to file`}
        title="Save to a file — you can share it with a colleague"
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); onExport() }}
      >
        <IconDownload size={15} />
      </button>
      <button
        type="button"
        className="icon-btn macro-lib-act danger"
        aria-label={`Delete "${macro.name}"`}
        title="Delete"
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); onRemove() }}
      >
        <IconTrash size={15} />
      </button>
    </article>
  )
}
