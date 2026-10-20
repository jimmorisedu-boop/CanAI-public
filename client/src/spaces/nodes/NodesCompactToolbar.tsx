import type { ReactNode } from 'react'
import { OverflowMenu } from '../../ui/OverflowMenu'
import { IconBack } from '../../ui/icons'

export function NodesCompactToolbar({
  name,
  placeholder,
  loaded,
  attention,
  defaultMenuOpen = false,
  onBack,
  onNameChange,
  addActions,
  validationAction,
  saveAction,
  deleteAction,
}: {
  name: string
  placeholder: string
  loaded: boolean
  attention: boolean
  defaultMenuOpen?: boolean
  onBack(): void
  onNameChange(name: string): void
  addActions: ReactNode
  validationAction?: ReactNode
  saveAction: ReactNode
  deleteAction?: ReactNode
}) {
  return (
    <div className="nodes-toolbar nodes-toolbar-compact">
      <button
        type="button"
        className="node-add-btn nodes-back icon-tab"
        onClick={onBack}
        title="Back to canvas"
      >
        <IconBack size={16} /> Canvas
      </button>
      <input
        className="macro-name-input"
        aria-label="Macro name"
        placeholder={placeholder}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        title="Macro name (slot button label)"
        disabled={!loaded}
      />
      <OverflowMenu
        label="More"
        panelLabel="Macro actions"
        attention={attention}
        compact
        defaultOpen={defaultMenuOpen}
      >
        <section className="nodes-compact-add" aria-label="Add node">
          <span className="nodes-toolbar-label">Add node</span>
          {addActions}
        </section>
        {validationAction}
        {saveAction}
        {deleteAction}
      </OverflowMenu>
    </div>
  )
}
