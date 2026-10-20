import type { CanvasCamera } from './types'

export interface CameraAnimationDeps {
  now(): number
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(id: number): void
}

const browserDeps: CameraAnimationDeps = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
}

export function animateCamera(
  from: CanvasCamera,
  to: CanvasCamera,
  options: {
    durationMs: number
    reducedMotion: boolean
    onFrame(camera: CanvasCamera): void
  },
  deps: CameraAnimationDeps = browserDeps,
): () => void {
  if (options.reducedMotion) {
    options.onFrame(to)
    return () => undefined
  }

  const startedAt = deps.now()
  let frameId: number | null = null
  let cancelled = false

  const tick: FrameRequestCallback = (timestamp) => {
    frameId = null
    if (cancelled) return

    const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / options.durationMs))
    if (progress >= 1) {
      options.onFrame(to)
      return
    }

    const eased = 1 - (1 - progress) ** 3
    options.onFrame({
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      scale: from.scale + (to.scale - from.scale) * eased,
    })
    frameId = deps.requestFrame(tick)
  }

  frameId = deps.requestFrame(tick)
  return () => {
    if (cancelled) return
    cancelled = true
    if (frameId !== null) {
      deps.cancelFrame(frameId)
      frameId = null
    }
  }
}
