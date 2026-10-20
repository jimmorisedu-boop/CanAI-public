import React, { type ReactNode } from 'react'
import type { NoticeTone } from './InlineNotice'
import { systemMessage } from './systemMessage'

// Состояние-заглушка: содержимое показать НЕ ВЫШЛО, и вместо него стоит это.
// Отдельный компонент от InlineNotice именно поэтому — плашка сопровождает
// работающий экран, а эта штука его заменяет. Материал общий: стекло, тон
// точкой, кнопки пилюлями (см. DESIGN.md — заливок тоном в приложении нет).
export function OperationState({
  tone = 'error',
  title,
  detail,
  action,
  secondary,
  system,
  children,
}: {
  tone?: NoticeTone
  title: string
  detail?: string
  action?: { label: string; onClick(): void; disabled?: boolean }
  secondary?: { label: string; onClick(): void; disabled?: boolean }
  /** Translate application-owned title/detail fields. Error states default to true. */
  system?: boolean
  children?: ReactNode
}) {
  const translateSystem = system ?? tone === 'error'
  const visibleTitle = translateSystem ? systemMessage(title) : title
  const visibleDetail = translateSystem && detail ? systemMessage(detail) : detail
  return (
    <section
      className="operation-state"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="operation-state-dot" aria-hidden="true" />
      <div className="operation-state-content">
        <strong>{visibleTitle}</strong>
        {visibleDetail && <p>{visibleDetail}</p>}
        {(action || secondary || children) && (
          <div className="operation-state-actions">
            {action && <button disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
            {secondary && <button className="secondary" disabled={secondary.disabled} onClick={secondary.onClick}>{secondary.label}</button>}
            {children}
          </div>
        )}
      </div>
    </section>
  )
}
