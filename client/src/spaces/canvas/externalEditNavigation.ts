import type { ProjectMeta, TrashedProjectMeta } from '../../api'

export interface ExternalEditNavigationDependencies {
  listProjects(): Promise<{ projects: ProjectMeta[] }>
  listProjectTrash(): Promise<{ projects: TrashedProjectMeta[] }>
}

export type ExternalEditNavigationResolution =
  | { kind: 'active'; project: ProjectMeta }
  | { kind: 'trash'; project: TrashedProjectMeta }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

export async function resolveExternalEditNavigation(
  projectId: string,
  deps: ExternalEditNavigationDependencies,
): Promise<ExternalEditNavigationResolution> {
  try {
    const { projects } = await deps.listProjects()
    const active = projects.find((project) => project.id === projectId)
    if (active) return { kind: 'active', project: active }
    const { projects: trash } = await deps.listProjectTrash()
    const trashed = trash.find((project) => project.id === projectId)
    return trashed ? { kind: 'trash', project: trashed } : { kind: 'missing' }
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : "Failed to check the board",
    }
  }
}
