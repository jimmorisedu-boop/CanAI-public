export type OrientationState = 'ok' | 'rotate' | 'widen'

export interface OrientationInput {
  /** Размер окна страницы. */
  viewport: { w: number; h: number }
  /** Размер всего экрана устройства. */
  screen: { w: number; h: number }
}

// Обе ориентации и Split View используют одну и ту же смонтированную доску.
export function orientationState({ viewport }: OrientationInput): OrientationState {
  if (viewport.w < 2 || viewport.h < 2) return 'ok'
  return viewport.w < 320 ? 'widen' : 'ok'
}

export function readOrientation(): OrientationState {
  if (typeof window === 'undefined') return 'ok'
  return orientationState({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    screen: { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0 },
  })
}

/** Подписка на повороты и изменения окна. Возвращает отписку. */
export function watchOrientation(onChange: (state: OrientationState) => void): () => void {
  const notify = () => onChange(readOrientation())
  window.addEventListener('resize', notify)
  window.addEventListener('orientationchange', notify)
  return () => {
    window.removeEventListener('resize', notify)
    window.removeEventListener('orientationchange', notify)
  }
}
