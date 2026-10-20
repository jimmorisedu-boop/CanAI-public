import type { MacroSaveState } from './macroPersistence'

export interface FingerprintedSnapshot {
  fingerprint: string
}

interface MacroSaveCoordinatorOptions<T extends FingerprintedSnapshot> {
  getSnapshot: () => T
  getSavedFingerprint: () => string | null
  setSavedFingerprint: (fingerprint: string) => void
  save: (snapshot: T) => Promise<void>
  onState: (state: MacroSaveState) => void
  onError?: (error: unknown) => void
}

export interface MacroSaveCoordinator {
  requestSave: () => Promise<void>
  isSaving: () => boolean
}

export async function saveMacroBeforeLeave(options: {
  state: MacroSaveState
  persist: () => Promise<void>
  currentSave: Promise<void> | null
}): Promise<void> {
  if (options.state === 'dirty' || options.state === 'save_failed') {
    await options.persist()
    return
  }
  if (options.state === 'saving' && options.currentSave) {
    await options.currentSave
  }
}

interface ConfirmedMacro {
  id: string
  revision: number
}

export class UnconfirmedMacroRevisionError extends Error {
  constructor() {
    super('Macro is not loaded yet: confirmed revision is unavailable')
    this.name = 'UnconfirmedMacroRevisionError'
  }
}

export function canClearMacroSlot(state: {
  macroId: string | null
  revision: number | null
  loaded: boolean
  isLoading: boolean
  loadError: string | null
}): boolean {
  // При повреждённом legacy-графе загрузка честно остаётся failed и редактор
  // заблокирован, но уже полученная серверная ревизия позволяет безопасное
  // recovery-delete с optimistic concurrency.
  return (
    state.macroId != null &&
    state.revision != null &&
    !state.isLoading &&
    (state.loaded || state.loadError != null)
  )
}

export async function deleteConfirmedMacroAfterSave(options: {
  currentSave: Promise<void> | null
  expectedMacroId: string | null
  getConfirmedMacro: () => ConfirmedMacro | null
  deleteMacro: (id: string, revision: number) => Promise<void>
}): Promise<void> {
  if (options.currentSave) await options.currentSave
  const confirmed = options.getConfirmedMacro()
  if (confirmed) {
    await options.deleteMacro(confirmed.id, confirmed.revision)
    return
  }
  if (options.expectedMacroId) throw new UnconfirmedMacroRevisionError()
}

export function createMacroSaveCoordinator<T extends FingerprintedSnapshot>(
  options: MacroSaveCoordinatorOptions<T>,
): MacroSaveCoordinator {
  let inFlight: Promise<void> | null = null

  async function saveUntilCurrent(): Promise<void> {
    while (true) {
      const snapshot = options.getSnapshot()
      if (snapshot.fingerprint === options.getSavedFingerprint()) {
        options.onState('saved')
        return
      }

      options.onState('saving')
      try {
        await options.save(snapshot)
      } catch (error) {
        options.onError?.(error)
        throw error
      }

      options.setSavedFingerprint(snapshot.fingerprint)
      if (options.getSnapshot().fingerprint === snapshot.fingerprint) {
        options.onState('saved')
        return
      }

      options.onState('saving')
    }
  }

  return {
    requestSave: () => {
      if (inFlight) return inFlight
      inFlight = saveUntilCurrent().finally(() => {
        inFlight = null
      })
      return inFlight
    },
    isSaving: () => inFlight != null,
  }
}

export class MacroLoadGuard {
  private generation = 0
  private loading = false

  begin(): number {
    this.generation += 1
    this.loading = true
    return this.generation
  }

  invalidate(onInvalidated?: () => void): void {
    this.generation += 1
    this.loading = false
    onInvalidated?.()
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  complete(token: number): boolean {
    if (!this.isCurrent(token)) return false
    this.loading = false
    return true
  }

  isLoading(): boolean {
    return this.loading
  }

  canRetry(hasLoadError: boolean): boolean {
    return hasLoadError && !this.loading
  }
}
