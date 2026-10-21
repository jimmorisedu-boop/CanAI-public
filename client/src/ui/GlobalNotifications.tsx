import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import { onToast, type ToastMessage } from '../spaces/canvas/toastBus'
import { applyToastEvent } from './globalNotificationModel'
import { AUTO_DISMISS_MS, autoDismissDelay } from './noticeTiming'
import { useDismissOnOutsidePointer } from './dismissOnOutside'
import { useT } from '../i18n/context.js'


export function GlobalNotifications() {
  const t = useT()
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const timersRef = useRef(new Map<string, number>())
  // какой id сейчас занимает каждый replaceKey — чтобы снять его таймер
  const keysRef = useRef(new Map<string, string>())

  const boxRef = useRef<HTMLDivElement>(null)

  const dismissAll = useCallback(() => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
    keysRef.current.clear()
    setToasts([])
  }, [])

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    for (const [replaceKey, toastId] of keysRef.current) {
      if (toastId === id) keysRef.current.delete(replaceKey)
    }
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    const unsubscribe = onToast((event) => {
      if (event.type === 'dismiss') {
        const id = keysRef.current.get(event.replaceKey)
        if (id === undefined) return
        const timer = timersRef.current.get(id)
        if (timer !== undefined) window.clearTimeout(timer)
        timersRef.current.delete(id)
        keysRef.current.delete(event.replaceKey)
        setToasts((current) => applyToastEvent(current, event))
        return
      }

      const { toast } = event
      if (toast.replaceKey) {
        // Таймер вытесняемого сообщения снимаем ЗДЕСЬ, а не внутри updater'а:
        // updater React вправе вызвать дважды, а гасить чужие таймеры дважды —
        // способ однажды погасить не тот.
        const previous = keysRef.current.get(toast.replaceKey)
        if (previous !== undefined) {
          const timer = timersRef.current.get(previous)
          if (timer !== undefined) window.clearTimeout(timer)
          timersRef.current.delete(previous)
        }
        keysRef.current.set(toast.replaceKey, toast.id)
      }
      setToasts((current) => applyToastEvent(current, event))
      const delay = autoDismissDelay(toast.kind, AUTO_DISMISS_MS, Boolean(toast.action))
      if (delay !== null) {
        const timer = window.setTimeout(() => removeToast(toast.id), delay)
        timersRef.current.set(toast.id, timer)
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timersRef.current.values()) window.clearTimeout(timer)
      timersRef.current.clear()
      keysRef.current.clear()
    }
  }, [removeToast])

  // Клик мимо гасит показанное: сообщение уже прочитано, а ждать таймер,
  // когда хочешь работать дальше, незачем.
  useDismissOnOutsidePointer(toasts.length > 0, boxRef, dismissAll)

  if (!toasts.length) return null
  return (
    <div className="global-notifications" aria-live="polite" ref={boxRef}>
      {toasts.map((toast) => {
        // крестик нужен только там, где сообщение не уйдёт само (ошибки):
        // у обычных уведомлений он был лишним шумом рядом с действием
        const staysUntilClosed = autoDismissDelay(toast.kind, AUTO_DISMISS_MS, Boolean(toast.action)) === null
        return (
          <div
            className={`global-toast ${toast.kind}`}
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{toast.message}</span>
            {toast.action && (
              <button
                className="global-toast-action"
                onClick={() => {
                  toast.action?.run()
                  removeToast(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
            {staysUntilClosed && (
              <button
                className="global-toast-close"
                aria-label={t('Close')}
                onClick={() => removeToast(toast.id)}
              >
                <IconClose size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
