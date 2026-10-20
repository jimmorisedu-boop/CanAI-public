import type { CanaiEdge, CanaiNode } from './types'

export type GraphDiagnosticCode =
  | 'output_missing'
  | 'output_disconnected'
  | 'prompt_missing'
  | 'note_missing'
  | 'media_missing'
  | 'reference_missing'
  | 'graph_cycle'
  | 'node_unreachable'
  | 'wait_without_chat'

export interface GraphDiagnostic {
  code: GraphDiagnosticCode
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  portId?: string
  fieldId?: string
}

export interface GraphDiagnosticSummary {
  errors: number
  warnings: number
  structurallyValid: boolean
  label: string
}

function cyclicComponents(nodes: CanaiNode[], edges: CanaiEdge[]): string[][] {
  const next = new Map(nodes.map((item) => [item.id, [] as string[]]))
  for (const edge of edges) next.get(edge.source)?.push(edge.target)
  const indexById = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  let index = 0

  function visit(id: string): void {
    indexById.set(id, index)
    lowLink.set(id, index)
    index++
    stack.push(id)
    onStack.add(id)

    for (const child of next.get(id) ?? []) {
      if (!indexById.has(child)) {
        visit(child)
        lowLink.set(id, Math.min(lowLink.get(id)!, lowLink.get(child)!))
      } else if (onStack.has(child)) {
        lowLink.set(id, Math.min(lowLink.get(id)!, indexById.get(child)!))
      }
    }

    if (lowLink.get(id) !== indexById.get(id)) return
    const component: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      onStack.delete(member)
      component.push(member)
      if (member === id) break
    }
    const selfLoop = component.length === 1 &&
      (next.get(component[0]) ?? []).includes(component[0])
    if (component.length > 1 || selfLoop) components.push(component)
  }

  for (const item of nodes) {
    if (!indexById.has(item.id)) visit(item.id)
  }
  return components
}

/** Промпт из чужого графа бывает чем угодно: строкой его считаем только строку. */
function promptText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function validateGraph(
  nodes: CanaiNode[],
  edges: CanaiEdge[],
  // область: у макроса с холста нет ленты чата, поэтому часть нод там бесполезна
  scope: 'canvas' | 'assistant' = 'canvas',
): GraphDiagnostic[] {
  if (nodes.length === 0) return []
  const result: GraphDiagnostic[] = []
  const outputs = nodes.filter((node) => node.data.kind === 'output')

  if (scope === 'canvas') {
  }

  if (outputs.length === 0) {
    result.push({
      code: 'output_missing',
      severity: 'error',
      message: 'Add an “Output” node',
    })
  } else {
    for (const output of outputs) {
      if (!edges.some((edge) => edge.target === output.id)) {
        result.push({
          code: 'output_disconnected',
          severity: 'error',
          message: 'Connect data to this “Output” node',
          nodeId: output.id,
        })
      }
    }
  }

  for (const item of nodes) {
    const kind = item.data.kind
    if (kind === 'other' && item.data.model === 'seedvr-seamless-upscale') {
      const hasImage = edges.some(
        (edge) => edge.target === item.id && edge.targetHandle === 'image_url',
      )
      if (!hasImage) {
        result.push({
          code: 'reference_missing',
          severity: 'error',
          message: 'Connect an image to upscale',
          nodeId: item.id,
          portId: 'image_url',
        })
      }
    }
    if (kind === 'note' && !promptText(item.data.prompt).trim()) {
      result.push({
        code: 'note_missing',
        severity: 'error',
        message: 'Enter text in the “Text” node',
        nodeId: item.id,
        fieldId: 'prompt',
      })
      continue
    }
    if (
      kind === 'media' &&
      !item.data.result?.url &&
      item.data.assetSlot == null
    ) {
      result.push({
        code: 'media_missing',
        severity: 'error',
        message: 'Choose a file or asset in the “File” node',
        nodeId: item.id,
      })
      continue
    }
    if (kind !== 'image' && kind !== 'video' && kind !== 'text' && kind !== 'other') continue
    if (kind === 'other' && item.data.model === 'seedvr-seamless-upscale') continue
    const portId = kind === 'text' ? 'ctx' : 'prompt'
    const connected = edges.some(
      (edge) => edge.target === item.id && edge.targetHandle === portId,
    )
    if (!connected && !promptText(item.data.prompt).trim()) {
      result.push({
        code: 'prompt_missing',
        severity: 'error',
        message: 'Fill in the prompt or connect text',
        nodeId: item.id,
        portId,
        fieldId: 'prompt',
      })
    }
  }

  for (const component of cyclicComponents(nodes, edges)) {
    result.push({
      code: 'graph_cycle',
      severity: 'error',
      message: 'Remove the loop in the connections',
      nodeId: component[0],
    })
  }

  if (outputs.length > 0) {
    const parents = new Map(nodes.map((node) => [node.id, [] as string[]]))
    for (const edge of edges) parents.get(edge.target)?.push(edge.source)
    const reachable = new Set<string>()
    function mark(id: string): void {
      if (reachable.has(id)) return
      reachable.add(id)
      for (const parent of parents.get(id) ?? []) mark(parent)
    }
    for (const output of outputs) mark(output.id)
    for (const item of nodes) {
      if (item.data.kind !== 'output' && !reachable.has(item.id)) {
        result.push({
          code: 'node_unreachable',
          severity: 'warning',
          message: 'This node does not lead to an output',
          nodeId: item.id,
        })
      }
    }
  }

  return result
}

// Keep the historical export name for callers while applying English rules.
export function pluralRu(n: number, one: string, few: string, many: string): string {
  return Math.abs(n) === 1 ? one : many
}

export function summarizeDiagnostics(
  diagnostics: GraphDiagnostic[],
): GraphDiagnosticSummary {
  const errors = diagnostics.filter((item) => item.severity === 'error').length
  const warnings = diagnostics.filter((item) => item.severity === 'warning').length
  return {
    errors,
    warnings,
    structurallyValid: errors === 0,
    label: errors === 0 ? 'Valid' : `${errors} ${pluralRu(errors, 'error', 'errors', 'errors')}`,
  }
}
