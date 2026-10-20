import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from './modalFocus'

// Общая рама полноэкранного режима.
//
// Шапка «Отмена — название — Готово», рабочая область, полка снизу. Все режимы
// планшета живут в ней: скетч, обрезка, правка клипа, сравнение, архив,
// настройки. Один каркас — значит выход всегда в одном месте, и человек не
// ищет его заново в каждом режиме.

export function TabletFullScreen({
  title,
  subtitle,
  onCancel,
  cancelLabel = 'Cancel',
  center,
  primary,
  children,
  footer,
  tone,
  className,
}: {
  title: string
  subtitle?: ReactNode
  onCancel(): void
  cancelLabel?: string
  /** Управление посередине шапки: режимы, пропорции, кисти. */
  center?: ReactNode
  /** Главное действие справа: «Готово», «Применить». */
  primary?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** `dark` — для видео и сравнения: там смотрят материал, а не интерфейс. */
  tone?: 'dark'
  /** Optional mode scope for layout rules that must not affect other screens. */
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, onCancel)

  return createPortal(
    <div ref={ref} className={['tablet-full', tone === 'dark' ? 'dark' : '', className].filter(Boolean).join(' ')} role="dialog" aria-label={title} aria-modal="true" tabIndex={-1}>
      <header className="tablet-full-head">
        <button type="button" className="ui-btn quiet" onClick={onCancel}>{cancelLabel}</button>
        <div className="tablet-full-title">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {center && <div className="tablet-full-center">{center}</div>}
        {/* Распорка нужна ТОЛЬКО когда середины нет: иначе она делит свободное
            место с ней пополам, середина не помещается и выезжает поверх
            заголовка (поймано прогоном — палитра кистей легла на название). */}
        {!center && <span className="tablet-full-gap" />}
        {primary}
      </header>
      <div className="tablet-full-body">{children}</div>
      {footer && <footer className="tablet-full-foot">{footer}</footer>}
    </div>,
    document.body,
  )
}
