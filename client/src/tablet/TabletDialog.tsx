import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../ui/icons'
import { useModalFocus } from './modalFocus'
import { useT } from '../i18n/context.js'


// Окно поверх экрана: переименование доски, вопрос, короткая форма.
//
// Форма общая с приложением (шапка с заголовком и крестиком, тело, ряд
// действий) — иначе планшет заведёт третий вид окна там, где уже есть два.

export function TabletDialog({
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  title: string
  onClose(): void
  children: ReactNode
  actions?: ReactNode
  wide?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)

  useModalFocus(ref, onClose)

  return createPortal(
    <div className="tablet-modal-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className={`tablet-modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-label={title} aria-modal="true" tabIndex={-1}>
        <header className="tablet-modal-head">
          <h2>{title}</h2>
          <button type="button" className="ui-icon-btn" aria-label={t('Close')} onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <div className="tablet-modal-body">{children}</div>
        {actions && <footer className="tablet-modal-foot">{actions}</footer>}
      </div>
    </div>,
    document.body,
  )
}
