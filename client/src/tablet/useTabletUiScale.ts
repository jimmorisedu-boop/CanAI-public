import { useEffect } from 'react'
import { touchShape } from './boardFingerGestures'
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_MIN_SPREAD_PX,
  pinchedUiScale,
  pinchTargetsChrome,
  readUiScale,
  roundUiScale,
  writeUiScale,
} from './uiScale'

// Подписка на щипок по панелям. Вся арифметика — в uiScale; здесь только
// события и запись в стиль.
//
// ⚠️ Масштаб кладём ПРЯМО в свойство корня, а не в состояние React: щипок
// пересчитывается на каждое движение пальцев, и перерисовывать на это весь
// интерфейс значит получить рывки вместо жеста. Тот же приём, что у камеры
// доски и у слоя меток на компьютере.

const SCALE_PROPERTY = '--tablet-ui-scale'
const PANEL_SCALE_PROPERTY = '--tablet-panel-scale'
const SCALE_EVENT = 'canai-tablet-ui-scale'

// Private browsing can expose `window.localStorage` and still throw from both
// accessors. Keep the last usable value in memory so the controls and a second
// pinch continue to work for the lifetime of this page.
let volatileScale = UI_SCALE_DEFAULT

function storageForWindow(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readCurrentScale(storage: Storage | null): number {
  const scale = roundUiScale(readUiScale(storage, volatileScale))
  volatileScale = scale
  return scale
}

function persistScale(storage: Storage | null, value: number): number {
  volatileScale = roundUiScale(value)
  writeUiScale(storage, volatileScale)
  return volatileScale
}

/**
 * ⚠️ Корня со стилем может не быть: планшетную оболочку поднимают и в
 * тестовой среде без настоящего DOM. Размер интерфейса не то, из-за чего
 * приложению позволено падать при старте.
 */
function apply(scale: number): void {
  const style = typeof document === 'undefined' ? null : document.documentElement?.style
  if (!style || typeof style.setProperty !== 'function') return
  const value = String(roundUiScale(scale))
  style.setProperty(SCALE_PROPERTY, value)
  style.setProperty(PANEL_SCALE_PROPERTY, value)
  // A transform does not change layout dimensions, so ResizeObserver alone
  // cannot tell the dock that its visual bounds changed. Consumers that cache
  // geometry subscribe to this lightweight notification.
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    const event = typeof Event === 'function'
      ? new Event(SCALE_EVENT)
      : ({ type: SCALE_EVENT } as Event)
    window.dispatchEvent(event)
  } catch {
    // A test shell may provide a partial window/Event implementation.
  }
}

export function adjustTabletUiScale(delta: number): void {
  const storage = storageForWindow()
  const scale = roundUiScale(readCurrentScale(storage) + delta)
  apply(scale)
  persistScale(storage, scale)
}

export function useTabletUiScale(active = true): void {
  useEffect(() => {
    // ⚠️ Оболочку планшета поднимают и без настоящего окна (прогон запуска в
    // тестовой среде). Щипок там просто не нужен, а падать нельзя.
    if (!active || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const storage = storageForWindow()
    apply(readCurrentScale(storage))

    let base = UI_SCALE_DEFAULT
    let startSpread = 0
    let current = UI_SCALE_DEFAULT
    let candidate = false
    let pinching = false

    const stop = (): void => {
      const wasPinching = pinching
      if (!wasPinching && !candidate) return
      pinching = false
      candidate = false
      if (wasPinching) persistScale(storage, current)
    }

    const onStart = (event: TouchEvent): void => {
      stop()
      if (event.touches.length !== 2) return
      const touches = Array.from(event.touches)
      if (!pinchTargetsChrome(touches.map((touch) => touch.target as Element))) return
      const shape = touchShape(Array.from(event.touches).map((touch) => (
        { x: touch.clientX, y: touch.clientY }
      )))
      if (!shape) return
      base = readCurrentScale(storage)
      current = base
      startSpread = shape.spread
      // Fingers often land close together. Keep a candidate until they spread
      // past the jitter floor instead of rejecting the whole gesture at start.
      candidate = true
      pinching = shape.spread >= UI_SCALE_MIN_SPREAD_PX
      if (pinching) candidate = false
      // Notify dock drag/resize owners as soon as the second finger arrives.
      // Without this first `touchmove` could move the dock before our pinch
      // arbitration takes effect.
      apply(current)
    }

    const onMove = (event: TouchEvent): void => {
      if (!pinching && !candidate) return
      const touches = Array.from(event.touches)
      if (touches.length !== 2 || !pinchTargetsChrome(touches.map((touch) => touch.target as Element))) {
        stop()
        return
      }
      const shape = touchShape(Array.from(event.touches).map((touch) => (
        { x: touch.clientX, y: touch.clientY }
      )))
      if (!shape) return
      if (!pinching) {
        if (shape.spread < UI_SCALE_MIN_SPREAD_PX) return
        // Activate at the first meaningful spread. This avoids a jump caused
        // by dividing by a near-zero initial distance.
        base = readCurrentScale(storage)
        current = base
        startSpread = shape.spread
        pinching = true
        candidate = false
      }
      // ⚠️ Гасим зум Safari: без этого страница приближается ОДНОВРЕМЕННО с
      // нашим масштабом, и человек получает оба сразу. Ради этого слушатель и
      // держится неленивым (passive: false) — иначе preventDefault молча ничего
      // не делает.
      if (event.cancelable !== false) event.preventDefault()
      current = pinchedUiScale(base, startSpread, shape.spread)
      apply(current)
    }

    // Safari зумит страницу своими gesture-событиями, и одного touchmove ему
    // мало: жест надо отменить в самом начале.
    const onGesture = (event: Event): void => {
      if (pinching || candidate) event.preventDefault()
    }

    // Capture prevents a prompt control that stops propagation from starving
    // the global arbiter. `touchmove` remains non-passive so Safari can be
    // stopped once the candidate becomes a real pinch.
    const capturePassive = { capture: true, passive: true } as const
    const captureActive = { capture: true, passive: false } as const
    window.addEventListener('touchstart', onStart, capturePassive)
    window.addEventListener('touchmove', onMove, captureActive)
    window.addEventListener('touchend', stop, capturePassive)
    window.addEventListener('touchcancel', stop, capturePassive)
    window.addEventListener('gesturestart', onGesture as EventListener, captureActive)
    window.addEventListener('gesturechange', onGesture as EventListener, captureActive)
    return () => {
      stop()
      window.removeEventListener('touchstart', onStart, capturePassive)
      window.removeEventListener('touchmove', onMove, captureActive)
      window.removeEventListener('touchend', stop, capturePassive)
      window.removeEventListener('touchcancel', stop, capturePassive)
      window.removeEventListener('gesturestart', onGesture as EventListener, captureActive)
      window.removeEventListener('gesturechange', onGesture as EventListener, captureActive)
    }
  }, [active])
}
