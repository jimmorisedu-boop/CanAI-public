import type { CanaiEdge, CanaiNode, GraphSnapshot } from './types'
import { validateGraph } from './graphDiagnostics'

export type MacroSaveState =
  | 'loading'
  | 'load_failed'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'save_failed'
  | 'conflict'

export type MacroLoadEvent = 'start' | 'retry' | 'failed' | 'loaded'

export function macroLoadState(event: MacroLoadEvent): MacroSaveState {
  if (event === 'failed') return 'load_failed'
  if (event === 'loaded') return 'saved'
  return 'loading'
}

const SAVE_LABELS: Record<MacroSaveState, string> = {
  loading: 'Loading…',
  load_failed: 'Did not load',
  saved: 'Saved ✓',
  dirty: 'Has unsaved changes',
  saving: 'Saving…',
  save_failed: 'Was not saved',
  conflict: 'Version conflict',
}

export function macroSaveLabel(state: MacroSaveState): string {
  return SAVE_LABELS[state]
}

export function parseStoredMacroGraph(graph: unknown): GraphSnapshot {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('Macro graph is corrupt: expected an object')
  }
  const record = graph as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new Error(
      'Macro graph is corrupt: nodes and edges must be arrays',
    )
  }
  return {
    nodes: record.nodes as CanaiNode[],
    edges: record.edges as CanaiEdge[],
  }
}

export function cleanMacroGraph(
  nodes: CanaiNode[],
  edges: CanaiEdge[],
): GraphSnapshot {
  return {
    nodes: nodes.map((node) => {
      // Размеры — не данные графа, а замер DOM. Сохранять их вредно: в React
      // Flow width/height означают ЖЁСТКИЙ размер, и при следующей загрузке
      // обёртка ноды навсегда застревала на старом замере, пока карточка
      // росла под содержимое. Отсюда и вторая, смещённая рамка выделения.
      const {
        selected: _selected,
        dragging: _dragging,
        measured: _measured,
        resizing: _resizing,
        width: _width,
        height: _height,
        ...persistedNode
      } = node
      const keepMedia = node.data.kind === 'media'
      return {
        ...persistedNode,
        data: {
          ...node.data,
          status: 'idle',
          result: keepMedia ? node.data.result : undefined,
          progress: undefined,
          error: undefined,
          outputHistory: undefined,
          viewIndex: undefined,
          jobId: undefined,
          // отметка замены графа живёт только в открытом редакторе
          restoredAt: undefined,
        },
      }
    }),
    edges: edges.map((edge) => {
      const { selected: _selected, ...persistedEdge } = edge
      return persistedEdge
    }),
  }
}

export function macroFingerprint(name: string, graph: GraphSnapshot): string {
  return JSON.stringify({
    name: name.trim(),
    graph,
  })
}

/**
 * ⚠️ Зовётся прямо в отрисовке ряда макросов и строк библиотеки. Граф приходит
 * и извне — из буфера по Ctrl+V и из файла, которым люди обмениваются, — а
 * сервер при сохранении проверяет только, что nodes и edges — массивы. Нода
 * без `data` или `null` в списке роняли проверку, вместе с ней ряд и строку
 * библиотеки, а с ними весь холст — на каждой доске и после перезагрузки:
 * макрос уже лежит в файле, и удалить его из интерфейса было нечем. Негодный
 * граф — это черновик, а не падение: клик по нему откроет редактор.
 */
export function macroRunnable(graph: GraphSnapshot): boolean {
  if (graph.nodes.length === 0) return false
  try {
    return !validateGraph(graph.nodes, graph.edges).some((item) => item.severity === 'error')
  } catch {
    return false
  }
}
