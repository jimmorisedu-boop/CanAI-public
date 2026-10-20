import { useState } from 'react'
import { api, type Macro, type MacroScope } from '../../api'
import type { ProjectSource } from '../../types'
import { requestMacroEdit } from './macroEditBus'
import { notifyMacrosChanged } from './macrosBus'
import { notify } from './notifications'
import { exportMacroToFile, importMacroFromFile } from './macroFileActions'
import { freeMacroSlots } from './macroLibraryModel'
import type { MacroLibraryData } from './useMacroLibraryData'

/** Итог действия, который остаётся в окне, пока его не закроют. */
export interface LibraryNotice {
  tone: 'info' | 'success'
  title: string
  lines: string[]
}

const errorText = (cause: unknown, fallback: string): string => (
  cause instanceof Error ? cause.message : fallback
)

/** Local macro library mutations and file exchange actions. */
export function useMacroLibraryActions({
  data, scope, projectSource: _projectSource, onClose, initialNotice = null,
}: {
  data: MacroLibraryData
  scope: MacroScope
  projectSource: ProjectSource
  onClose(): void
  initialNotice?: LibraryNotice | null
}) {
  const { macros, setMacros, reload, setError } = data
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<LibraryNotice | null>(initialNotice)

  const shown = macros ?? []
  const orphans = shown.filter((m) => m.slot == null)
  const slotted = shown
    .filter((m) => m.slot != null)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const free = freeMacroSlots(shown)
  const full = free.length === 0

  async function run(id: string, action: () => Promise<unknown>): Promise<void> {
    if (busyId) return
    setBusyId(id)
    setError(null)
    try {
      await action()
      notifyMacrosChanged()
      await reload()
    } catch (cause) {
      const message = errorText(cause, 'Action failed')
      await reload()
      setError(message)
    } finally {
      setBusyId(null)
    }
  }

  function rename(macro: Macro, name: string): void {
    void run(macro.id, () => api.saveMacro(name, macro.graph, macro.id, macro.slot, macro.revision, scope))
  }

  function duplicate(macro: Macro): void {
    const slot = free[0]
    if (slot == null) return
    void run(macro.id, () => api.saveMacro(`${macro.name} (copy)`, macro.graph, undefined, slot, undefined, scope))
  }

  async function reorder(ids: string[]): Promise<void> {
    if (busyId) return
    const current = slotted.map((m) => m.id)
    if (ids.length === current.length && ids.every((id, i) => id === current[i])) return
    setMacros((prev) => {
      if (!prev) return prev
      const byId = new Map(prev.map((m) => [m.id, m]))
      const next = ids.map((id, index) => ({ ...byId.get(id)!, slot: index }))
      return [...next, ...prev.filter((m) => !ids.includes(m.id))]
    })
    await run('order', () => api.reorderMacros(scope, ids))
  }

  function open(macro: Macro): void {
    requestMacroEdit({ slot: macro.slot ?? 0, macroId: macro.id, scope, source: 'local' })
    onClose()
  }

  function create(): void {
    const slot = free[0]
    if (slot == null) return
    requestMacroEdit({ slot, macroId: null, scope, source: 'local' })
    onClose()
  }

  function exportFile(macro: Macro): void {
    void run(macro.id, async () => {
      const note = await exportMacroToFile(macro, 'local')
      if (note) setNotice({ tone: 'info', title: `"${macro.name}" saved to file`, lines: [note] })
      else notify({ kind: 'success', message: `"${macro.name}" saved to file` })
    })
  }

  function importFile(): void {
    void run('import', async () => {
      const imported = await importMacroFromFile('local', scope, free[0])
      if (!imported) return
      if (imported.notes.length > 0) {
        setNotice({ tone: 'info', title: `Macro “${imported.name}” loaded. Changes:`, lines: imported.notes })
      } else {
        notify({ kind: 'success', message: `Macro "${imported.name}" loaded` })
      }
    })
  }

  function offerRestore(name: string, restore: () => Promise<unknown>): void {
    notify({
      kind: 'info',
      message: `"${name}" deleted`,
      action: {
        label: 'Restore',
        run: () => {
          void restore()
            .then(async () => { notifyMacrosChanged(); await reload() })
            .catch((cause) => notify({ kind: 'error', message: errorText(cause, 'Failed to return macro') }))
        },
      },
    })
  }

  function remove(macro: Macro): void {
    const before = slotted.map((m) => m.id)
    const index = before.indexOf(macro.id)
    void run(macro.id, async () => {
      await api.deleteMacro(macro.id, macro.revision)
      offerRestore(macro.name, async () => {
        const { macro: restored } = await api.saveMacro(macro.name, macro.graph, undefined, undefined, undefined, scope)
        const ids = before.filter((id) => id !== macro.id)
        ids.splice(index < 0 ? ids.length : index, 0, restored.id)
        await api.reorderMacros(scope, ids).catch(() => {})
      })
    })
  }

  function removeLegacy(macro: Macro): void {
    void run(macro.id, () => api.deleteMacro(macro.id, macro.revision))
  }

  return {
    busy: busyId !== null,
    notice,
    dismissNotice: () => setNotice(null),
    shown, orphans, slotted, full,
    rename, duplicate, reorder, open, create, exportFile, importFile, remove, removeLegacy,
  }
}
