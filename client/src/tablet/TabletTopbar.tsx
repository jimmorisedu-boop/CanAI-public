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
  const add = useAnchor()
  const more = useAnchor()
  const exporting = useAnchor()
  const [pressedAdd, setPressedAdd] = useState(false)

  const note = state.selectionCount > 0
    ? `selected: ${state.selectionCount}`
    : state.saveNote
  const selectLabel = state.multiSelect ? 'Done' : 'Select'

  return (
    <header className="tablet-topbar tablet-board-topbar">
      <button
        type="button"
        className="ui-btn quiet tablet-back"
        aria-label="To boards"
        title="To boards"
        onClick={actions.onExit}
      >
        <IconBack size={18} /><span>Boards</span>
      </button>

      <button
        type="button"
        className="tablet-title"
        disabled={state.canManage === false}
        onClick={actions.onRename}
        title={state.canManage === false ? undefined : 'Rename board'}
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
          aria-label="Undo"
          title="Undo"
          disabled={!state.canUndo}
          onClick={actions.onUndo}
        >
          <IconUndo size={20} />
        </button>}
        {state.canEdit !== false && <button
          type="button"
          className="ui-icon-btn tablet-icon"
          aria-label="Retry"
          title="Retry"
          disabled={!state.canRedo}
          onClick={actions.onRedo}
        >
          <IconRedo size={20} />
        </button>}

        <span className="tablet-topbar-sep" />

        {state.canEdit !== false && <button
          type="button"
          className={`ui-btn quiet tablet-topbar-button tablet-topbar-add ${pressedAdd ? 'on' : ''}`}
          aria-label="Add to board"
          title="Add to board"
          onClick={(event) => {
            setPressedAdd(true)
            add.open(event)
          }}
        >
          <IconPlus size={20} /><span>Add</span>
        </button>}
        {state.canEdit !== false && <button
          type="button"
          className={`ui-btn quiet tablet-topbar-button tablet-topbar-select ${state.multiSelect ? 'on' : ''}`}
          aria-label={state.multiSelect ? `Done${state.selectionCount > 0 ? `, selected ${state.selectionCount}` : ''}` : 'Select multiple'}
          title={state.multiSelect ? 'Done' : 'Select multiple'}
          aria-pressed={state.multiSelect}
          onClick={actions.onToggleSelect}
        >
          <IconCursor size={20} /><span>{selectLabel}{state.multiSelect && state.selectionCount > 0 ? ` · ${state.selectionCount}` : ''}</span>
        </button>}
        <button
          type="button"
          className="ui-btn quiet tablet-topbar-button tablet-topbar-tasks tablet-icon-badged"
          aria-label={state.activeTasks > 0 ? `Tasks: running ${state.activeTasks}` : 'Tasks'}
          title={state.activeTasks > 0 ? `Tasks: running ${state.activeTasks}` : 'Tasks'}
          onClick={actions.onTasks}
        >
          <IconTasks size={20} /><span>Tasks</span>
          {state.activeTasks > 0 && <span className="tablet-badge">{state.activeTasks}</span>}
        </button>
        <button
          type="button"
          className="ui-btn quiet tablet-topbar-button tablet-topbar-export"
          aria-label="Export board"
          title="Export board"
          onClick={exporting.open}
        >
          <IconExport size={20} /><span>Export</span>
        </button>
        <button
          type="button"
          className="ui-icon-btn tablet-icon"
          aria-label="More"
          title="More"
          onClick={more.open}
        >
          <span className="tablet-more-dots" aria-hidden="true">•••</span>
        </button>
      </div>

      {state.canEdit !== false && add.anchor && (
        <TabletPopover
          anchor={add.anchor}
          label="What to add"
          onClose={() => {
            add.close()
            setPressedAdd(false)
          }}
        >
          <MenuItem icon={<IconImage size={19} />} label="Image" onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('image') }} />
          <MenuItem icon={<IconVideo size={19} />} label="Video" onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('video') }} />
          <MenuItem icon={<IconSound size={19} />} label="Sound" onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('audio') }} />
          <MenuItem icon={<IconText size={19} />} label="Text" onClick={() => { add.close(); setPressedAdd(false); actions.onAdd('text') }} />
        </TabletPopover>
      )}

      {exporting.anchor && (
        <TabletPopover anchor={exporting.anchor} label="Download" onClose={exporting.close}>
          <MenuItem icon={<IconExport size={19} />} label={`Selected objects · ${state.selectionCount}`} disabled={!state.selectionCount || !actions.onExportSelected} onClick={() => { exporting.close(); actions.onExportSelected?.() }} />
          <MenuItem icon={<IconExport size={19} />} label={`Entire board${state.exportCount === undefined ? '' : ` · ${state.exportCount}`}`} onClick={() => { exporting.close(); actions.onExport() }} />
        </TabletPopover>
      )}
      {more.anchor && (
        <TabletPopover anchor={more.anchor} label="More" onClose={more.close}>
          <MenuItem icon={<IconFitAll size={19} />} label="Show all" onClick={() => { more.close(); actions.onFitAll() }} />
          <MenuItem icon={<IconExact size={19} />} label="1:1" onClick={() => { more.close(); actions.onZoomActual() }} />
          {actions.onObjects && <MenuItem icon={<IconCursor size={19} />} label="Board objects" onClick={() => { more.close(); actions.onObjects?.() }} />}
          <MenuItem icon={<span>−</span>} label="Smaller interface" onClick={() => adjustTabletUiScale(-0.1)} />
          <MenuItem icon={<span>+</span>} label="Larger interface" onClick={() => adjustTabletUiScale(0.1)} />
          <span className="tablet-menu-sep" />
          <MenuItem icon={<IconSun size={19} />} label="Theme" onClick={() => { more.close(); actions.onTheme() }} />
          <MenuItem icon={<IconHelp size={19} />} label="Help" onClick={() => { more.close(); actions.onHelp() }} />
          {state.localFeatures !== false && <MenuItem icon={<IconSettings size={19} />} label="Settings" onClick={() => { more.close(); actions.onSettings() }} />}
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
