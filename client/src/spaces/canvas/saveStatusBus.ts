// Статус автосохранения холста — для индикатора в топ-баре («Сохранено ✓»).
// Ошибка не исчезает сама: пользователь должен видеть, что правки не на диске.
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

type Listener = (status: SaveStatus) => void

let status: SaveStatus = 'idle'
const listeners = new Set<Listener>()
let legacyStatus: SaveStatus = 'idle'
let nextScopeId = 0
let activeScope: { id: number; status: SaveStatus; disposed: boolean } | null = null

function publish(next: SaveStatus): void {
  if (status === next) return
  status = next
  listeners.forEach((l) => l(next))
}

export function getSaveStatus(): SaveStatus {
  return status
}

export function setSaveStatus(next: SaveStatus): void {
  // Keep the old unscoped API for callers outside project sync. While a board
  // owns the indicator, its scoped writer is authoritative; a late legacy
  // update must not replace that board's state.
  legacyStatus = next
  if (!activeScope) publish(next)
}

export function onSaveStatus(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export interface SaveStatusScope {
  set(next: SaveStatus): void
  dispose(): void
}

/**
 * Give one project-sync attempt ownership of the top-bar save indicator.
 *
 * A board can be unmounted while its final network request is still in flight.
 * A later board must then win the race for the global indicator, and the old
 * request must become a no-op when it eventually reports an error.
 */
export function createSaveStatusScope(): SaveStatusScope {
  const scope = { id: ++nextScopeId, status: 'idle' as SaveStatus, disposed: false }
  activeScope = scope
  publish('idle')

  return {
    set(next) {
      if (scope.disposed || activeScope !== scope) return
      scope.status = next
      publish(next)
    },
    dispose() {
      if (scope.disposed) return
      scope.disposed = true
      if (activeScope !== scope) return
      activeScope = null
      publish(legacyStatus)
    },
  }
}
