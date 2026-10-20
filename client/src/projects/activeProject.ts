import type { ProjectMeta } from '../api'
import type { ProjectRef } from '../types'

export interface ProjectCapabilities {
  canRead: boolean
  canComment: boolean
  canEdit: boolean
  canRename: boolean
  canGenerate: boolean
  canManage: boolean
  canManageMembers: boolean
  canArchive: boolean
  canCopy: boolean
  canPublish: boolean
}

export interface ActiveProject {
  ref: ProjectRef
  id: string
  name: string
  createdAt: number
  updatedAt: number
  canEdit: boolean
  capabilities: ProjectCapabilities
  local: ProjectMeta
}

/** Build the only project kind available in the local edition. */
export function activeLocalProject(project: ProjectMeta): ActiveProject {
  return {
    ref: { source: 'local', id: project.id },
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    canEdit: true,
    capabilities: {
      canRead: true,
      canComment: true,
      canEdit: true,
      canRename: true,
      canGenerate: true,
      canManage: true,
      canManageMembers: false,
      canArchive: true,
      canCopy: true,
      canPublish: false,
    },
    local: project,
  }
}

export function requestedProjectRef(value: string): ProjectRef {
  if (!value) throw new Error('Empty board ID')
  const id = value.startsWith('local:') ? value.slice('local:'.length) : value
  if (!id || id.includes(':')) throw new Error('Only local board links are available')
  return { source: 'local', id }
}
