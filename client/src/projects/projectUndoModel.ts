import type { ProjectMeta } from '../api'

export function clearRestoredUndoProject(
  current: ProjectMeta | null,
  restoredProjectId: string,
): ProjectMeta | null {
  return current?.id === restoredProjectId ? null : current
}
