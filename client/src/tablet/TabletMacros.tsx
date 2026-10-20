import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ProjectSource } from '../types'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { toGenRefs } from '../spaces/canvas/konva/selection'
import { useSelectionRefs } from '../spaces/canvas/konva/useStore'
import { bindMacroRunToBoard, dismissUnusedSlots, macroRunSummary, planMacroRun, startMacroRun, trackMacroJobs, watchMacroRun, type MacroRunState } from '../spaces/canvas/macroRunClient'
import { newId } from '../ui/ids'
import { tabletSystemMessage } from './tabletSystemMessage'

interface MacroButton { id: string; name: string; slot?: number }
function macroNote(note: string, name: string): string {
  const prefix = `${name}: `
  return note.startsWith(prefix) ? `${name}: ${tabletSystemMessage(note.slice(prefix.length), 'Macro failed.')}` : tabletSystemMessage(note, 'Macro status unavailable.')
}
function renderedMacroNote(note: string, macros: readonly MacroButton[]): string {
  const macro = macros.find((entry) => note.startsWith(`${entry.name}: `))
  return macro ? macroNote(note, macro.name) : note
}

export function TabletMacros({ store, projectId, disabled, projectSource = 'local' }: { store: CanvasStore; projectId: string; disabled?: boolean; projectSource?: ProjectSource }) {
  const [macros, setMacros] = useState<MacroButton[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState(false)
  const refs = useSelectionRefs(store)
  const stopped = useRef(new Set<string>())
  useEffect(() => {
    void api.listMacros().then((answer) => setMacros((answer.macros as MacroButton[]).filter((macro) => (macro as { scope?: string }).scope !== 'assistant').sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999)))).catch(() => setMacros([]))
  }, [projectSource])

  const run = useCallback(async (macro: MacroButton) => {
    if (disabled) return
    setNote(null)
    try {
      const delivering = await planMacroRun(macro.id, 'local')
      const inputRefs = await toGenRefs(refs, 'image')
      const requestId = newId()
      const anchorIds = refs.filter((ref) => ref.kind !== 'text' && !ref.shapeId.startsWith('asset:')).map((ref) => ref.shapeId)
      const anchor = anchorIds[0] ? store.getItem(anchorIds[0]) : undefined
      const slots = store.addPendingRow(Math.max(1, delivering.length), { kind: 'image', label: macro.name, anchorIds: anchorIds.length > 0 ? anchorIds : undefined, aspect: anchor && anchor.h > 0 ? anchor.w / anchor.h : 1, prompt: `Macro: ${macro.name}`, modelId: macro.id })
      const started = await startMacroRun({ requestId, macroId: macro.id, projectId, refs: inputRefs, placeholderIds: slots }, 'local')
      setBusy((current) => ({ ...current, [macro.id]: started.id }))
      const bound = new Set<string>()
      const finished = await watchMacroRun(started.id, projectId, {
        isStopped: () => stopped.current.has(started.id),
        onState: (state: MacroRunState) => {
          const fresh = bindMacroRunToBoard(state, store, bound, 'local')
          trackMacroJobs(fresh, projectId)
          setNote(macroRunSummary(state))
        },
      }, 'local')
      if (finished) { dismissUnusedSlots(finished, store, 'local'); setNote(macroRunSummary(finished)) }
    } catch (cause) { setNote(tabletSystemMessage(cause, 'Could not run macro')) }
    finally { setBusy((current) => { const next = { ...current }; delete next[macro.id]; return next }) }
  }, [disabled, projectId, refs, store])

  const stop = useCallback((macroId: string) => {
    const runId = busy[macroId]
    if (!runId) return
    stopped.current.add(runId)
    void api.cancelMacroRun(runId).catch(() => {})
  }, [busy])

  return <div className="tablet-macros tablet-macro-strip">
    {note && <p className="tablet-macros-note">{renderedMacroNote(note, macros)}</p>}
    <span className="tablet-inline-label">Macros</span>
    <div className="tablet-macros-row" role="group" aria-label="Macros">
      {macros.length === 0 ? <span className="tablet-inline-empty">None yet — build a custom macro on your computer and it will appear here</span> : macros.slice(0, expanded ? macros.length : 5).map((macro) => <span className="tablet-macro" key={macro.id}><button type="button" className="ui-btn" disabled={disabled || Boolean(busy[macro.id])} onClick={() => void run(macro)} title={macro.name}>{macro.name}</button>{busy[macro.id] && <button type="button" className="ui-btn danger tablet-macro-stop" onClick={() => stop(macro.id)}>Stop</button>}</span>)}
      {macros.length > 5 && <button type="button" className="ui-btn quiet tablet-macros-all" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide' : 'All macros'}</button>}
    </div>
  </div>
}
