import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { api, type Macro, type MacroScope } from '../../api'
import type { ProjectSource } from '../../types'

export interface MacroLibraryData {
  /** Макросы своей области; null — список ещё не пришёл. */
  macros: Macro[] | null
  setMacros: Dispatch<SetStateAction<Macro[] | null>>
  /** Макросы из области, которой в приложении больше нет. */
  legacy: Macro[]
  /** Список и роль ещё не готовы — показывать и нажимать нечего. */
  loading: boolean
  error: string | null
  setError(message: string | null): void
  /** Перечитать локальный список. */
  reload(): Promise<void>
}

// Список и старые записи разделяются здесь, чтобы окно оставалось простым.
export function useMacroLibraryData(scope: MacroScope, _projectSource: ProjectSource): MacroLibraryData {
  const [macros, setMacros] = useState<Macro[] | null>(null)
  const [legacy, setLegacy] = useState<Macro[]>([])
  const [error, setError] = useState<string | null>(null)

  async function reload(): Promise<void> {
    try {
      const loaded = await api.listMacros()
      const all = loaded.macros
      setMacros(all.filter((m) => (m.scope ?? 'canvas') === scope))
      setLegacy(all.filter((m) => (m.scope ?? 'canvas') !== scope))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load list')
    }
  }

  useEffect(() => {
    setMacros(null)
    setLegacy([])
    void reload()
    // The project source is kept in the signature for shared callers; local
    // production always reads the local macro store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  return { macros, setMacros, legacy, loading: macros === null, error, setError, reload }
}
