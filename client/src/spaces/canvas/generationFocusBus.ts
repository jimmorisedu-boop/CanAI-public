export interface GenerationFocusRequest {
  projectId: string
  jobIds: string[]
}

type GenerationFocusHandler = (request: GenerationFocusRequest) => void

const sinks = new Map<string, GenerationFocusHandler>()
const pending = new Map<string, GenerationFocusRequest>()

export function requestGenerationFocus(request: GenerationFocusRequest): void {
  const sink = sinks.get(request.projectId)
  if (sink) {
    sink(request)
    return
  }
  pending.set(request.projectId, request)
}

export function registerGenerationFocusSink(
  projectId: string,
  handler: GenerationFocusHandler,
): () => void {
  sinks.set(projectId, handler)
  const parked = pending.get(projectId)
  if (parked) {
    pending.delete(projectId)
    handler(parked)
  }
  return () => {
    if (sinks.get(projectId) === handler) sinks.delete(projectId)
  }
}
