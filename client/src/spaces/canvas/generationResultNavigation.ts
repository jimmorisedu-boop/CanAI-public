import type { ProjectMeta, TrashedProjectMeta } from '../../api'
import type { ProjectRef } from '../../types'

export interface GenerationResultNavigationRequest {
  projectRef: ProjectRef
  jobIds: string[]
}

export type GenerationResultProjectResolution =
  | { kind: 'active'; project: ProjectMeta }
  | { kind: 'trash'; project: TrashedProjectMeta }
  | { kind: 'missing' }
  | { kind: 'network-error'; message: string }

export interface GenerationResultProjectDeps {
  listProjects(): Promise<{ projects: ProjectMeta[] }>
  listProjectTrash(): Promise<{ projects: TrashedProjectMeta[] }>
}

function resolutionErrorMessage(error: unknown): string {
  if (error instanceof TypeError && /fetch/i.test(error.message)) return 'Failed to contact local server'
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Failed to check if board is available'
}

export async function resolveGenerationResultProject(
  ref: ProjectRef,
  deps: GenerationResultProjectDeps,
): Promise<GenerationResultProjectResolution> {
  try {
    const active = await deps.listProjects()
    const project = active.projects.find((item) => item.id === ref.id)
    if (project) return { kind: 'active', project }
    const trash = await deps.listProjectTrash()
    const trashed = trash.projects.find((item) => item.id === ref.id)
    return trashed ? { kind: 'trash', project: trashed } : { kind: 'missing' }
  } catch (error) {
    return { kind: 'network-error', message: resolutionErrorMessage(error) }
  }
}

export function shouldDismissGenerationResultNavigationError(
  resolution: GenerationResultProjectResolution,
): boolean {
  return resolution.kind !== 'network-error'
}

export function sameBoard(a: ProjectRef | null | undefined, b: ProjectRef | null | undefined): boolean {
  return Boolean(a && b && a.source === b.source && a.id === b.id)
}

type NavigationSink = (request: GenerationResultNavigationRequest) => void

let sink: NavigationSink | null = null
let pending: GenerationResultNavigationRequest | null = null

export function requestGenerationResultNavigation(request: GenerationResultNavigationRequest): void {
  if (sink) {
    sink(request)
    return
  }
  pending = request
}

export function registerGenerationResultNavigationSink(handler: NavigationSink): () => void {
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
