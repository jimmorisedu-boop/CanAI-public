import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentLlmCatalogView, AgentPackageSummary, AgentTaskView } from '../../../../../packages/agent-protocol/index'
import {
  formatUsdMicros,
  llmAuthorization,
  llmLaunchInfo,
  packageRequiresLlm,
  parseUsdMicros,
  taskBudgetSnapshot,
} from './agentBudgetModel'
import {
  agentLlmConsentScope,
  approveAgentLlmConsent,
  emptyAgentBudgetDraft,
  hasCurrentAgentLlmConsent,
  launchCompletionIsCurrent,
  revokeAgentLlmConsent,
} from './agentLaunchModel'

const local = { source: 'local' as const, id: 'board-a' }

function pkg(overrides: Partial<AgentPackageSummary> = {}): AgentPackageSummary {
  return {
    id: 'writer', name: 'Writer', description: 'Writer', version: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    taskTypes: [{ id: 'write', label: 'Write', description: 'Write', outputKinds: ['text'] }],
    permissions: ['llm.request'], lifecycle: { pause: 'checkpoint', resume: true, cancel: true }, handshake: 'ready',
    ...overrides,
  }
}

function task(overrides: Record<string, unknown> = {}): AgentTaskView {
  return {
    taskId: 'task', requestId: 'request', packageId: 'writer', packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    projectRef: local, ownerId: 'owner', controllerId: 'host', taskType: 'write', instruction: 'x', input: {}, inputs: [],
    workspaceId: 'workspace', state: 'running', revision: 1, eventCursor: 1, reviews: [], receipts: [], artifacts: [], canvasItems: [],
    createdAt: 1, updatedAt: 1, ...overrides,
  } as AgentTaskView
}

test('USD budget accepts positive micros and rejects zero or precision beyond micros', () => {
  assert.equal(parseUsdMicros('0').amountMicros, null)
  assert.equal(parseUsdMicros('0.000001').amountMicros, 1)
  assert.equal(parseUsdMicros('1.234567').amountMicros, 1_234_567)
  assert.equal(parseUsdMicros('1.2345671').amountMicros, null)
  assert.equal(parseUsdMicros('1,20').amountMicros, null)
  assert.equal(formatUsdMicros(300_000), '$0.3')
})

test('LLM permission is local-only and missing fal.ai advertisement stays unavailable', () => {
  assert.equal(packageRequiresLlm(pkg()), true)
  assert.equal(llmLaunchInfo(pkg(), { source: 'cloud', id: 'cloud-board' })?.available, false)
  assert.match(llmLaunchInfo(pkg(), local)?.unavailableReason ?? '', /fal\.ai|подключение/u)
  assert.equal(llmLaunchInfo({ ...pkg(), permissions: [] }, local), null)
})

test('LLM launch uses the ready local-fal catalog and exact trusted authorization', () => {
  const catalog: AgentLlmCatalogView = {
    revision: 8,
    connection: { id: 'local-fal', kind: 'llm', status: 'ready' },
    defaultModelId: 'assistant-text',
    models: [{ id: 'assistant-text', name: 'Assistant Text', active: true }],
  }
  const info = llmLaunchInfo(pkg(), local, catalog)
  assert.equal(info?.available, true)
  assert.equal(info?.modelId, 'assistant-text')
  assert.deepEqual(llmAuthorization(info, 500_000, true), {
    connectionId: 'local-fal', textTransferConsent: true, maxCostMicros: 500_000,
    expectedModelId: 'assistant-text', expectedCatalogRevision: 8,
  })
  assert.equal(llmAuthorization(info, 500_000, false), null)
  assert.equal(llmAuthorization(info, 0, true), null)
})

test('LLM consent is bound to draft text, task input, budget, and catalog pin', () => {
  const catalog: AgentLlmCatalogView = {
    revision: 8,
    connection: { id: 'local-fal', kind: 'llm', status: 'ready' },
    defaultModelId: 'assistant-text',
    models: [{ id: 'assistant-text', name: 'Assistant Text', active: true }],
  }
  const info = llmLaunchInfo(pkg(), local, catalog)
  const base = { projectRef: local, packageId: 'writer', taskType: 'write', instruction: 'Сделай план', context: { tone: 'plain' }, budgetInput: '0.50', llmInfo: info }
  const scope = agentLlmConsentScope(base)
  const approved = approveAgentLlmConsent(emptyAgentBudgetDraft(), scope, true)
  assert.equal(hasCurrentAgentLlmConsent(approved, scope), true)
  assert.equal(hasCurrentAgentLlmConsent(revokeAgentLlmConsent(approved), scope), false)
  const reapproved = approveAgentLlmConsent(revokeAgentLlmConsent(approved), scope, true)
  assert.notEqual(reapproved.consentVersion, approved.consentVersion)
  assert.equal(hasCurrentAgentLlmConsent(approved, agentLlmConsentScope({ ...base, instruction: 'Сделай другой план' })), false)
  assert.equal(hasCurrentAgentLlmConsent(approved, agentLlmConsentScope({ ...base, context: { tone: 'formal' } })), false)
  assert.equal(hasCurrentAgentLlmConsent(approved, agentLlmConsentScope({ ...base, budgetInput: '0.60' })), false)
  assert.equal(hasCurrentAgentLlmConsent(approved, agentLlmConsentScope({ ...base, llmInfo: { ...info!, catalogRevision: 9 } })), false)
})

test('late launch completion cannot clear a newer draft decision', () => {
  assert.equal(launchCompletionIsCurrent(4, 'same', 4, 'same'), true)
  assert.equal(launchCompletionIsCurrent(4, 'old', 5, 'new'), false)
  assert.equal(launchCompletionIsCurrent(4, 'old', 4, 'new'), false)
})

test('budget presentation never turns estimate into charged expense', () => {
  const estimate = taskBudgetSnapshot(task({ budget: { status: 'estimate', estimateMicros: 300_000 } }))
  assert.deepEqual(estimate, { status: 'estimate', currency: 'USD', estimateMicros: 300_000 })
  const settled = taskBudgetSnapshot(task({ expense: { status: 'charged', reservedMicros: 300_000, charged: { amountMicros: 312_000 }, remainingMicros: 688_000 } }))
  assert.deepEqual(settled, {
    status: 'charged', currency: 'USD', reservedMicros: 300_000, chargedMicros: 312_000, remainingMicros: 688_000,
  })
})

test('Host llmBudget remains authoritative for limit, reserve, actual, and overshoot', () => {
  const snapshot = taskBudgetSnapshot(task({ llmBudget: {
    connectionId: 'local-fal', currency: 'USD', maxCostMicros: 500_000, reservedMicros: 320_000,
    chargedMicros: 520_000, overshootMicros: 20_000, calls: 2, maxCalls: 8, status: 'overspent',
    modelId: 'assistant-text', catalogRevision: 8, pricing: { inputPerMillion: 1, outputPerMillion: 2, checkedAt: 'now' },
  } }))
  assert.deepEqual(snapshot, {
    status: 'overspent', currency: 'USD', limitMicros: 500_000, reservedMicros: 320_000,
    chargedMicros: 520_000, remainingMicros: 0, overshootMicros: 20_000, calls: 2, maxCalls: 8,
    modelId: 'assistant-text',
  })
})

test('shared spendBudget wins over legacy independent paid ceilings', () => {
  const snapshot = taskBudgetSnapshot(task({
    spendBudget: {
      grantId: 'shared-grant', connectionId: 'local-fal', currency: 'USD', maxCostMicros: 900_000,
      reservedMicros: 200_000, chargedMicros: 300_000, overshootMicros: 0, calls: 1, maxCalls: 1, status: 'active',
    },
    llmBudget: { status: 'overspent', maxCostMicros: 100_000, chargedMicros: 100_001 },
    generationBudget: { status: 'blocked', maxCostMicros: 500_000, chargedMicros: 0 },
  }))
  assert.deepEqual(snapshot, {
    status: 'reserved', currency: 'USD', limitMicros: 900_000, reservedMicros: 200_000,
    chargedMicros: 300_000, remainingMicros: 400_000, overshootMicros: 0, calls: 1, maxCalls: 1,
  })
})

test('remaining budget subtracts settled and reserved micros even when receipt reports the limit', () => {
  const snapshot = taskBudgetSnapshot(task({ spendBudget: {
    maxCostMicros: 500_000, reservedMicros: 0, chargedMicros: 1_500,
    remainingMicros: 500_000, status: 'reserved', calls: 1, maxCalls: 2,
  } }))
  assert.equal(snapshot?.status, 'charged')
  assert.equal(snapshot?.remainingMicros, 498_500)
})
