import { useState } from 'react'

/**
 * The empty assistant id is a real product state: questions use the default
 * model/instructions and no saved profile. Keep it separate from profile ids
 * so a profile can never collide with the picker sentinel.
 */
export const UNIVERSAL_ASSISTANT_ID = '__canai_universal__'

export interface AssistantPickerItem {
  id: string
  name: string
  scope?: 'team' | 'personal'
}

export type AssistantPickerVariant = 'shelf' | 'compact'

export interface AssistantPickerProps {
  items: readonly AssistantPickerItem[]
  activeId: string | null
  onSelect(id: string | null): void | Promise<void>
  onManage?(): void
  /** `shelf` keeps the original row; `compact` is intended for a dock field. */
  variant?: AssistantPickerVariant
  disabled?: boolean
  manageLabel?: string
  /** Whether management action is enabled. When false, onManage is omitted. */
  manage?: boolean
}

function itemValue(id: string | null): string {
  return id ?? UNIVERSAL_ASSISTANT_ID
}

function valueId(value: string): string | null {
  return value === UNIVERSAL_ASSISTANT_ID ? null : value
}

function itemTitle(item: AssistantPickerItem): string {
  return item.scope === 'team' ? `General: ${item.name}` : item.name
}

/**
 * A small, data-only selector shared by the prompt dock and the existing
 * assistant shelf. It deliberately receives the library from its owner: the
 * picker never invents helpers or performs a second library request.
 */
export function AssistantPicker({
  items,
  activeId,
  onSelect,
  onManage,
  variant = 'shelf',
  disabled = false,
  manageLabel = "Configure",
  manage = true,
}: AssistantPickerProps) {
  const [busy, setBusy] = useState(false)
  const active = items.find((item) => item.id === activeId)

  const choose = (id: string | null) => {
    if (disabled || busy || id === activeId) return
    setBusy(true)
    Promise.resolve(onSelect(id)).finally(() => setBusy(false))
  }

  if (variant === 'compact') {
    return (
      <div className="assistant-picker assistant-picker-compact" role="group" aria-label="Assistant selection">
        <span className="assistant-picker-label">Assistant:</span>
        <select
          className="assistant-picker-select"
          aria-label="Select assistant"
          value={itemValue(activeId)}
          disabled={disabled || busy}
          onChange={(event) => choose(valueId(event.target.value))}
        >
          <option value={UNIVERSAL_ASSISTANT_ID}>Universal</option>
          {items.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
        {active && <span className="assistant-picker-scope">{active.scope === 'team' ? "shared" : "my"}</span>}
        {manage && onManage && (
          <button
            type="button"
            className="assistant-picker-manage"
            disabled={disabled || busy}
            onClick={onManage}
          >
            {manageLabel}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="assistant-picker assistant-picker-shelf" role="group" aria-label="Assistants">
      <div className="macros-inline">
        <button
          type="button"
          className={`macros-inline-btn${activeId === null ? ' on' : ''}`}
          aria-pressed={activeId === null}
          disabled={disabled || busy}
          title={activeId === null ? "Universal assistant enabled" : "Enable Universal Assistant"}
          aria-label={activeId === null ? "Turn off profile selection, leave Universal" : "Enable Universal Assistant"}
          onClick={() => choose(null)}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="macro-slot-name">Universal</span>
        </button>
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`macros-inline-btn${activeId === item.id ? ' on' : ''}`}
            aria-pressed={activeId === item.id}
            disabled={disabled || busy}
            title={activeId === item.id ? `"${itemTitle(item)}" enabled` : `Enable "${itemTitle(item)}"`}
            aria-label={activeId === item.id ? `Disable assistant ${item.name}` : `Enable assistant ${item.name}`}
            onClick={() => choose(activeId === item.id ? null : item.id)}
            onMouseDown={(event) => event.preventDefault()}
          >
            <span className="macro-slot-name">{item.name}</span>
          </button>
        ))}
        {manage && onManage && (
          <button
            type="button"
            className="macros-inline-btn more"
            title="Manage assistants: edit, delete, add"
            aria-label="Manage assistants"
            disabled={disabled || busy}
            onClick={onManage}
          >
            ⋯
          </button>
        )}
      </div>
    </div>
  )
}
