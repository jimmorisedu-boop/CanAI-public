// Мостик Konva ↔ HTML для архива (тот же приём, что promptChatDropBus):
// канвас живёт в <canvas>, плитка «Архив» — обычный DOM, общаться им больше
// нечем. Здесь только подсветка при перетаскивании и открытие панели.

let hovering = false
const hoverListeners = new Set<(over: boolean) => void>()
const openListeners = new Set<() => void>()

export function onArchiveHover(fn: (over: boolean) => void): () => void {
  hoverListeners.add(fn)
  return () => hoverListeners.delete(fn)
}

export function notifyArchiveHover(over: boolean): void {
  if (over === hovering) return
  hovering = over
  hoverListeners.forEach((fn) => fn(over))
}

export function isArchiveHover(): boolean {
  return hovering
}

export function onOpenArchive(fn: () => void): () => void {
  openListeners.add(fn)
  return () => openListeners.delete(fn)
}

export function openArchive(): void {
  openListeners.forEach((fn) => fn())
}
