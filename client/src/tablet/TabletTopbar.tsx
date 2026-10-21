import { adjustTabletUiScale } from './useTabletUiScale'
import { useState } from 'react'
import {
  IconBack,
  IconCursor,
  IconExact,
  IconExport,
  IconFitAll,
  IconHelp,
  IconImage,
  IconPlus,
  IconRedo,
  IconSettings,
  IconSun,
  IconSound,
  IconTasks,
  IconText,
  IconUndo,
  IconVideo,
} from '../ui/icons'
import { TabletPopover, useAnchor } from './TabletPopover'
import { useT } from '../i18n/context.js'


// Панель доски.
//
// Порядок слева направо повторяет ход мысли: где я → что правлю → что добавить
// → чем управлять. Отмена и повтор стоят кнопками, а не только жестом: жест
// нужно знать, кнопку — видно.

export interface TopbarState {
  boardName: string
  saveNote: string
  selectionCount: number
  exportCount?: number
  activeTasks: number
  multiSelect: boolean
  canUndo: boolean
  canRedo: boolean
  canEdit?: boolean
  canManage?: boolean
  localFeatures?: boolean
}

export interface TopbarActions {
  onExit(): void
  onRename(): void
  onUndo(): void
  onRedo(): void
  onAdd(kind: 'image' | 'video' | 'audio' | 'text'): void
  onToggleSelect(): void
  onTasks(): void
  onExport(): void
  onExportSelected?(): void
  onObjects?(): void
  onTheme(): void
  onHelp(): void
  onSettings(): void
  onFitAll(): void
  onZoomActual(): void
}

export function TabletTopbar({ state, actions }: { state: TopbarState; actions: TopbarActions }) {
  const t = useT()
  const add = useAnchor()
  const more = useAnchor()
  const exporting = useAnchor()
  const [pressedAdd, setPressedAdd] = useState(false)

  const note = state.selectionCount > 0
    ? t('selected: {0}', { 0: state.selectionCount })
    : t(state.saveNote)
  const selectLabel = state.multiSelect ? t('Done') : t('Select')

  return (
    <header className="tablet-topbar tablet-board-topbar">
      <button
        type="button"
        className="ui-btn quiet tablet-back"
        aria-label={t('To boards')}
        title={t('To boards')}
        onClick={actions.onExit}
      >
        <IconBack size={18} /><span>{t('Boards')}</span>
      </button>

      <button
        type="button"
        className="tablet-title"
        disabled={state.canManage === false}
        onClick={actions.onRename}
        title={state.canManage === false ? undefined : t('Rename board')}
      >
        <strong>{state.boardName}</strong>
        <small>{note}</small>
      </button>

      <span className="tablet-topbar-gap" />

      <div className="tablet-topbar-actions">
        <div id="top-bar-participants-portal" style={{ display: 'contents' }} />
        {state.canEdit !== false && <button
          type="button"
          className="ui-icon-btn tablet-icon"
          aria-label={t('Undo')}
          title={t('Undo')}
          disabled={!state.canUndo}
          onClick={actions.onUndo}
        >
          <IconUndo size={20} />
        </button>}
        {state.canEdit !== false && <button
          type="button"
          className="ui-icon-btn tablet-icon"
          aria-label={t('Retry')}
          title={t('Retry')}
          disabled={!state.canRedo}
          onClick={actions.onRedo}
        >
          <IconRedo size={20} />
        </button>}

        <span className="tablet-topbar-sep" />

        {state.canEdit !== false && <button
          type="button"
          className={`ui-btn quiet tablet-topbar-button tablet-topbar-add ${pressedAdd ? 'on' : ''}`}
          aria-label={t('Add to board')}
          title={t('Add to board')}
          onClick={(event) => {
            setPressedAdd(true)
            add.open(event)
          }}
        >
          <IconPlus size={20} /><span>{t('Add')}</span>
        </button>}
        {state.canEdit !== false && <button
          type="button"
          className={`ui-btn quiet tablet-topbar-button tablet-topbar-select ${state.multiSelect ? 'on' : ''}`}
          aria-label={state.multiSelect ? t('Done{0}', { 0: state.selectionCount > 0 ? `, selected ${state.selectionCount}` : '' }) : t('Select multiple')}
          title={state.multiSelect ? t('Done') : t('Select multiple')}
          aria-pressed={state.multiSelect}
          onClick={actions.onToggleSelect}
        >
          <IconCursor size={20} /><span>{selectLabel}{state.multiSelect && state.selectionCount > 0 ? ` · ${state.selectionCount}` : ''}</span>
        </button>}
        <button
          type="button"
          className="ui-btn quiet tablet-topbar-button tablet-topbar-tasks tablet-icon-badged"
          aria-label={state.activeTasks > 0 ? t('Tasks: running {0}', { 0: state.activeTasks }) : t('Tasks')}
          title={state.activeTasks > 0 ? t('Tasks: running {0}', { 0: state.activeTasks }) : t('Tasks')}
          onClick={actions.onTasks}
        >
          <IconTasks size={20} /><span>{t('Tasks')}</span>
          {state.activeTasks > 0 && <span className="tablet-badge">{state.activeTasks}</span>}
        </button>
        <button
          type="button"
          className="ui-btn quiet tablet-topbar-button tablet-topbar-export"
          aria-label={t('Export board')}
          title={t('Export board')}
          onClick={exporting.open}
        >
          <IconExport size={20} /><span>{t('Export')}</span>
        </button>
        <button
          type="button"
          className="ui-icon-btn tablet-icon"
          aria-label={t('More')}
          title={t('More')}
          onClick={more.open}
        >
          <span className="tablet-more-dots" aria-hidden="true">•••</span>
        </button>
      </div>

      {state.canEdit !== false && add.anchor && (
        <TabletPopover
          anchor={add.anchor}
          label={t('What to add')}
          onClose={() => {
            add.close()
            setPressedAdd(false)
          }}
        >
          <MenuItem icon={<IconImage size={19} />} label={t('Image')} onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('image') }} />
          <MenuItem icon={<IconVideo size={19} />} label={t('Video')} onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('video') }} />
          <MenuItem icon={<IconSound size={19} />} label={t('Sound')} onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('audio') }} />
          <MenuItem icon={<IconText size={19} />} label={t('Text')} onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('text') }} />
        </TabletPopover>
      )}

      {exporting.anchor && (
        <TabletPopover anchor={exporting.anchor} label={t('Download')} onClose={exporting.close}>
          <MenuItem icon={<IconExport size={19} />} label={t('Selected objects · {0}', { 0: state.selectionCount })} disabled={!state.selectionCount || !actions.onExportSelected} onClick={() => { exporting.close(); actions.onExportSelected?.() }} />
          <MenuItem icon={<IconExport size={19} />} label={t('Entire board{0}', { 0: state.exportCount === undefined ? '' : ` · ${state.exportCount}` })} onClick={() => { exporting.close(); actions.onExport() }} />
        </TabletPopover>
      )}
      {more.anchor && (
        <TabletPopover anchor={more.anchor} label={t('More')} onClose={more.close}>
          <MenuItem icon={<IconFitAll size={19} />} label={t('Show all')} onClick={() => { more.close(); actions.onFitAll() }} />
          <MenuItem icon={<IconExact size={19} />} label="1:1" onClick={() => { more.close(); actions.onZoomActual() }} />
          {actions.onObjects && <MenuItem icon={<IconCursor size={19} />} label={t('Board objects')} onClick={() => { more.close(); actions.onObjects?.() }} />}
          <MenuItem icon={<span>−</span>} label={t('Smaller interface')} onClick={() => adjustTabletUiScale(-0.1)} />
          <MenuItem icon={<span>+</span>} label={t('Larger interface')} onClick={() => adjustTabletUiScale(0.1)} />
          <span className="tablet-menu-sep" />
          <MenuItem icon={<IconSun size={19} />} label={t('Theme')} onClick={() => { more.close(); actions.onTheme() }} />
          <MenuItem icon={<IconHelp size={19} />} label={t('Help')} onClick={() => { more.close(); actions.onHelp() }} />
          {state.localFeatures !== false && <MenuItem icon={<IconSettings size={19} />} label={t('Settings')} onClick={() => { more.close(); actions.onSettings() }} />}
        </TabletPopover>
      )}
    </header>
  )
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  disabled?: boolean
  onClick(): void
}) {
  return (
    <button type="button" className="tablet-menu-item" disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {hint && <em>{hint}</em>}
    </button>
  )
}
