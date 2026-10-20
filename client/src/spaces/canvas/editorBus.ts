// Мостик между tldraw-утилитой (двойной клик по картинке) и React-состоянием
// CanvasSpace: утилита не знает про React, поэтому общаемся через колбэк.
export interface ImageEditRequest {
  shapeId: string
  src: string
  name: string
}

type Handler = (request: ImageEditRequest) => void

let handler: Handler | null = null

export function onImageEditRequest(h: Handler | null): void {
  handler = h
}

export function requestImageEdit(request: ImageEditRequest): void {
  handler?.(request)
}
