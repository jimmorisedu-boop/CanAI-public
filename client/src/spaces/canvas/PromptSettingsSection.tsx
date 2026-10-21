import { useEffect, useId, useRef, type ReactNode } from 'react'
import { IconSettings } from '../../ui/icons'
import { useT } from '../../i18n/context.js'


export function PromptSettingsSection({
  compact,
  open,
  attention,
  onOpenChange,
  children,
}: {
  compact: boolean
  open: boolean
  attention?: boolean
  onOpenChange(open: boolean): void
  children: ReactNode
}) {
  const t = useT()
  const regionId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!compact && open) onOpenChange(false)
  }, [compact, onOpenChange, open])

  useEffect(() => {
    if (!compact || !open) return
    const frame = requestAnimationFrame(() => {
      regionRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [compact, open])

  return (
    <div className="prompt-settings-section" data-compact={compact || undefined}>
      {compact && (
        <button
          ref={triggerRef}
          type="button"
          className="prompt-settings-trigger"
          aria-expanded={open}
          aria-controls={regionId}
          data-attention={attention || undefined}
          onClick={() => onOpenChange(!open)}
        >
          <IconSettings size={16} />

          {t('Parameters')}
        </button>
      )}
      <div
        ref={regionRef}
        id={regionId}
        className="prompt-settings-region"
        role={compact ? 'region' : undefined}
        aria-label={compact ? t('Generation parameters') : undefined}
        hidden={compact && !open}
        onKeyDown={(event) => {
          if (!compact || event.key !== 'Escape') return
          event.preventDefault()
          onOpenChange(false)
          requestAnimationFrame(() => triggerRef.current?.focus())
        }}
      >
        {children}
      </div>
    </div>
  )
}
