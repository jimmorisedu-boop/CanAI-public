import { useEffect, useRef } from 'react'
import { boardHistoryInputAllowed } from './boardHistoryInput'
import {
  beginRelease,
  beginSession,
  endSession,
  HOLD_REPEAT_MS,
  touchShape,
  trackHold,
  trackMove,
  type FingerAction,
  type FingerSession,
} from './boardFingerGestures'

// Подписка на жесты несколькими пальцами. Вся арифметика — в
// boardFingerGestures; здесь только события и тик удержания.
//
// ⚠️ Слушаем ОКНО, а не холст: пальцы легко оказываются частью на объекте,
// частью на пустом месте, а два касания подряд вообще приходят разным целям.
// Зато поэтому же приходится спрашивать boardHistoryInputAllowed — в поле
// ввода у iPadOS свои жесты (три пальца влево — отмена ввода), и отбирать их
// у системы нельзя.

export interface FingerGestureHandlers {
  undo(): unknown
  redo(): unknown
  clipboard(at: { x: number; y: number }): unknown
  chrome(): unknown
}

export function useBoardFingerGestures(handlers: FingerGestureHandlers, active: boolean): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    if (!active) return
    let session: FingerSession | null = null
    let holdTimer: number | null = null
    let center = { x: 0, y: 0 }

    const run = (action: FingerAction): void => {
      if (action === 'undo') ref.current.undo()
      else if (action === 'redo') ref.current.redo()
      else if (action === 'clipboard') ref.current.clipboard(center)
      else ref.current.chrome()
    }

    const stopHold = (): void => {
      if (holdTimer !== null) window.clearInterval(holdTimer)
      holdTimer = null
    }

    const allowed = (event: TouchEvent): boolean => {
      const boardOnly = event.touches.length !== 4 && session?.fingers !== 4
      return boardHistoryInputAllowed(event.target, boardOnly)
        && Array.from(event.touches).every((touch) => boardHistoryInputAllowed(touch.target, boardOnly))
    }

    const points = (touches: TouchList): Array<{ x: number; y: number }> => (
      Array.from(touches).map((touch) => ({ x: touch.clientX, y: touch.clientY }))
    )

    const onStart = (event: TouchEvent): void => {
      stopHold()
      if (session?.releasing) return
      if (!allowed(event)) {
        session = null
        return
      }
      const at = points(event.touches)
      const start = touchShape(at)
      if (!start) {
        session = null
        return
      }
      center = start.center
      // Добавили палец — жест начинается заново: два пальца плюс третий это
      // «вернуть», а не «отменить» с довеском.
      session = beginSession(at.length, start, Date.now())
      if (!session) return
      if (event.cancelable) event.preventDefault()
      holdTimer = window.setInterval(() => {
        if (!session) return
        const action = trackHold(session, Date.now())
        if (action) run(action)
      }, HOLD_REPEAT_MS)
    }

    const onMove = (event: TouchEvent): void => {
      if (!session || !allowed(event)) return
      if (event.cancelable) event.preventDefault()
      const now = touchShape(points(event.touches))
      if (!now) return
      center = now.center
      const action = trackMove(session, now, Date.now())
      if (action) {
        stopHold()
        run(action)
      }
    }

    const onEnd = (event: TouchEvent): void => {
      stopHold()
      if (!session) return
      // Число пальцев уже сохранено в session. Первое отпускание завершает
      // тап, остальные touchend не должны запускать вторую команду.
      const action = session.releasing ? null : endSession(session, Date.now())
      beginRelease(session)
      if (action) session.fired = true
      if (event.cancelable) event.preventDefault()
      if (event.touches.length === 0) session = null
      if (action) run(action)
    }

    const onCancel = (): void => {
      stopHold()
      session = null
    }

    window.addEventListener('touchstart', onStart, { passive: false })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd, { passive: false })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      stopHold()
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [active])
}
