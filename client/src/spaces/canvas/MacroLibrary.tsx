import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Macro, MacroScope } from '../../api'
import type { ProjectSource } from '../../types'
import { IconClose, IconPlus, IconUpload } from '../../ui/icons'
import { useDialogFocus, useDialogFocusKeeper } from '../../ui/dialogFocus'
import { InlineNotice } from '../../ui/InlineNotice'
import { MacroLibraryLegacy } from './MacroLibraryLegacy'
import { MacroLibraryRow } from './MacroLibraryRow'
import { MACRO_SLOT_COUNT, NODES } from './macroLibraryModel'
import { useMacroLibraryActions, type LibraryNotice } from './useMacroLibraryActions'
import { useMacroLibraryData } from './useMacroLibraryData'

/** Local macro library window: list, edit, duplicate, reorder, file exchange. */
export function MacroLibrary({
  scope,
  projectSource = 'local',
  onClose,
  initialNotice,
}: {
  scope: MacroScope
  projectSource?: ProjectSource
  onClose(): void
  initialNotice?: LibraryNotice | null
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const data = useMacroLibraryData(scope, projectSource)
  const actions = useMacroLibraryActions({ data, scope, projectSource, onClose, initialNotice })
  const { shown, orphans, slotted, full, busy } = actions
  useDialogFocusKeeper(dialogRef, `${busy}:${shown.length}`)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const unit = NODES

  function commitRename(macro: Macro): void {
    const name = renameValue.trim()
    setRenamingId(null)
    if (name && name !== macro.name) actions.rename(macro, name)
  }

  function applyOrder(ids: string[]): void {
    setDragId(null)
    setOverId(null)
    void actions.reorder(ids)
  }

  function moveRow(from: number, to: number): void {
    const ids = slotted.map((m) => m.id)
    if (from < 0 || to < 0 || to >= ids.length || from === to) {
      setDragId(null)
      setOverId(null)
      return
    }
    ids.splice(to, 0, ...ids.splice(from, 1))
    applyOrder(ids)
  }

  const indexOf = (id: string | null): number => slotted.findIndex((m) => m.id === id)

  function row(macro: Macro): JSX.Element {
    const orphan = macro.slot == null
    return (
      <MacroLibraryRow
        key={macro.id}
        macro={macro}
        unit={unit}
        busy={busy}
        full={full}
        rename={renamingId === macro.id ? {
          value: renameValue,
          onChange: setRenameValue,
          onCommit: () => commitRename(macro),
          onCancel: () => setRenamingId(null),
        } : null}
        drag={{
          dragging: dragId === macro.id,
          over: overId === macro.id && dragId !== macro.id,
          enabled: true,
          onStart: (event) => {
            setDragId(macro.id)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', macro.id)
          },
          onOver: (event) => {
            if (!dragId || orphan) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (overId !== macro.id) setOverId(macro.id)
          },
          onDrop: (event) => {
            event.preventDefault()
            moveRow(indexOf(dragId), indexOf(macro.id))
          },
          onEnd: () => { setDragId(null); setOverId(null) },
        }}
        onOpen={() => actions.open(macro)}
        onMove={(delta) => moveRow(indexOf(macro.id), indexOf(macro.id) + delta)}
        onGiveSlot={() => applyOrder([...slotted.map((m) => m.id), macro.id])}
        onRenameStart={() => { setRenamingId(macro.id); setRenameValue(macro.name) }}
        onDuplicate={() => actions.duplicate(macro)}
        onExport={() => actions.exportFile(macro)}
        onRemove={() => actions.remove(macro)}
      />
    )
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-card macro-lib"
        role="dialog"
        aria-modal="true"
        aria-labelledby="macro-lib-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="macro-lib-title">Macros</h2>
          {!data.loading && <span className="macro-lib-count">{`${slotted.length} of ${MACRO_SLOT_COUNT}`}</span>}
          <button className="macro-lib-close" type="button" aria-label="Close" onClick={onClose}><IconClose size={16} /></button>
        </header>

        {data.error && <InlineNotice className="macro-lib-error" tone="error" title={data.error} action={{ label: 'Retry', onClick: () => void data.reload() }} />}
        {actions.notice && (
          <InlineNotice className="macro-lib-notice" tone={actions.notice.tone} title={actions.notice.title} onDismiss={actions.dismissNotice}>
            {actions.notice.lines.length > 0 && <ul>{actions.notice.lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>}
          </InlineNotice>
        )}

        {data.loading ? data.error ? null : <p className="macro-lib-note">Loading…</p> : shown.length === 0 ? (
          <p className="macro-lib-note">No macros yet.</p>
        ) : (
          <>
            {orphans.length > 0 && <><div className="macro-lib-section warn">Not visible in the bar</div>{orphans.map(row)}</>}
            {slotted.map(row)}
          </>
        )}

        <MacroLibraryLegacy macros={data.legacy} unit={unit} busy={busy} onRemove={actions.removeLegacy} />
        <footer className="macro-lib-footer">
          <button className="macro-lib-add" type="button" disabled={data.loading || full} title={full ? `All ${MACRO_SLOT_COUNT} slots are occupied` : undefined} onClick={() => actions.create()}>
            <IconPlus size={14} /> Add macro
          </button>
          <button className="macro-lib-add" type="button" disabled={data.loading || full || busy} title={full ? `All ${MACRO_SLOT_COUNT} slots are occupied` : 'Upload macro from file'} onClick={() => actions.importFile()}>
            <IconUpload size={14} /> From file
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
