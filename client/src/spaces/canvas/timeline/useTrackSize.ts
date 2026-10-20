import { useLayoutEffect, useState, type RefObject } from 'react'

// Размер дорожки для плёнки: от него зависит, сколько кадров в неё ляжет. Брать
// каждое мельчайшее изменение нельзя — плёнку пришлось бы пересобирать (то есть
// заново гонять перемотки видео) на каждый пиксель при растягивании окна. Поэтому
// размер «залипает»: новое значение принимается, только когда ширина ушла
// заметно (WIDTH_STEP) или сменилась высота (дорожка на тач-экране выше).

/** На сколько (долей прежней ширины) должна измениться дорожка, чтобы плёнку пересчитали. */
export const WIDTH_STEP = 0.12

export interface TrackSize { width: number; height: number }

/** Принять ли новый размер вместо прежнего. Чистое правило — проверяется без DOM. */
export function shouldAcceptTrackSize(prev: TrackSize, next: TrackSize): boolean {
  if (next.width <= 0 || next.height <= 0) return false
  if (prev.width <= 0 || prev.height <= 0) return true
  if (Math.abs(next.height - prev.height) >= 2) return true
  return Math.abs(next.width - prev.width) / prev.width >= WIDTH_STEP
}

export function useTrackSize(ref: RefObject<HTMLElement>): TrackSize {
  const [size, setSize] = useState<TrackSize>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight }
      setSize((prev) => (shouldAcceptTrackSize(prev, next) ? next : prev))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}
