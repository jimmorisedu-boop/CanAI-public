import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentLlmCatalogSource } from './llm-broker.js'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { resolveCatalogPreset } from '../../../packages/model-catalog/catalog.js'
import { GenerationGate } from '../generationGate.js'
import type { AgentTaskRecord } from './types.js'
import {
  AGENT_LLM_CONNECTION,
  AgentLlmBroker,
  type AgentLlmProvider,
  type AgentLlmProviderResult,
} from './llm-broker.js'
import { AgentTaskJournal } from './journal.js'
import { buildAgentTextInput, parseFalTextUsage } from '../fal.js'

const model: CatalogModel = {
  id: 'assistant-test', name: 'Assistant test', kind: 'text' as const, endpoint: 'openrouter/router', lifecycle: 'active' as const,
  defaults: { model: 'test/model' }, textPricing: { inputPerMillion: 1, outputPerMillion: 1, checkedAt: '2026-10-01T00:00:00.000Z' }, contextWindowTokens: 20_000,
}

function catalog(defaultModelId = model.id, initial: CatalogModel = model): AgentLlmCatalogSource & { setModel(next: CatalogModel): void } {
  let current = initial
  return {
    models: () => [current],
    defaultModelId: () => defaultModelId,
    view: () => ({ revision: 7 }),
    setModel: (next) => { current = next },
  }
}

function result(costMicros = 1_500): AgentLlmProviderResult {
  return { text: 'Ответ агента', usage: { inputTokens: 3, outputTokens: 4, costMicros } }
}

class FakeProvider implements AgentLlmProvider {
  submits = 0
  resumes = 0
  cancels = 0
  lastMessages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }> = []
  response = result()
  lostResponse = false
  submitWait: Promise<void> | null = null
  cancelWait: Promise<void> | null = null
  cancelError = false
  private readonly active = new Set<string>()

  async submit(_model: typeof model, messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>, _maxTokens: number, onEnqueued: (requestId: string, endpoint: string) => Promise<void>): Promise<AgentLlmProviderResult> {
    this.submits++
    this.lastMessages = messages
    const requestId = `fal-request-${this.submits}`
    this.active.add(requestId)
    await onEnqueued(requestId, 'openrouter/router')
    if (this.submitWait) await this.submitWait
    if (this.lostResponse) throw new Error('response lost after queue commit')
    return this.response
  }

  async resume(_model: typeof model, requestId: string): Promise<AgentLlmProviderResult> {
    this.resumes++
    assert.ok(this.active.has(requestId))
    return this.response
  }

  async cancel(_model: typeof model, requestId: string): Promise<void> {
    this.cancels++
    if (this.cancelWait) await this.cancelWait
    if (this.cancelError) throw new Error('cancel unavailable')
    this.active.delete(requestId)
  }
}

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

function cleanup(root: string): Promise<void> {
  return fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
}

async function fixture(options: { cap?: number; provider?: FakeProvider; catalogSource?: ReturnType<typeof catalog>; gate?: GenerationGate; cancelTimeoutMs?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-llm-'))
  const journal = new AgentTaskJournal(path.join(root, 'agent-tasks.json'), { workspaceRoot: root, checkpointRoot: path.join(root, 'checkpoints') })
  const provider = options.provider ?? new FakeProvider()
  const catalogSource = options.catalogSource ?? catalog()
  const broker = new AgentLlmBroker({ journal, catalog: catalogSource, provider, generationGate: options.gate, connectionReady: () => true, cancelTimeoutMs: options.cancelTimeoutMs })
  const taskId = 'agent-task-llm-test'
  const budget = broker.prepareTask(taskId, 'local', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: options.cap ?? 100_000, expectedModelId: model.id, expectedCatalogRevision: 7 })!
  const task: AgentTaskRecord = {
    taskId, requestId: 'request-llm-test', requestHash: 'hash', packageId: 'test', packageVersion: '1', packageSha: 'a'.repeat(64), protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board-llm-test' }, ownerId: 'owner', controllerId: 'controller', taskType: 'llm', instruction: 'test', input: {}, inputs: [],
    workspaceId: 'workspace-llm-test', workspacePath: taskId, state: 'running', revision: 1, eventCursor: 0, currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {},
    llmBudget: budget, llmOperations: [], receipts: [], reviews: [], decisions: [], artifacts: [], canvasItems: [], pendingCanvasItems: [], createdAt: 1, updatedAt: 1,
  }
  await journal.create(task)
  return { root, journal, broker, provider, task }
}

function args(grantId: string, text = 'Составь короткий план') {
  return { connectionId: AGENT_LLM_CONNECTION, grantId, messages: [{ role: 'user' as const, text }], refs: [] }
}

test('LLM duplicate replays one durable submit and pins the assistant model', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  const first = await fixtureValue.broker.execute(fixtureValue.task, input, 'llm-op-1')
  const second = await fixtureValue.broker.execute((await fixtureValue.journal.get(fixtureValue.task.taskId))!, input, 'llm-op-1')
  assert.deepEqual(second, first)
  assert.equal(fixtureValue.provider.submits, 1)
  assert.equal(fixtureValue.provider.resumes, 0)
  assert.equal((await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmBudget!.chargedMicros, 1_500)
})

test('successful LLM replay uses the original model pins after active catalog changes', async (t) => {
  const catalogSource = catalog()
  const fixtureValue = await fixture({ catalogSource })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  const first = await fixtureValue.broker.execute(fixtureValue.task, input, 'catalog-replay')
  catalogSource.setModel({ ...model, defaults: { model: 'changed/model' }, contextWindowTokens: 1 })
  const restarted = new AgentLlmBroker({
    journal: fixtureValue.journal,
    catalog: catalogSource,
    provider: fixtureValue.provider,
    connectionReady: () => true,
  })
  const replay = await restarted.execute((await fixtureValue.journal.get(fixtureValue.task.taskId))!, input, 'catalog-replay')
  assert.deepEqual(replay, first)
  assert.equal(fixtureValue.provider.submits, 1)
  assert.equal(fixtureValue.provider.resumes, 0)
})

test('reusing an operationId with changed arguments is rejected without a second submit', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const grantId = fixtureValue.task.llmBudget!.grantId
  await fixtureValue.broker.execute(fixtureValue.task, args(grantId, 'first'), 'conflicting-op')
  await assert.rejects(
    fixtureValue.broker.execute((await fixtureValue.journal.get(fixtureValue.task.taskId))!, args(grantId, 'changed'), 'conflicting-op'),
    (error: unknown) => (error as { code?: string }).code === 'OPERATION_CONFLICT',
  )
  assert.equal(fixtureValue.provider.submits, 1)
})

test('concurrent reservations cannot exceed the task ceiling', async (t) => {
  const fixtureValue = await fixture({ cap: 1_030 })
  t.after(() => cleanup(fixtureValue.root))
  const inputA = args(fixtureValue.task.llmBudget!.grantId, 'A')
  const inputB = args(fixtureValue.task.llmBudget!.grantId, 'B')
  const outcomes = await Promise.allSettled([
    fixtureValue.broker.execute(fixtureValue.task, inputA, 'llm-op-a'),
    fixtureValue.broker.execute(fixtureValue.task, inputB, 'llm-op-b'),
  ])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === 'BUDGET_EXCEEDED').length, 1)
  assert.equal(fixtureValue.provider.submits, 1)
})

test('a first-call estimate above the approved cap is rejected before submit', async (t) => {
  const fixtureValue = await fixture({ cap: 1_026 })
  t.after(() => cleanup(fixtureValue.root))
  await assert.rejects(
    fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId, 'A'), 'over-cap-first'),
    (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED',
  )
  const task = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(fixtureValue.provider.submits, 0)
  assert.deepEqual(task.llmOperations, [])
  assert.equal(task.llmBudget!.reservedMicros, 0)
})

test('max call count stays atomic with budget admission under concurrency', async (t) => {
  const fixtureValue = await fixture({ cap: 100_000 })
  t.after(() => cleanup(fixtureValue.root))
  const grantId = fixtureValue.task.llmBudget!.grantId
  const outcomes = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => (
    fixtureValue.broker.execute(fixtureValue.task, args(grantId, `call-${index}`), `call-${index}`)
  )))
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 8)
  assert.equal(outcomes.filter((entry) => entry.status === 'rejected' && (entry.reason as { code?: string }).code === 'BUDGET_EXCEEDED').length, 1)
  const task = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(fixtureValue.provider.submits, 8)
  assert.equal(task.llmBudget!.calls, 8)
  assert.equal(task.llmBudget!.status, 'exhausted')
})

test('final provider charge may overshoot estimate, then future calls are blocked', async (t) => {
  const provider = new FakeProvider()
  provider.response = result(2_000)
  const fixtureValue = await fixture({ cap: 1_100, provider })
  t.after(() => cleanup(fixtureValue.root))
  const first = await fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId), 'llm-op-overshoot')
  assert.equal((first.result.charged as { amountMicros: number }).amountMicros, 2_000)
  const budget = (await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmBudget!
  assert.equal(budget.status, 'overspent')
  await assert.rejects(fixtureValue.broker.execute((await fixtureValue.journal.get(fixtureValue.task.taskId))!, args(budget.grantId, 'second'), 'llm-op-second'), (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED')
  assert.equal(provider.submits, 1)
})

test('lost response resumes the saved fal request without a second submit', async (t) => {
  const provider = new FakeProvider()
  provider.lostResponse = true
  const fixtureValue = await fixture({ provider })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, input, 'llm-op-recover'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  const afterFailure = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(afterFailure.llmOperations![0].status, 'uncertain')
  assert.equal(afterFailure.llmOperations![0].providerRequestId, 'fal-request-1')
  provider.lostResponse = false
  const recovered = await fixtureValue.broker.execute(afterFailure, input, 'llm-op-recover')
  assert.equal((recovered.result.charged as { amountMicros: number }).amountMicros, 1_500)
  assert.equal(provider.submits, 1)
  assert.equal(provider.resumes, 1)
})

test('terminal cancelled LLM task resumes the durable request once without reviving the task', async (t) => {
  const provider = new FakeProvider()
  provider.lostResponse = true
  const catalogSource = catalog()
  const fixtureValue = await fixture({ provider, catalogSource })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)

  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, input, 'cancelled-replay'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  await fixtureValue.journal.mutate(fixtureValue.task.taskId, (entry) => {
    const operation = entry.llmOperations?.[0]
    if (!operation) throw new Error('LLM operation fixture missing')
    operation.status = 'cancelled'
    operation.error = { code: 'LLM_CANCELLED', message: 'cancelled before late provider result', retryable: true }
    entry.state = 'cancelled'
  }, { type: 'test.task-cancelled', payload: {} })
  catalogSource.setModel({ ...model, defaults: { model: 'changed/model' }, contextWindowTokens: 1 })
  provider.lostResponse = false

  const restartedJournal = new AgentTaskJournal(path.join(fixtureValue.root, 'agent-tasks.json'), {
    workspaceRoot: fixtureValue.root,
    checkpointRoot: path.join(fixtureValue.root, 'checkpoints'),
  })
  const restarted = new AgentLlmBroker({
    journal: restartedJournal,
    catalog: catalogSource,
    provider,
    connectionReady: () => true,
  })
  const recovered = await restarted.execute((await restartedJournal.get(fixtureValue.task.taskId))!, input, 'cancelled-replay')
  const replay = await restarted.execute((await restartedJournal.get(fixtureValue.task.taskId))!, input, 'cancelled-replay')
  await assert.rejects(
    restarted.execute((await restartedJournal.get(fixtureValue.task.taskId))!, input, 'cancelled-new-operation'),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_RUNNING',
  )
  const saved = (await restartedJournal.get(fixtureValue.task.taskId))!
  assert.deepEqual(replay, recovered)
  assert.equal(provider.submits, 1)
  assert.equal(provider.resumes, 1)
  assert.equal((recovered.result.charged as { amountMicros: number }).amountMicros, 1_500)
  assert.equal(saved.state, 'cancelled')
  assert.equal(saved.llmOperations![0]!.status, 'succeeded')
  assert.equal(saved.llmBudget!.chargedMicros, 1_500)
  assert.equal(saved.llmBudget!.calls, 1)
})

test('model pin, cloud, refs and missing consent fail before provider submit', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const grantId = fixtureValue.task.llmBudget!.grantId
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, { ...args(grantId), refs: [{ artifactId: 'x', revision: 1, checksum: 'a'.repeat(64) }] }, 'bad-ref'), (error: unknown) => (error as { code?: string }).code === 'INPUT_INVALID')
  const disabled = new AgentLlmBroker({ journal: fixtureValue.journal, catalog: catalog(model.id, { ...model, lifecycle: 'disabled' }), provider: fixtureValue.provider, connectionReady: () => true })
  await assert.rejects(disabled.execute(fixtureValue.task, args(grantId), 'disabled-model'), (error: unknown) => (error as { code?: string }).code === 'LLM_MODEL_UNSUPPORTED')
  assert.equal(fixtureValue.provider.submits, 0)
  assert.throws(() => fixtureValue.broker.prepareTask('agent-task-cloud', 'cloud', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000, expectedModelId: model.id, expectedCatalogRevision: 7 }), (error: unknown) => (error as { code?: string }).code === 'LLM_LOCAL_ONLY')
})

test('negative or missing provider cost never becomes a successful financial receipt', async (t) => {
  const provider = new FakeProvider()
  provider.response = { text: 'Ответ', usage: { inputTokens: 1, outputTokens: 1, costMicros: -1 } }
  const fixtureValue = await fixture({ provider })
  t.after(() => cleanup(fixtureValue.root))
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId), 'bad-cost'), (error: unknown) => (error as { code?: string }).code === 'LLM_COST_INVALID')
  const operation = (await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmOperations![0]
  assert.notEqual(operation.status, 'succeeded')

  const missingProvider = new FakeProvider()
  missingProvider.response = { text: 'Ответ', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as AgentLlmProviderResult
  const missingFixture = await fixture({ provider: missingProvider })
  t.after(() => cleanup(missingFixture.root))
  await assert.rejects(missingFixture.broker.execute(missingFixture.task, args(missingFixture.task.llmBudget!.grantId), 'missing-cost'), (error: unknown) => (error as { code?: string }).code === 'LLM_COST_INVALID')
  const missingTask = (await missingFixture.journal.get(missingFixture.task.taskId))!
  assert.equal(missingTask.llmOperations![0].status, 'uncertain')
  assert.equal(missingTask.llmBudget!.chargedMicros, 0)
  assert.ok(missingTask.llmBudget!.reservedMicros > 0)
})

test('concurrent replay of one operation shares one durable provider submit', async (t) => {
  const provider = new FakeProvider()
  const gate = deferred()
  provider.submitWait = gate.promise
  const fixtureValue = await fixture({ provider })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  const first = fixtureValue.broker.execute(fixtureValue.task, input, 'same-op')
  await waitFor(() => provider.submits === 1)
  const second = fixtureValue.broker.execute(fixtureValue.task, input, 'same-op')
  gate.release()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(provider.submits, 1)
  assert.equal((await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmOperations![0].status, 'succeeded')
})

test('generation gate rejection releases a known-unsubmitted reservation', async (t) => {
  const gate = new GenerationGate()
  gate.close()
  const provider = new FakeProvider()
  const fixtureValue = await fixture({ provider, gate })
  t.after(() => cleanup(fixtureValue.root))
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId), 'gate-closed'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_SHUTTING_DOWN')
  const task = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(provider.submits, 0)
  assert.equal(task.llmOperations![0].status, 'failed')
  assert.equal(task.llmOperations![0].reservedMicros, 0)
  assert.equal(task.llmBudget!.reservedMicros, 0)
  assert.equal(task.llmBudget!.calls, 0)
  assert.equal(task.llmBudget!.status, 'active')

  const replacement = new AgentLlmBroker({
    journal: fixtureValue.journal,
    catalog: catalog(),
    provider,
    generationGate: new GenerationGate(),
    connectionReady: () => true,
  })
  const recovered = await replacement.execute(task, args(task.llmBudget!.grantId, 'retry after gate'), 'gate-retry')
  const afterRetry = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal((recovered.result.charged as { amountMicros: number }).amountMicros, 1_500)
  assert.equal(provider.submits, 1)
  assert.equal(afterRetry.llmBudget!.calls, 1)
})

test('journal fault after provider commit holds the intent and forbids a second submit', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const originalMutate = fixtureValue.journal.mutate.bind(fixtureValue.journal)
  let failSubmitted = true
  const patchableJournal: { mutate: typeof fixtureValue.journal.mutate } = fixtureValue.journal
  patchableJournal.mutate = async (taskId, updater, event) => {
    if (failSubmitted && event?.type === 'llm.submitted') {
      failSubmitted = false
      throw new Error('simulated journal failure after provider commit')
    }
    return originalMutate(taskId, updater, event)
  }
  const input = args(fixtureValue.task.llmBudget!.grantId)
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, input, 'journal-fault'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  const uncertain = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(uncertain.llmOperations![0].status, 'uncertain')
  assert.equal(uncertain.llmOperations![0].providerRequestId, undefined)
  assert.equal(uncertain.llmBudget!.calls, 1)
  assert.equal(uncertain.llmBudget!.status, 'blocked')
  await assert.rejects(fixtureValue.broker.execute(uncertain, input, 'journal-fault'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  assert.equal(fixtureValue.provider.submits, 1)
  assert.ok((await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmBudget!.reservedMicros > 0)
})

test('cancel without a durable provider ID holds the ambiguous intent', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const originalMutate = fixtureValue.journal.mutate.bind(fixtureValue.journal)
  let failSubmitted = true
  const patchableJournal: { mutate: typeof fixtureValue.journal.mutate } = fixtureValue.journal
  patchableJournal.mutate = async (taskId, updater, event) => {
    if (failSubmitted && event?.type === 'llm.submitted') {
      failSubmitted = false
      throw new Error('simulated enqueue journal failure')
    }
    return originalMutate(taskId, updater, event)
  }
  const input = args(fixtureValue.task.llmBudget!.grantId)
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, input, 'cancel-unknown'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  await fixtureValue.broker.cancelTask((await fixtureValue.journal.get(fixtureValue.task.taskId))!)
  const held = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(held.llmOperations![0].status, 'uncertain')
  assert.equal(held.llmOperations![0].providerRequestId, undefined)
  assert.ok(held.llmBudget!.reservedMicros > 0)
  await assert.rejects(fixtureValue.broker.execute(held, input, 'cancel-unknown'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  assert.equal(fixtureValue.provider.submits, 1)
})

test('cancel ACK keeps the reservation until a late result is reconciled', async (t) => {
  const provider = new FakeProvider()
  const submitWait = deferred()
  provider.submitWait = submitWait.promise
  const fixtureValue = await fixture({ cap: 1_100, provider })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  const running = fixtureValue.broker.execute(fixtureValue.task, input, 'cancel-race')
  await waitFor(() => provider.submits === 1)
  await fixtureValue.broker.cancelTask((await fixtureValue.journal.get(fixtureValue.task.taskId))!)
  const cancelled = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(cancelled.llmOperations![0].status, 'cancelled')
  assert.ok(cancelled.llmBudget!.reservedMicros > 0)
  submitWait.release()
  const resultValue = await running
  assert.equal((resultValue.result.charged as { amountMicros: number }).amountMicros, 1_500)
  const settled = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(settled.llmOperations![0].status, 'succeeded')
  assert.equal(settled.llmBudget!.chargedMicros, 1_500)
  await assert.rejects(fixtureValue.broker.execute(settled, args(settled.llmBudget!.grantId, 'after-cancel'), 'after-cancel'), (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED')
  assert.equal(provider.submits, 1)
})

test('hung provider cancel is bounded and keeps the reservation uncertain', async (t) => {
  const provider = new FakeProvider()
  const submitWait = deferred()
  provider.submitWait = submitWait.promise
  provider.cancelWait = new Promise<void>(() => {})
  const fixtureValue = await fixture({ cap: 1_100, provider, cancelTimeoutMs: 10 })
  t.after(() => cleanup(fixtureValue.root))
  const running = fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId), 'cancel-timeout')
  await waitFor(() => provider.submits === 1)
  const startedAt = Date.now()
  await fixtureValue.broker.cancelTask((await fixtureValue.journal.get(fixtureValue.task.taskId))!)
  assert.ok(Date.now() - startedAt < 500)
  const held = (await fixtureValue.journal.get(fixtureValue.task.taskId))!
  assert.equal(provider.cancels, 1)
  assert.equal(held.llmOperations![0].status, 'uncertain')
  assert.ok(held.llmBudget!.reservedMicros > 0)
  submitWait.release()
  await running
})

test('resume uses the pinned model snapshot after the catalog archives the model', async (t) => {
  const provider = new FakeProvider()
  provider.lostResponse = true
  const catalogSource = catalog()
  const fixtureValue = await fixture({ provider, catalogSource })
  t.after(() => cleanup(fixtureValue.root))
  const input = args(fixtureValue.task.llmBudget!.grantId)
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, input, 'resume-pinned'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  catalogSource.setModel({ ...model, lifecycle: 'disabled' })
  provider.lostResponse = false
  const resumed = await fixtureValue.broker.execute((await fixtureValue.journal.get(fixtureValue.task.taskId))!, input, 'resume-pinned')
  assert.equal((resumed.result.charged as { amountMicros: number }).amountMicros, 1_500)
  assert.equal(provider.submits, 1)
  assert.equal(provider.resumes, 1)
})

test('stale grants and catalog snapshots fail before a paid submit', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const grantId = fixtureValue.task.llmBudget!.grantId
  await fixtureValue.journal.mutate(fixtureValue.task.taskId, (entry) => { entry.llmBudget!.grantId = 'stale-grant' })
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, args(grantId), 'stale-grant'), (error: unknown) => (error as { code?: string }).code === 'GRANT_REQUIRED')
  assert.equal(fixtureValue.provider.submits, 0)
  assert.throws(() => fixtureValue.broker.prepareTask('expected-model', 'local', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000, expectedModelId: 'wrong-model', expectedCatalogRevision: 7 }), (error: unknown) => (error as { code?: string }).code === 'LLM_MODEL_PIN_MISMATCH')
  assert.throws(() => fixtureValue.broker.prepareTask('expected-revision', 'local', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000, expectedModelId: model.id, expectedCatalogRevision: 8 }), (error: unknown) => (error as { code?: string }).code === 'LLM_CATALOG_STALE')
  assert.throws(() => fixtureValue.broker.prepareTask('missing-snapshot', 'local', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000 }), (error: unknown) => (error as { code?: string }).code === 'LLM_AUTH_REQUIRED')
})

test('fal usage accepts cost-only responses and nested token details', () => {
  const usage = parseFalTextUsage({ usage: { cost: 0.25, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2, reasoning_tokens: 1 } } })
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0.25, cacheWriteTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 })
})

test('Agent Host text params are an explicit safe allowlist', () => {
  const resolved = resolveCatalogPreset({ ...model, defaults: { model: 'pinned/model', reasoning: true, enable_web_search: true, secret: 'must-not-pass' } })
  const request = buildAgentTextInput(resolved, [{ role: 'system', text: 'system rules' }, { role: 'user', text: 'question' }], 32)
  assert.deepEqual(request.input, { prompt: 'User:\nquestion', model: 'pinned/model', max_tokens: 32, reasoning: false, enable_web_search: false, system_prompt: 'system rules' })
})

test('CANAI_MOCK fail-closes Agent LLM even when a readiness callback says ready', async (t) => {
  const fixtureValue = await fixture()
  t.after(() => cleanup(fixtureValue.root))
  const broker = new AgentLlmBroker({ journal: fixtureValue.journal, catalog: catalog(), provider: fixtureValue.provider, connectionReady: () => true, mockMode: true })
  assert.throws(() => broker.prepareTask('mock-task', 'local', ['llm.request'], { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000, expectedModelId: model.id, expectedCatalogRevision: 7 }), (error: unknown) => (error as { code?: string }).code === 'LLM_CONNECTION_UNAVAILABLE')
})

test('CANAI_MOCK fail-closes persisted LLM recovery without provider resume', async (t) => {
  const provider = new FakeProvider()
  provider.lostResponse = true
  const fixtureValue = await fixture({ provider })
  t.after(() => cleanup(fixtureValue.root))
  await assert.rejects(fixtureValue.broker.execute(fixtureValue.task, args(fixtureValue.task.llmBudget!.grantId), 'mock-recovery'), (error: unknown) => (error as { code?: string }).code === 'LLM_OUTCOME_UNCERTAIN')
  const mockBroker = new AgentLlmBroker({ journal: fixtureValue.journal, catalog: catalog(), provider, connectionReady: () => true, mockMode: true })
  await mockBroker.recoverPersisted((await fixtureValue.journal.get(fixtureValue.task.taskId))!)
  assert.equal(provider.submits, 1)
  assert.equal(provider.resumes, 0)
  assert.equal((await fixtureValue.journal.get(fixtureValue.task.taskId))!.llmOperations![0]!.status, 'uncertain')
})
