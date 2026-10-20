import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from '../tablet/modalFocus'
import { registerConfirmHost, type ConfirmRequest } from './confirmBus'

interface Pending {
  request: ConfirmRequest
  resolve(ok: boolean): void
}

// Одно окно подтверждения на всё приложение. Монтируется рядом с тостами.
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Esc и клик мимо = отказ. Именно отказ, а не «ничего не произошло»:
  // вызывающий код обязан узнать ответ в любом случае.
  const close = (ok: boolean) => {
    setPending((current) => {
      current?.resolve(ok)
      return null
    })
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // ConfirmHost stays mounted while its portal is empty. `active` lets the
  // shared tablet focus manager register the dialog when the first request
  // appears, after the fullscreen editor has already claimed focus.
  useModalFocus(dialogRef, () => closeRef.current(false), 10, Boolean(pending))

  useEffect(() => {
    registerConfirmHost((request, resolve) => {
      // второй вопрос поверх первого: прежний честно отвечает «нет»
      setPending((current) => {
        current?.resolve(false)
        return { request, resolve }
      })
    })
    return () => registerConfirmHost(null)
  }, [])

  if (!pending) return null
  const { request } = pending

  return createPortal(
    <div
      className="modal-backdrop confirm-modal-backdrop"
      style={{ zIndex: 'calc(var(--z-modal, 1000) + 1)' }}
      onClick={() => close(false)}
    >
      <div
        ref={dialogRef}
        className="modal-card confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title">{request.title}</h2>
        {request.detail && <p className="confirm-detail">{request.detail}</p>}
        {request.rows && request.rows.length > 0 && (
          <dl className="confirm-rows">
            {request.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={() => close(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`confirm-ok ${request.danger ? 'danger' : ''}`}
            onClick={() => close(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
