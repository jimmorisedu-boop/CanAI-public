import type { ProjectMeta } from '../api'
import type { ProjectRef } from '../types'

export type GallerySort = 'recent' | 'name' | 'created'
export type GallerySource = 'all' | 'local'
export type GalleryEmptyState = 'no-projects' | 'no-matches' | null
export type GalleryAvailability = 'editable'

export interface GalleryProject {
  ref: ProjectRef
  name: string
  createdAt: number
  updatedAt: number
  source: 'local'
  availability: GalleryAvailability
  pinned: boolean
  local: ProjectMeta
}

const nameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

function isPinned(project: ProjectMeta): boolean {
  return project.pinned === true
}

export function mergeGalleryProjects(local: ProjectMeta[]): GalleryProject[] {
  return local.map((project) => ({
    ref: { source: 'local', id: project.id },
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    source: 'local' as const,
    availability: 'editable' as const,
    pinned: isPinned(project),
    local: project,
  }))
}

export function galleryEmptyState(projects: readonly unknown[], query: string): GalleryEmptyState {
  if (projects.length === 0) return 'no-projects'
  return query ? 'no-matches' : null
}

export function visibleGalleryProjects(
  projects: GalleryProject[],
  query: string,
  sort: GallerySort,
  source: GallerySource = 'all',
): GalleryProject[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('en')
  const filtered = projects.filter((project) => (
    (source === 'all' || project.source === source)
    && project.name.toLocaleLowerCase('en').includes(normalizedQuery)
  ))
  return [...filtered].sort((a, b) => {
    const pinnedOrder = Number(b.pinned) - Number(a.pinned)
    if (pinnedOrder !== 0) return pinnedOrder
    const order = sort === 'name'
      ? nameCollator.compare(a.name, b.name)
      : sort === 'recent' ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt
    if (order !== 0) return order
    const updatedOrder = b.updatedAt - a.updatedAt
    if (updatedOrder !== 0) return updatedOrder
    return a.ref.id.localeCompare(b.ref.id)
  })
}

export function visibleProjects(projects: ProjectMeta[], query: string, sort: GallerySort): ProjectMeta[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('en')
  return [...projects]
    .filter((project) => project.name.toLocaleLowerCase('en').includes(normalizedQuery))
    .sort((a, b) => {
      const pinnedOrder = Number(isPinned(b)) - Number(isPinned(a))
      if (pinnedOrder !== 0) return pinnedOrder
      const order = sort === 'name'
        ? nameCollator.compare(a.name, b.name)
        : sort === 'recent' ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt
      if (order !== 0) return order
      const updatedOrder = b.updatedAt - a.updatedAt
      if (updatedOrder !== 0) return updatedOrder
      return a.id.localeCompare(b.id)
    })
}
