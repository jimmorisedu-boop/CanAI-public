import { useCallback, useEffect, useRef, useState } from 'react'
import { askConfirm } from '../../ui/confirmBus'
import type { GenRef, ProjectSource } from '../../types'
import type { SelectionRef } from './konva/selection'
import { toGenRefs } from './konva/selection'
import { useCanvasActionPreparation } from './useCanvasActionPreparation'

export interface AssistantPreparationProfile {
  id: string | null
  versionId: string | null
}

export interface AssistantPromptPreparationInput {
  projectId: string
  projectSource: ProjectSource
  mode: string
  requiredMode: string
  enabled: boolean
  ready: boolean
  available: boolean
  unavailableMessage?: string
  requireConfirmation: boolean
  prompt: string
  refs: readonly SelectionRef[]
  assistantSelection: AssistantPreparationProfile | null
  assistantSelectionKnown: boolean
  setError(message: string | null): void
  onAccept(text: string, refs: SelectionRef[]): void
}

interface PreparationScope {
  epoch: number
  projectId: string
  projectSource: ProjectSource
  mode: string
}

function preparationPrompt(prompt: string, refs: readonly SelectionRef[]): string {
  const typed = prompt.trim()
  if (typed) return typed
  return refs
    .filter((ref) => ref.kind === 'text')
    .map((ref) => ref.text?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim()
}

function preparationError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to prepare images"
}

/**
 * Shared orchestration for the desktop and tablet «Подготовить» action.
 * The paid request itself remains in useCanvasActionPreparation; this hook
 * only freezes the board/profile scope and handles the review hand-off.
 */
export function useAssistantPromptPreparation(input: AssistantPromptPreparationInput) {
  const preparation = useCanvasActionPreparation()
  const [preparationRefs, setPreparationRefs] = useState<SelectionRef[]>([])
  const epochRef = useRef(0)
  const scopeRef = useRef<PreparationScope | null>(null)
  const currentRef = useRef({
    projectId: input.projectId,
    projectSource: input.projectSource,
    mode: input.mode,
  })
  currentRef.current = {
    projectId: input.projectId,
    projectSource: input.projectSource,
    mode: input.mode,
  }
  const previousScopeRef = useRef(currentRef.current)

  const invalidate = useCallback(() => {
    epochRef.current += 1
    scopeRef.current = null
    setPreparationRefs([])
    preparation.reset()
  }, [preparation.reset])

  useEffect(() => {
    const previous = previousScopeRef.current
    if (
      previous.projectId !== input.projectId
      || previous.projectSource !== input.projectSource
      || previous.mode !== input.mode
    ) {
      invalidate()
    }
    previousScopeRef.current = {
      projectId: input.projectId,
      projectSource: input.projectSource,
      mode: input.mode,
    }
  }, [input.mode, input.projectId, input.projectSource, invalidate])

  function isCurrent(scope: PreparationScope): boolean {
    return epochRef.current === scope.epoch
      && currentRef.current.projectId === scope.projectId
      && currentRef.current.projectSource === scope.projectSource
      && currentRef.current.mode === scope.mode
      && currentRef.current.mode === input.requiredMode
  }

  const preparePromptWithAssistant = useCallback(async (): Promise<void> => {
    if (!input.enabled || !input.ready || input.mode !== input.requiredMode) return
    if (!input.available) {
      if (input.unavailableMessage) input.setError(input.unavailableMessage)
      return
    }
    if (!input.assistantSelectionKnown || !input.assistantSelection) {
      input.setError("Assistant is still loading. Try again in a moment.")
      return
    }

    const epoch = epochRef.current + 1
    epochRef.current = epoch
    scopeRef.current = null
    preparation.reset()
    const scope: PreparationScope = {
      epoch,
      projectId: input.projectId,
      projectSource: input.projectSource,
      mode: input.requiredMode,
    }
    const frozenProfile = { ...input.assistantSelection }
    const frozenRefs = input.refs.map((ref) => ({ ...ref }))
    const media = frozenRefs.filter((ref) => ref.kind !== 'text')
    if (media.length === 0) {
      input.setError("To prepare with an assistant, select at least one picture.")
      return
    }
    if (media.some((ref) => ref.kind !== 'image')) {
      input.setError("Preparation assistant only accepts pictures. Remove video or audio from the selection.")
      return
    }
    const frozenPrompt = preparationPrompt(input.prompt, frozenRefs)
    if (!frozenPrompt) {
      input.setError("Write down what to change before asking your assistant to prepare the request.")
      return
    }
    if (input.requireConfirmation) {
      const confirmed = await askConfirm({
        title: "Prepare text with the assistant?",
        detail: "LLM cost is based on token usage. After preparation, you will confirm the image run separately.",
        confirmLabel: "Prepare",
        cancelLabel: "Cancel",
      })
      if (!confirmed || !isCurrent(scope)) return
    }
    if (!isCurrent(scope)) return
    input.setError(null)
    setPreparationRefs(frozenRefs)
    try {
      const converted = await toGenRefs(media, 'image')
      if (!isCurrent(scope)) return
      const imageRefs = converted.filter(
        (ref): ref is Extract<GenRef, { kind: 'image' }> => ref.kind === 'image',
      )
      if (imageRefs.length === 0) {
        setPreparationRefs([])
        input.setError("Failed to prepare pictures for assistant.")
        return
      }
      if (!isCurrent(scope)) return
      scopeRef.current = scope
      await preparation.prepare({
        projectRef: { source: input.projectSource, id: input.projectId },
        prompt: frozenPrompt,
        refs: imageRefs,
        assistantId: frozenProfile.id,
        ...(input.projectSource === 'cloud' && frozenProfile.versionId
          ? { profileVersionId: frozenProfile.versionId }
          : {}),
      })
    } catch (error) {
      if (!isCurrent(scope)) return
      setPreparationRefs([])
      input.setError(preparationError(error))
    }
  }, [
    input.assistantSelection,
    input.assistantSelectionKnown,
    input.available,
    input.enabled,
    input.mode,
    input.projectId,
    input.projectSource,
    input.prompt,
    input.ready,
    input.refs,
    input.requiredMode,
    input.requireConfirmation,
    input.setError,
    input.unavailableMessage,
    preparation,
  ])

  const acceptPreparedPrompt = useCallback((text: string): void => {
    const scope = scopeRef.current
    if (!scope || !isCurrent(scope)) return
    const frozenRefs = preparationRefs.map((ref) => ({ ...ref }))
    input.onAccept(text, frozenRefs)
    scopeRef.current = null
    setPreparationRefs([])
    preparation.reset()
    input.setError(null)
  }, [input, preparation, preparationRefs])

  return {
    preparation,
    preparePromptWithAssistant,
    acceptPreparedPrompt,
    preparationRefs,
    invalidatePreparation: invalidate,
  }
}
