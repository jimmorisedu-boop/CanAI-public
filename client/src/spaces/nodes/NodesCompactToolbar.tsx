import type { ReactNode } from 'react'
import { OverflowMenu } from '../../ui/OverflowMenu'
import { IconBack } from '../../ui/icons'
import { useT } from '../../i18n/context.js'


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
  const t = useT()
  return (
    <div className="nodes-toolbar nodes-toolbar-compact">
      <button
        type="button"
        className="node-add-btn nodes-back icon-tab"
        onClick={onBack}
        title={t('Back to canvas')}
      >
        <IconBack size={16} />  {t('Canvas')}
      </button>
      <input
        className="macro-name-input"
        aria-label={t('Macro name')}
        placeholder={placeholder}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        title={t('Macro name (slot button label)')}
        disabled={!loaded}
      />
      <OverflowMenu
        label={t('More')}
        panelLabel="Macro actions"
        attention={attention}
        compact
        defaultOpen={defaultMenuOpen}
      >
        <section className="nodes-compact-add" aria-label={t('Add node')}>
          <span className="nodes-toolbar-label">{t('Add node')}</span>
          {addActions}
        </section>
        {validationAction}
        {saveAction}
        {deleteAction}
      </OverflowMenu>
    </div>
  )
}
