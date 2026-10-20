import type { CanvasStore } from './konva/canvasStore'

// Активный стор доски для кода вне React-дерева канваса (движок макросов
// берёт отсюда пины полки ассетов). Раньше прод-логика ходила в отладочный
// window.__canaiStore, который не чистился при смене доски — макрос мог
// молча получить пины чужой или уже закрытой доски.
let active: CanvasStore | null = null

export function setActiveCanvasStore(store: CanvasStore): () => void {
  active = store
  return () => {
    if (active === store) active = null
  }
}

export function getActiveCanvasStore(): CanvasStore | null {
  return active
}
