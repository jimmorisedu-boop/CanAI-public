import type { GenRef } from '../../types'
import type { CanaiEdge, CanaiNode, GraphSnapshot } from './types'
import {
  buildMacroInputPortModel,
  macroInputKindForHandle,
  type MacroInputPortModel,
  type MacroInputPortKind,
} from './macroInputPorts'

export type MacroContextKind = MacroInputPortKind

export interface MacroContextRef {
  kind: MacroContextKind
  src?: string
  assetId?: string
  text?: string
  width?: number
  height?: number
  w?: number
  h?: number
}

export interface MacroContextAsset extends MacroContextRef {
  slot: number
}

export interface MacroLaunchContext {
  refs: readonly MacroContextRef[]
  getAsset: (slot: number) => MacroContextAsset | undefined
}

export interface MacroContextDiagnostic {
  code: 'context_input_missing'
  severity: 'error'
  message: string
  nodeId: string
  handleId: string
}

export interface MacroInputRunSnapshot {
  readonly refs: readonly GenRef[]
  readonly refsByEdge: Readonly<Record<string, readonly GenRef[]>>
  readonly assetsBySlot: Readonly<Record<string, GenRef | null>>
  readonly diagnostics: readonly MacroContextDiagnostic[]
}

export interface MacroInputResolution {
  readonly runs: readonly MacroInputRunSnapshot[]
}

export interface ResolveMacroInputsOptions {
  refBatches: readonly (readonly MacroContextRef[])[]
  getAsset: (slot: number) => MacroContextAsset | undefined
}

const KIND_NAME: Record<MacroContextKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'text',
}

const KIND_OBJECT: Record<MacroContextKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'text',
}

function cloneGenRef(ref: MacroContextRef | undefined): GenRef | null {
  if (!ref) return null
  if (ref.kind === 'text') {
    const text = ref.text?.trim()
    return text ? Object.freeze({ kind: 'text' as const, text }) : null
  }
  if (!ref.src) return null
  const width = ref.width ?? ref.w
  const height = ref.height ?? ref.h
  return Object.freeze({
    kind: ref.kind,
    src: ref.src,
    ...(ref.assetId ? { assetId: ref.assetId } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  })
}

function freezeRefs(refs: GenRef[]): readonly GenRef[] {
  return Object.freeze(refs)
}

function resolveDynamicEdgeRefs(options: {
  edge: CanaiEdge
  requiredKind: MacroContextKind
  refs: readonly GenRef[]
  inputPorts: MacroInputPortModel
  graphEdges: CanaiEdge[]
  nodesById: Map<string, CanaiNode>
}): { refs: readonly GenRef[]; index: number } {
  const candidates = options.refs.filter(
    (ref) => ref.kind === options.requiredKind,
  )
  const index = options.inputPorts.resolveEdgeOrdinal(options.edge) ?? 0

  if (options.requiredKind === 'image') {
    const imageEdgesToTarget = options.graphEdges.filter(
      (edge) =>
        edge.target === options.edge.target &&
        options.nodesById.get(edge.source)?.data.kind === 'input' &&
        edge.sourceHandle === 'images',
    )
    if (
      options.inputPorts.dynamicInputCount <= 1 &&
      imageEdgesToTarget.length <= 1 &&
      index === 0
    ) {
      return { refs: freezeRefs([...candidates]), index }
    }
  }

  const selected = candidates[index] ?? candidates[0]
  return { refs: freezeRefs(selected ? [selected] : []), index }
}

function missingDiagnostic(options: {
  source: CanaiNode
  handleId: string
  requiredKind: MacroContextKind
  index: number
  assetSlot?: number
  asset?: GenRef | null
}): MacroContextDiagnostic {
  if (options.assetSlot != null) {
    return Object.freeze({
      code: 'context_input_missing' as const,
      severity: 'error' as const,
      message: options.asset
        ? `Asset ${options.assetSlot + 1} requires type “${KIND_NAME[options.requiredKind]}”`
        : `Asset ${options.assetSlot + 1}  is empty`,
      nodeId: options.source.id,
      handleId: options.handleId,
    })
  }
  return Object.freeze({
    code: 'context_input_missing' as const,
    severity: 'error' as const,
    message:
      options.index === 0
        ? `Select ${KIND_OBJECT[options.requiredKind]}  on the board`
        : `Select ${KIND_OBJECT[options.requiredKind]} #${options.index + 1} on the board`,
    nodeId: options.source.id,
    handleId: options.handleId,
  })
}

function macroAssetToGenRef(
  asset: MacroContextAsset | undefined,
): GenRef | null {
  return cloneGenRef(asset)
}

export function resolveMacroInputs(
  graph: GraphSnapshot,
  options: ResolveMacroInputsOptions,
): MacroInputResolution {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const inputPorts = buildMacroInputPortModel(graph.nodes, graph.edges)

  const assetSlots = [
    ...new Set(
      graph.nodes
        .map((node) => node.data.assetSlot)
        .filter((slot): slot is number => slot != null),
    ),
  ].sort((a, b) => a - b)
  const mutableAssets: Record<string, GenRef | null> = {}
  for (const slot of assetSlots) {
    mutableAssets[String(slot)] = macroAssetToGenRef(options.getAsset(slot))
  }
  const assetsBySlot = Object.freeze(mutableAssets)

  const runs = options.refBatches.map((batch): MacroInputRunSnapshot => {
    const refs = freezeRefs(
      batch
        .map((ref) => cloneGenRef(ref))
        .filter((ref): ref is GenRef => ref != null),
    )
    const mutableRefsByEdge: Record<string, readonly GenRef[]> = {}
    const diagnostics: MacroContextDiagnostic[] = []
    const seenDiagnostics = new Set<string>()

    for (const edge of graph.edges) {
      const source = nodesById.get(edge.source)
      if (source?.data.kind !== 'input') continue
      const handleId = edge.sourceHandle ?? ''
      const requiredKind = macroInputKindForHandle(handleId)
      if (!requiredKind) continue
      const assetSlot = source.data.assetSlot
      let resolved: readonly GenRef[]
      let index = 0
      let asset: GenRef | null | undefined

      if (assetSlot != null) {
        asset = assetsBySlot[String(assetSlot)]
        resolved = freezeRefs(
          asset?.kind === requiredKind ? [asset] : [],
        )
      } else {
        const dynamic = resolveDynamicEdgeRefs({
          edge,
          requiredKind,
          refs,
          inputPorts,
          graphEdges: graph.edges,
          nodesById,
        })
        resolved = dynamic.refs
        index = dynamic.index
      }
      mutableRefsByEdge[edge.id] = resolved

      if (resolved.length === 0) {
        const diagnosticKey = `${source.id}:${handleId}:${index}`
        if (!seenDiagnostics.has(diagnosticKey)) {
          seenDiagnostics.add(diagnosticKey)
          diagnostics.push(
            missingDiagnostic({
              source,
              handleId,
              requiredKind,
              index,
              assetSlot,
              asset,
            }),
          )
        }
      }
    }

    for (const node of graph.nodes) {
      if (
        node.data.kind !== 'media' ||
        node.data.result?.url ||
        node.data.assetSlot == null
      ) {
        continue
      }
      const asset = assetsBySlot[String(node.data.assetSlot)]
      if (asset?.kind === 'image' || asset?.kind === 'video') continue
      diagnostics.push(
        Object.freeze({
          code: 'context_input_missing' as const,
          severity: 'error' as const,
          message: asset
            ? `Asset ${node.data.assetSlot + 1}:: needs an image or video`
            : `Asset ${node.data.assetSlot + 1}  is empty`,
          nodeId: node.id,
          handleId: 'asset',
        }),
      )
    }

    return Object.freeze({
      refs,
      refsByEdge: Object.freeze(mutableRefsByEdge),
      assetsBySlot,
      diagnostics: Object.freeze(diagnostics),
    })
  })

  return Object.freeze({ runs: Object.freeze(runs) })
}

export function validateMacroLaunchContext(
  graph: GraphSnapshot,
  context: MacroLaunchContext,
): MacroContextDiagnostic[] {
  return [
    ...(resolveMacroInputs(graph, {
      refBatches: [context.refs],
      getAsset: context.getAsset,
    }).runs[0]?.diagnostics ?? []),
  ]
}
