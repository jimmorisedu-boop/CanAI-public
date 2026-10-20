import type { JobResult } from '../../types'

// Мостик «положить результат на канвас» из любого места (например, кнопка
// на ноде в нодовом пространстве). Канвас регистрирует обработчик.
type PlaceHandler = (result: JobResult, name: string) => void

let handler: PlaceHandler | null = null

export function onCanvasPlace(h: PlaceHandler): () => void {
  handler = h
  return () => {
    if (handler === h) handler = null
  }
}

export function requestCanvasPlace(result: JobResult, name: string): boolean {
  if (!handler) return false
  handler(result, name)
  return true
}
