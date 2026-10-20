import React, { useEffect, useRef, type ReactNode } from 'react'
import { IconClose } from './icons'
import { scheduleAutoDismiss } from './noticeTiming'
import { systemMessage } from './systemMessage'

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

export function InlineNotice({
  tone = 'info',
  title,
  detail,
  action,
  secondary,
  onDismiss,
  autoDismissMs,
  system,
  className = '',
  children,
}: {
  tone?: NoticeTone
  title?: string
  detail?: string
  action?: { label: string; onClick(): void; disabled?: boolean }
  secondary?: { label: string; onClick(): void; disabled?: boolean }
  onDismiss?: () => void
  autoDismissMs?: number
  /** Translate application-owned title/detail fields. Error notices default to true. */
  system?: boolean
  className?: string
  children?: ReactNode
}) {
  const dismissRef = useRef(onDismiss)
  const dismissible = Boolean(onDismiss)
  const translateSystem = system ?? tone === 'error'
  // Keep optional fields absent. Calling systemMessage(undefined) would add a
  // diagnostic fallback title/detail to notices that intentionally render
  // only one field (for example a wizard error shown as detail).
  const visibleTitle = translateSystem && title ? systemMessage(title) : title
  const visibleDetail = translateSystem && detail ? systemMessage(detail) : detail

  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(
    () => scheduleAutoDismiss({
      tone,
      requestedMs: autoDismissMs,
      onDismiss: dismissible ? () => dismissRef.current?.() : undefined,
    }),
    [tone, autoDismissMs, dismissible, title, detail],
  )

  return (
    <section
      className={`inline-notice ${className}`.trim()}
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {/* тон — точкой, как у всплывающих уведомлений: заливка во всю плашку
          и крупная иконка кричали громче самого сообщения */}
      <span className="inline-notice-dot" aria-hidden="true" />
      <div className="inline-notice-content">
        {visibleTitle && <strong>{visibleTitle}</strong>}
        {visibleDetail && <p>{visibleDetail}</p>}
        {children && <div className="inline-notice-body">{children}</div>}
      </div>
      {(action || secondary) && (
        <div className="inline-notice-actions">
          {action && <button disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
          {secondary && <button className="secondary" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</button>}
        </div>
      )}
      {onDismiss && (
        <button className="inline-notice-dismiss" aria-label="Close message" onClick={onDismiss}>
          <IconClose size={14} />
        </button>
      )}
    </section>
  )
}
