import type { CanaiEdge, CanaiNode } from './types'

export type MacroInputPortKind = 'image' | 'video' | 'audio' | 'text'

export interface MacroInputPortMetadata {
  readonly kind: MacroInputPortKind
  /** Номер внутри своего типа, начиная с нуля. */
  readonly ordinal: number
  readonly label: string
}

export interface MacroInputPortModel {
  readonly dynamicInputCount: number
  readonly getPort: (
    nodeId: string,
    handleId: string,
  ) => MacroInputPortMetadata | undefined
  readonly resolveEdgeOrdinal: (edge: CanaiEdge) => number | undefined
}

const INPUT_PORTS = [
  { handleId: 'images', kind: 'image', label: 'image' },
  { handleId: 'video', kind: 'video', label: 'video' },
  { handleId: 'audio', kind: 'audio', label: 'audio' },
  { handleId: 'text', kind: 'text', label: 'text' },
] as const satisfies readonly {
  handleId: string
  kind: MacroInputPortKind
  label: string
}[]

export function macroInputKindForHandle(
  handleId: string,
): MacroInputPortKind | undefined {
  return INPUT_PORTS.find((port) => port.handleId === handleId)?.kind
}

function targetHandleOrdinal(handleId: string): number {
  const match = /^(?:ref|frame)(\d+)$/.exec(handleId)
  return match
    ? Math.max(0, Number.parseInt(match[1], 10) - 1)
    : 0
}

/**
 * Единая модель нумерации динамических Input-портов для UI и resolver.
 * Порядок считается отдельно для каждого типа и только среди подключённых
 * canvas-входов; фиксированные ассеты не расходуют порядковый номер.
 */
export function buildMacroInputPortModel(
  nodes: readonly CanaiNode[],
  edges: readonly CanaiEdge[],
): MacroInputPortModel {
  const dynamicInputs = nodes
    .filter(
      (node) =>
        node.data.kind === 'input' && node.data.assetSlot == null,
    )
    .sort(
      (a, b) =>
        (a.position?.y ?? 0) - (b.position?.y ?? 0) ||
        (a.position?.x ?? 0) - (b.position?.x ?? 0) ||
        a.id.localeCompare(b.id),
    )

  const connectedByKind: Record<MacroInputPortKind, Set<string>> = {
    image: new Set<string>(),
    video: new Set<string>(),
    audio: new Set<string>(),
    text: new Set<string>(),
  }
  for (const edge of edges) {
    const kind = macroInputKindForHandle(edge.sourceHandle ?? '')
    if (kind) connectedByKind[kind].add(edge.source)
  }

  const inputIdsByKind: Record<
    MacroInputPortKind,
    readonly string[]
  > = {
    image: Object.freeze(
      dynamicInputs
        .filter((node) => connectedByKind.image.has(node.id))
        .map((node) => node.id),
    ),
    video: Object.freeze(
      dynamicInputs
        .filter((node) => connectedByKind.video.has(node.id))
        .map((node) => node.id),
    ),
    audio: Object.freeze(
      dynamicInputs
        .filter((node) => connectedByKind.audio.has(node.id))
        .map((node) => node.id),
    ),
    text: Object.freeze(
      dynamicInputs
        .filter((node) => connectedByKind.text.has(node.id))
        .map((node) => node.id),
    ),
  }

  const ports = new Map<string, Map<string, MacroInputPortMetadata>>()
  for (const { kind, handleId, label } of INPUT_PORTS) {
    inputIdsByKind[kind].forEach((nodeId, ordinal) => {
      const metadata = Object.freeze({
        kind,
        ordinal,
        label:
          dynamicInputs.length > 1
            ? `${label} #${ordinal + 1}`
            : label,
      })
      const nodePorts = ports.get(nodeId) ?? new Map()
      nodePorts.set(handleId, metadata)
      ports.set(nodeId, nodePorts)
    })
  }

  return Object.freeze({
    dynamicInputCount: dynamicInputs.length,
    getPort: (nodeId: string, handleId: string) =>
      ports.get(nodeId)?.get(handleId),
    resolveEdgeOrdinal: (edge: CanaiEdge) => {
      const port = ports
        .get(edge.source)
        ?.get(edge.sourceHandle ?? '')
      if (!port) return undefined
      return dynamicInputs.length === 1
        ? targetHandleOrdinal(edge.targetHandle ?? '')
        : port.ordinal
    },
  })
}
