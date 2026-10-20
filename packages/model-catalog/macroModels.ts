import type { CatalogModel, ParamSpec } from './catalog.js'
import { parameterActive } from './parameterRules.js'

type Graph = { nodes: Array<{ id: string; data: { kind?: string; model?: string; params?: Record<string, unknown>; [key: string]: unknown }; [key: string]: unknown }>; edges?: Array<{ target: string; targetHandle?: string | null; [key: string]: unknown }>; [key: string]: unknown }

export function modelUses(graph: unknown, modelId: string): string[] {
  const nodes = (graph as Partial<Graph> | null)?.nodes
  return Array.isArray(nodes) ? nodes.filter(node => node?.data?.model === modelId).map(node => node.id) : []
}

export function paramValueAllowed(spec: ParamSpec, value: unknown): boolean {
  if (spec.widget === 'boolean') return typeof value === 'boolean'
  if (['number', 'slider', 'seed'].includes(spec.widget)) {
    return typeof value === 'number' && Number.isFinite(value)
      && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max)
      && (spec.step !== 1 && spec.widget !== 'seed' || Number.isInteger(value))
  }
  return typeof value === 'string' && (!spec.options || spec.options.some(option => option.value === value))
}

/** Returns a new graph only after every affected node passes the replacement contract. */
export function migrateGraphModel(graph: unknown, fromId: string, target: CatalogModel, models: readonly CatalogModel[]): unknown {
  const source = graph as Graph
  if (!source || !Array.isArray(source.nodes)) throw new Error('Invalid macro graph')
  if (target.lifecycle && target.lifecycle !== 'active') throw new Error('Select an active model')
  const changed = structuredClone(source)
  for (const node of changed.nodes) {
    if (node.data?.model !== fromId) continue
    if (node.data.kind && node.data.kind !== target.kind) throw new Error(`Node ${node.id}: different output type`)
    const inputs = (changed.edges ?? []).filter(edge => edge.target === node.id)
    const images = inputs.filter(edge => /^(ref\d*|frame\d*|image_url|mask_url|reference_image_urls)$/.test(edge.targetHandle ?? '')).length
    const videos = inputs.filter(edge => /^video\d*$/.test(edge.targetHandle ?? '')).length
    const audios = inputs.filter(edge => /^audio\d*$/.test(edge.targetHandle ?? '')).length
    const variantId = videos > 0 || audios > 0 ? target.videoPairId : images > 0 ? target.pairId : undefined
    const effective = variantId ? models.find(model => model.id === variantId) ?? target : target
    if (images && !effective.refs || images < (effective.minImageRefs ?? 0) || videos < (effective.minVideoRefs ?? 0) || audios < (effective.minAudioRefs ?? 0)
      || images > (effective.maxImageRefs ?? 16) || videos > (effective.maxVideoRefs ?? 0) || audios > (effective.maxAudioRefs ?? 0)
      || images + videos + audios > (effective.maxTotalRefs ?? 48)) throw new Error(`Node ${node.id}: the new model does not support the connected references`)
    const specs = new Map((effective.params ?? []).map(spec => [spec.name, spec]))
    for (const [name, value] of Object.entries(node.data.params ?? {})) {
      const spec = specs.get(name)
      if (!spec || !paramValueAllowed(spec, value) || !parameterActive(spec, effective.params ?? [], node.data.params ?? {})) throw new Error(`Node ${node.id}: fix parameter “${name}” for the new model first`)
    }
    node.data.model = target.id
  }
  return changed
}
