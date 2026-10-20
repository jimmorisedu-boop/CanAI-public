import { validateGraph, type GraphDiagnostic } from '../nodes/graphDiagnostics'
import {
  resolveMacroInputs,
  type MacroContextDiagnostic,
  type MacroInputRunSnapshot,
  type MacroLaunchContext,
} from '../nodes/macroContextPreflight'
import type { GraphSnapshot } from '../nodes/types'

export interface MacroLaunchPreflight {
  diagnostics: Array<GraphDiagnostic | MacroContextDiagnostic>
  message: string | null
  started: boolean
  inputSnapshots: readonly MacroInputRunSnapshot[]
}

function isInputSnapshotList(
  context: MacroLaunchContext | readonly MacroInputRunSnapshot[],
): context is readonly MacroInputRunSnapshot[] {
  return Array.isArray(context)
}

export function startAfterMacroPreflight(
  graph: GraphSnapshot,
  context: MacroLaunchContext | readonly MacroInputRunSnapshot[],
  start: () => void,
): MacroLaunchPreflight {
  const inputSnapshots = isInputSnapshotList(context)
    ? context
    : resolveMacroInputs(graph, {
        refBatches: [context.refs],
        getAsset: context.getAsset,
      }).runs
  const contextDiagnostics = inputSnapshots.flatMap(
    (snapshot) => snapshot.diagnostics,
  )
  const seen = new Set<string>()
  const diagnostics = [
    ...validateGraph(graph.nodes, graph.edges),
    ...contextDiagnostics.filter((item) => {
      const key = `${item.code}:${item.nodeId}:${item.handleId}:${item.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
  const errors = diagnostics.filter((item) => item.severity === 'error')
  if (errors.length > 0) {
    return {
      diagnostics,
      message: errors.map((item) => item.message).join(' · '),
      started: false,
      inputSnapshots,
    }
  }
  start()
  return { diagnostics, message: null, started: true, inputSnapshots }
}
