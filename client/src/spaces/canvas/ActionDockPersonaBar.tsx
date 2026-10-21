import type { ReactNode } from 'react'
import { useT } from '../../i18n/context.js'


export interface ActionDockPersonaBarProps {
  children: ReactNode
  hintText: string
  isPreparing?: boolean
  preparingText?: string
  onStop?(): void
}

/**
 * Persona selector bar positioned directly beneath the Action Dock mode tabs.
 * Renders the assistant picker and the mode/helper hint.
 * When a preparation run is active, displays a status row with a Stop button.
 */
export function ActionDockPersonaBar({
  children,
  hintText,
  isPreparing = false,
  preparingText,
  onStop,
}: ActionDockPersonaBarProps) {
  const t = useT()
  return (
    <div className="action-dock-persona-wrapper">
      <div className="action-dock-persona-bar">
        <div className="action-dock-persona-picker-slot">
          {children}
        </div>
        {hintText ? <span className="action-dock-mode-hint">{hintText}</span> : null}
      </div>
      {isPreparing && (
        <div className="action-dock-persona-status" role="status" aria-live="polite">
          <span className="action-dock-persona-status-text">
            {preparingText || "Assistant is preparing a request…"}
          </span>
          {onStop && (
            <button
              type="button"
              className="action-dock-persona-stop"
              onClick={onStop}
            >

              {t('Stop')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
