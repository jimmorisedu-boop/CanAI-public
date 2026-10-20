import type { ProjectMeta } from '../api'

export interface ProjectMutationPlan {
  next: ProjectMeta[]
  rollback: ProjectMeta[]
}

export function planProjectRename(
  projects: ProjectMeta[],
  projectId: string,
  name: string,
): ProjectMutationPlan {
  return {
    next: projects.map((project) => (
      project.id === projectId ? { ...project, name } : project
    )),
    rollback: projects,
  }
}

export function rollbackProjectRename(
  projects: ProjectMeta[],
  projectId: string,
  name: string,
): ProjectMeta[] {
  return projects.map((project) => (
    project.id === projectId ? { ...project, name } : project
  ))
}

export function planProjectPin(
  projects: ProjectMeta[],
  projectId: string,
  pinned: boolean,
): ProjectMutationPlan {
  return {
    next: projects.map((project) => (
      project.id === projectId ? { ...project, pinned } : project
    )),
    rollback: projects,
  }
}

export function rollbackProjectPin(
  projects: ProjectMeta[],
  projectId: string,
  pinned: boolean,
): ProjectMeta[] {
  return projects.map((project) => (
    project.id === projectId ? { ...project, pinned } : project
  ))
}

export function startPendingProjectPin(
  pending: ReadonlySet<string>,
  projectId: string,
): ReadonlySet<string> {
  return new Set(pending).add(projectId)
}

export function finishPendingProjectPin(
  pending: ReadonlySet<string>,
  projectId: string,
): ReadonlySet<string> {
  const next = new Set(pending)
  next.delete(projectId)
  return next
}

export function planProjectRemoval(
  projects: ProjectMeta[],
  projectId: string,
): ProjectMutationPlan {
  return {
    next: projects.filter((project) => project.id !== projectId),
    rollback: projects,
  }
}

export function rollbackProjectRemoval(
  projects: ProjectMeta[],
  removedProject: ProjectMeta,
  index: number,
): ProjectMeta[] {
  if (projects.some((project) => project.id === removedProject.id)) return projects
  const next = [...projects]
  next.splice(Math.max(0, Math.min(index, next.length)), 0, removedProject)
  return next
}
