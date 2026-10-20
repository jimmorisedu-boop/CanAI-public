/** Capture может потеряться при открытии системного меню или портала. */
export function bindBoardPointerRecovery(host: HTMLElement, handlers: {
  has(id: number): boolean
  any(): boolean
  finish(event: PointerEvent): void
  cancel(): void
}, scope: Window = window): () => void {
  const finish = (event: PointerEvent) => { if (handlers.has(event.pointerId)) handlers.finish(event) }
  const cancel = (event: PointerEvent) => { if (handlers.has(event.pointerId)) handlers.cancel() }
  const outside = (event: PointerEvent) => {
    if (handlers.any() && event.target && !host.contains(event.target as Node)) handlers.cancel()
  }
  // Bubble: React уже завершил обычное отпускание на холсте. Остаток —
  // отпускание вне host, если setPointerCapture был недоступен.
  scope.addEventListener('pointerup', finish)
  scope.addEventListener('pointercancel', cancel, true)
  scope.addEventListener('pointerdown', outside, true)
  host.addEventListener('lostpointercapture', cancel)
  return () => {
    scope.removeEventListener('pointerup', finish)
    scope.removeEventListener('pointercancel', cancel, true)
    scope.removeEventListener('pointerdown', outside, true)
    host.removeEventListener('lostpointercapture', cancel)
  }
}

export function releaseBoardPointers<T>(pointers: Map<number, T>, host: Pick<HTMLElement, 'releasePointerCapture'> | null): void {
  const ids = [...pointers.keys()]
  pointers.clear()
  for (const id of ids) {
    try { host?.releasePointerCapture(id) } catch { /* optional capture */ }
  }
}
