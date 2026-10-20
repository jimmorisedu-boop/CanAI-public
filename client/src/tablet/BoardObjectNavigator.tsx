import { useId } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { boardObjectLabel } from './boardObjectNavigation'

/** Явные флажки работают и пальцем, и с клавиатуры, включая объекты вне кадра. */
export function BoardObjectNavigator({ store, readOnly, reveal, onActivate }: {
  store: CanvasStore
  readOnly?: boolean
  reveal(id: string): void
  onActivate(id: string): void
}) {
  useContentVersion(store)
  const id = useId()
  const items = store.getItems()
  const selected = items.filter((item) => store.getSelectedIds().has(item.id))
  return (
    <details open className="tablet-object-navigator" data-tablet-interactive onWheel={(event) => event.stopPropagation()}>
      <summary>Objects ({items.length})</summary>
      <div className="tablet-object-navigator-body">
        <label htmlFor={id}>Board objects</label>
        <div id={id} className="tablet-object-list" role="group" aria-label="Board objects">
          {items.map((item, index) => <label key={item.id}>
            <input type="checkbox" checked={store.getSelectedIds().has(item.id)} onChange={() => { store.select(item.id, true); reveal(item.id) }} />
            <span>{index + 1}. {boardObjectLabel(item)}</span>
          </label>)}
          {!items.length && <p>There are no objects on the board yet</p>}
        </div>
        <p role="status">Selected: {selected.length}{readOnly ? ' · View only' : ''}</p>
        <button type="button" className="ui-btn" disabled={readOnly || !selected.length}
          onClick={() => { if (!readOnly && selected[0]) onActivate(selected[0].id) }}>Actions for selection</button>
      </div>
    </details>
  )
}
