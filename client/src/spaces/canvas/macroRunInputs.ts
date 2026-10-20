import type { GraphSnapshot } from '../nodes/types'
import type { SelectionRef } from './konva/selection'

export interface MacroSeedPlan {
  isMultiInput: boolean
  batches: SelectionRef[][]
}

export function planMacroSeedBatches(
  graph: GraphSnapshot,
  refs: SelectionRef[],
): MacroSeedPlan {
  const dynamicInputIds = new Set(
    graph.nodes
      .filter((node) => node.data.kind === 'input' && node.data.assetSlot == null)
      .map((node) => node.id),
  )
  const hasInputNode = graph.nodes.some((node) => node.data.kind === 'input')
  const dynamicEdges = graph.edges.filter((edge) =>
    dynamicInputIds.has(edge.source),
  )
  const requiredMediaKinds = new Set<'image' | 'video'>()
  let maxConnectedRefIndex = 0
  for (const edge of dynamicEdges) {
    if (edge.sourceHandle === 'images') requiredMediaKinds.add('image')
    if (edge.sourceHandle === 'video') requiredMediaKinds.add('video')
    const match = /^(?:ref|frame)(\d+)$/.exec(edge.targetHandle ?? '')
    if (match) {
      maxConnectedRefIndex = Math.max(
        maxConnectedRefIndex,
        Number.parseInt(match[1], 10),
      )
    }
  }

  const isMultiInput =
    dynamicInputIds.size > 1 ||
    maxConnectedRefIndex > 1 ||
    requiredMediaKinds.size > 1
  const textRefs = refs.filter((ref) => ref.kind === 'text')
  const mediaRefs = refs.filter(
    (ref): ref is SelectionRef & { kind: 'image' | 'video' } =>
      ref.kind === 'image' || ref.kind === 'video',
  )
  const relevantMedia = hasInputNode
    ? mediaRefs.filter((ref) => requiredMediaKinds.has(ref.kind))
    : mediaRefs

  if (isMultiInput) {
    return { isMultiInput, batches: [[...relevantMedia, ...textRefs]] }
  }
  if (relevantMedia.length > 0) {
    return {
      isMultiInput,
      batches: relevantMedia.map((ref) => [ref, ...textRefs]),
    }
  }
  return { isMultiInput, batches: [[...textRefs]] }
}
