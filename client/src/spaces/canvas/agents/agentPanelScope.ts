import type { ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { ProjectRef as CanvasProjectRef } from '../../../types'

export const draftByProject = new Map<string, string>()
export const collapsedByProject = new Map<string, boolean>()
export const selectedByProject = new Map<string, string | null>()

export function keyOf(ref: ProjectRef): string {
  return `${ref.source}:${ref.id}`
}

export function projectRefOf(ref: CanvasProjectRef): ProjectRef {
  return { source: ref.source, id: ref.id }
}
