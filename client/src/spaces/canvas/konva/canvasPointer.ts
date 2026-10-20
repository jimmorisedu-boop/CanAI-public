import type { CanvasCamera } from './types'

export interface CanvasPointerPosition {
  x: number
  y: number
}

export function pointerToWorld(
  pointer: CanvasPointerPosition | null,
  camera: CanvasCamera,
): CanvasPointerPosition | undefined {
  if (!pointer) return undefined
  return {
    x: (pointer.x - camera.x) / camera.scale,
    y: (pointer.y - camera.y) / camera.scale,
  }
}
