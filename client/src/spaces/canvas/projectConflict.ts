import { ApiError } from '../../api'
import type { CanvasDoc } from './konva/types'

export interface ConflictRecoveryProject {
  id: string
  name: string
  revision: number
}

export type ConflictRecoveryStatus = 'saved' | 'needs-retry'

/** Why the local snapshot is waiting for an explicit user decision. */
export type ProjectConflictReason = 'version-conflict' | 'invalid-snapshot'

export interface ProjectConflictSnapshot {
  local: CanvasDoc
  serverRevision: number
  recoveryProject: ConflictRecoveryProject | null
  status: ConflictRecoveryStatus
  reason?: ProjectConflictReason
}

export interface ParsedProjectConflict {
  serverRevision: number
  recoveryProject: ConflictRecoveryProject
}

export function createProjectConflictSnapshot(
  local: CanvasDoc,
  serverRevision: number,
  recoveryProject: ConflictRecoveryProject | null,
  status: ConflictRecoveryStatus,
  reason: ProjectConflictReason = 'version-conflict',
): ProjectConflictSnapshot {
  return {
    local: structuredClone(local),
    serverRevision,
    recoveryProject: recoveryProject ? structuredClone(recoveryProject) : null,
    status,
    ...(reason !== 'version-conflict' ? { reason } : {}),
  }
}

export function parseProjectConflictError(error: unknown): ParsedProjectConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'PROJECT_CONFLICT') return null
  if (!error.details || typeof error.details !== 'object') return null
  const details = error.details as {
    serverRevision?: unknown
    recoveryProject?: unknown
  }
  if (!Number.isInteger(details.serverRevision) || (details.serverRevision as number) < 0) return null
  if (!details.recoveryProject || typeof details.recoveryProject !== 'object') return null
  const recovery = details.recoveryProject as Partial<ConflictRecoveryProject>
  if (
    typeof recovery.id !== 'string'
    || !/^[A-Za-z0-9_-]{6,64}$/.test(recovery.id)
    || typeof recovery.name !== 'string'
    || recovery.name.trim().length === 0
    || !Number.isInteger(recovery.revision)
    || (recovery.revision ?? -1) < 0
  ) return null
  return {
    serverRevision: details.serverRevision as number,
    recoveryProject: {
      id: recovery.id,
      name: recovery.name,
      revision: recovery.revision!,
    },
  }
}

export function downloadProjectSnapshot(snapshot: CanvasDoc, fileName = 'canai-local-copy.json'): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}
