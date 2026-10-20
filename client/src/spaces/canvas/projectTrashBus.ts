export interface ProjectTrashRequest {
  projectId: string
}

type ProjectTrashSink = (request: ProjectTrashRequest) => void

let sink: ProjectTrashSink | null = null
let pending: ProjectTrashRequest | null = null

export function requestProjectTrash(request: ProjectTrashRequest): void {
  if (sink) {
    sink(request)
    return
  }
  pending = request
}

export function registerProjectTrashSink(handler: ProjectTrashSink): () => void {
  sink = handler
  if (pending) {
    const parked = pending
    pending = null
    handler(parked)
  }
  return () => {
    if (sink === handler) sink = null
  }
}
