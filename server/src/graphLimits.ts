// Лимиты размера workflow-графа (макросы и легаси-черновик).
// Защита от раздувания macros.json и OOM при JSON.stringify.

export const MAX_GRAPH_BYTES = 2 * 1024 * 1024 // 2 МБ сериализованного JSON
export const MAX_GRAPH_NODES = 200
export const MAX_GRAPH_EDGES = 500

export class GraphTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphTooLargeError'
  }
}

/** Проверяет обязательную структуру и лимиты графа до записи. */
export function assertGraphAcceptable(graph: unknown): void {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new GraphTooLargeError('Graph must be an object')
  }

  const record = graph as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(record.nodes)) {
    throw new GraphTooLargeError('Field nodes must be array')
  }
  if (!Array.isArray(record.edges)) {
    throw new GraphTooLargeError('Field edges must be array')
  }
  if (record.nodes.length > MAX_GRAPH_NODES) {
    throw new GraphTooLargeError(`Too many nodes (maximum ${MAX_GRAPH_NODES})`)
  }
  if (record.edges.length > MAX_GRAPH_EDGES) {
    throw new GraphTooLargeError(`Too many connections (maximum ${MAX_GRAPH_EDGES})`)
  }

  let serialized: string
  try {
    serialized = JSON.stringify(graph)
  } catch {
    throw new GraphTooLargeError('Graph cannot serialize')
  }
  if (serialized.length > MAX_GRAPH_BYTES) {
    throw new GraphTooLargeError(
      `Graph too large (maximum ${Math.round(MAX_GRAPH_BYTES / 1024 / 1024)} MB)`,
    )
  }
}
