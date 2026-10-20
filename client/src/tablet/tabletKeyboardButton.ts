/** Выполняем фокус внутри исходного touchend, до совместимого mouse/click. */
export function bindTabletKeyboardButton(button: HTMLButtonElement, activate: () => void, scope: Window = window): () => void {
  let start: { x: number; y: number } | null = null
  let ignoreClickUntil = 0
  const cancel = () => { start = null }
  const onStart = (event: TouchEvent) => {
    const touch = event.touches[0]
    start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null
  }
  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!start || !touch || event.touches.length !== 1 || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12) cancel()
  }
  const onEnd = (event: TouchEvent) => {
    const tap = start && event.touches.length === 0
    cancel()
    if (!tap || button.disabled) return
    // Подавляем совместимый mouse/click: он не должен повторно переключать
    // клавиатуру или забирать фокус у только что открытого поля.
    event.preventDefault()
    ignoreClickUntil = Date.now() + 800
    activate()
  }
  const onClick = (event: MouseEvent) => {
    event.preventDefault()
    if (button.disabled || (event.detail !== 0 && Date.now() < ignoreClickUntil)) return
    activate()
  }
  button.addEventListener('touchstart', onStart, { passive: true })
  button.addEventListener('touchmove', onMove, { passive: true })
  button.addEventListener('touchend', onEnd, { passive: false })
  button.addEventListener('touchcancel', cancel)
  button.addEventListener('click', onClick)
  scope.addEventListener('canai-tablet-ui-scale', cancel)
  return () => {
    button.removeEventListener('touchstart', onStart)
    button.removeEventListener('touchmove', onMove)
    button.removeEventListener('touchend', onEnd)
    button.removeEventListener('touchcancel', cancel)
    button.removeEventListener('click', onClick)
    scope.removeEventListener('canai-tablet-ui-scale', cancel)
  }
}
