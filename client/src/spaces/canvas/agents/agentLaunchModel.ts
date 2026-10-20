import type { ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { AgentLlmLaunchInfo } from './agentBudgetModel'

export type AgentBudgetDraft = {
  input: string
  consent: boolean
  consentScope: string | null
  consentVersion: number
}

export function emptyAgentBudgetDraft(): AgentBudgetDraft {
  return { input: '', consent: false, consentScope: null, consentVersion: 0 }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
}

/**
 * Consent covers the exact text/context and Host pin that will be sent. A
 * changed task input, budget, default model, or catalog revision therefore
 * cannot inherit an earlier approval, even when the user returns to a prior
 * value later in the same panel.
 */
export function agentLlmConsentScope({
  projectRef,
  packageId,
  taskType,
  instruction,
  context,
  budgetInput,
  llmInfo,
}: {
  projectRef: ProjectRef
  packageId?: string
  taskType?: string
  instruction: string
  context: Record<string, unknown>
  budgetInput: string
  llmInfo: Pick<AgentLlmLaunchInfo, 'connectionId' | 'modelId' | 'catalogRevision' | 'available'> | null
}): string {
  return JSON.stringify(canonical({
    projectRef,
    packageId: packageId ?? '',
    taskType: taskType ?? '',
    instruction,
    context,
    budgetInput,
    llm: llmInfo ? {
      available: llmInfo.available,
      connectionId: llmInfo.connectionId,
      modelId: llmInfo.modelId,
      catalogRevision: llmInfo.catalogRevision ?? null,
    } : null,
  }))
}

export function hasCurrentAgentLlmConsent(draft: AgentBudgetDraft, scope: string): boolean {
  return draft.consent && draft.consentScope === scope
}

export function approveAgentLlmConsent(draft: AgentBudgetDraft, scope: string, consent: boolean): AgentBudgetDraft {
  return {
    ...draft,
    consent,
    consentScope: consent ? scope : null,
    consentVersion: consent ? draft.consentVersion + 1 : draft.consentVersion,
  }
}

export function revokeAgentLlmConsent(draft: AgentBudgetDraft): AgentBudgetDraft {
  return { ...draft, consent: false, consentScope: null }
}

export function launchCompletionIsCurrent(
  capturedSerial: number,
  capturedFingerprint: string,
  currentSerial: number,
  currentFingerprint: string,
): boolean {
  return capturedSerial === currentSerial && capturedFingerprint === currentFingerprint
}
