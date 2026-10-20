import type { ProjectSource } from '../types'
import type { SelectionRef } from '../spaces/canvas/konva/selection'

export interface TabletPreparationScope {
  epoch: number
  projectId: string
  projectSource: ProjectSource
  mode: 'prompt' | 'assistant'
}

export interface TabletPreparationCurrent {
  projectId: string
  projectSource: ProjectSource
  mode: 'prompt' | 'assistant'
}

/** Freeze identities and source URLs before profile confirmation or conversion. */
export function freezeTabletPreparationRefs(refs: readonly SelectionRef[]): SelectionRef[] {
  return refs.map((ref) => ({ ...ref }))
}

/** A text-only fallback is used only when the prompt field itself is empty. */
export function tabletPreparationPrompt(prompt: string, refs: readonly SelectionRef[]): string {
  const typed = prompt.trim()
  if (typed) return typed
  return refs
    .filter((ref) => ref.kind === 'text')
    .map((ref) => ref.text?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim()
}

export function tabletPreparationIsCurrent(
  scope: TabletPreparationScope,
  current: TabletPreparationCurrent,
): boolean {
  return scope.projectId === current.projectId
    && scope.projectSource === current.projectSource
    && scope.mode === current.mode
}
