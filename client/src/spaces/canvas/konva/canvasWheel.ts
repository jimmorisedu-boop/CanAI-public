import type { NavigationMode } from '../../../settings/navigationMode'
import { clampScale } from './cameraOps'

export interface WheelCamera {
  x: number
  y: number
  scale: number
}

export interface WheelDelta {
  deltaX: number
  deltaY: number
  ctrlKey: boolean
}

const MOUSE_ZOOM_FACTOR = 1.08
const TOUCHPAD_ZOOM_SENSITIVITY = 0.002

function zoomAtPointer(camera: WheelCamera, pointer: { x: number; y: number }, scale: number): WheelCamera {
  const worldX = (pointer.x - camera.x) / camera.scale
  const worldY = (pointer.y - camera.y) / camera.scale
  return {
    scale,
    x: pointer.x - worldX * scale,
    y: pointer.y - worldY * scale,
  }
}

export function nextCameraFromWheel(
  camera: WheelCamera,
  pointer: { x: number; y: number },
  wheel: WheelDelta,
  mode: NavigationMode,
): WheelCamera {
  if (mode === 'touchpad' && !wheel.ctrlKey) {
    return {
      x: camera.x - wheel.deltaX,
      y: camera.y - wheel.deltaY,
      scale: camera.scale,
    }
  }

  const scale = mode === 'touchpad'
    ? clampScale(camera.scale * Math.exp(-wheel.deltaY * TOUCHPAD_ZOOM_SENSITIVITY))
    : clampScale(wheel.deltaY > 0
      ? camera.scale / MOUSE_ZOOM_FACTOR
      : camera.scale * MOUSE_ZOOM_FACTOR)

  return zoomAtPointer(camera, pointer, scale)
}
