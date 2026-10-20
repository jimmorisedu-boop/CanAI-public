import type { CanvasItem } from './types'

/** GIF images are decoded by the local canvas player instead of a static frame. */
export function isAnimatedImageItem(item: Pick<CanvasItem, 'src' | 'mime' | 'name'>): boolean {
  if (item.mime) return item.mime.toLowerCase() === 'image/gif'
  const path = (item.src ?? '').split('?')[0] ?? ''
  return /\.gif$/iu.test(path) || /\.gif$/iu.test(item.name ?? '')
}

export function gifFrameDelayMs(durationMicros: number | null | undefined): number {
  const ms = (durationMicros ?? 0) / 1000
  return ms <= 10 ? 100 : ms
}
