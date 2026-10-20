import crypto from 'node:crypto'
import type {
  AgentConnection,
  AgentGrant,
  AgentLlmAuthorization,
  AgentLlmBudgetView,
  AgentLlmCatalogView,
} from '../../../packages/agent-protocol/index.js'
import { resolveCatalogPreset, type CatalogModel, type TextTokenPricing } from '../../../packages/model-catalog/catalog.js'
import { generationGate, type GenerationGate } from '../generationGate.js'
import {
  cancelFalRequest,
  generateTextForAgent,
  resumeTextForAgent,
  type FalTextResult,
} from '../fal.js'
import { AgentTaskJournal } from './journal.js'
import { syncSpendBudget, type AgentLlmOperation, type AgentTaskRecord } from './types.js'
import { AgentToolError, sharedSpendStatusFor, stableScopedId, type ToolResult } from './tool-shared.js'

export const AGENT_LLM_CONNECTION = 'local-fal' as const
export const AGENT_LLM_MAX_CALLS = 8
export const AGENT_LLM_MAX_CALLS_LIMIT = 40
export const AGENT_LLM_OUTPUT_TOKENS = 1024
export const AGENT_LLM_MAX_INPUT_CHARS = 64_000
export const AGENT_LLM_CANCEL_TIMEOUT_MS = 2_000

export interface AgentLlmMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
}

export interface AgentLlmProviderResult {
  text: string
  usage: { inputTokens: number; outputTokens: number; costMicros: number }
}

export interface AgentLlmProvider {
  submit(
    model: CatalogModel,
    messages: AgentLlmMessage[],
    maxTokens: number,
    onEnqueued: (requestId: string, endpoint: string) => Promise<void>,
  ): Promise<AgentLlmProviderResult>
  resume(model: CatalogModel, requestId: string): Promise<AgentLlmProviderResult>
  cancel(model: CatalogModel, requestId: string): Promise<void>
}

export interface AgentLlmCatalogSource {
  models(): CatalogModel[]
  defaultModelId(slot: 'assistant'): string | null
  view(): { revision: number }
}

export interface AgentLlmBrokerOptions {
  journal: AgentTaskJournal
  catalog: AgentLlmCatalogSource
  provider?: AgentLlmProvider
  generationGate?: GenerationGate
  connectionReady?: () => boolean
  /** CANAI_MOCK is a fail-closed mode for paid Agent LLM calls. */
  mockMode?: boolean
  /** Best-effort cancellation must not hold lifecycle control forever. */
  cancelTimeoutMs?: number
  now?: () => number
}

const defaultProvider: AgentLlmProvider = {
  async submit(model, messages, maxTokens, onEnqueued): Promise<AgentLlmProviderResult> {
    const result = await generateTextForAgent(resolveCatalogPreset(model), messages, maxTokens, onEnqueued)
    return normalizeProviderResult(result)
  },
  async resume(model, requestId): Promise<AgentLlmProviderResult> {
    const result = await resumeTextForAgent(resolveCatalogPreset(model), requestId)
    return normalizeProviderResult(result)
  },
  async cancel(model, requestId): Promise<void> {
    await cancelFalRequest(model.endpoint, requestId)
  },
}

function normalizeProviderResult(result: FalTextResult): AgentLlmProviderResult {
  const cost = result.usage.costUsd
  if (!Number.isFinite(cost) || cost < 0 || cost * 1_000_000 > Number.MAX_SAFE_INTEGER) {
    throw new AgentToolError('LLM_COST_INVALID', 'fal returned an invalid LLM cost')
  }
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costMicros: Math.ceil(cost * 1_000_000),
    },
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function validPricing(value: TextTokenPricing | undefined): value is TextTokenPricing {
  return Boolean(value
    && Number.isFinite(value.inputPerMillion) && value.inputPerMillion >= 0
    && Number.isFinite(value.outputPerMillion) && value.outputPerMillion > 0
    && typeof value.checkedAt === 'string' && value.checkedAt.trim())
}

function modelError(message: string, code = 'LLM_MODEL_UNSUPPORTED'): AgentToolError {
  return new AgentToolError(code, message)
}

function validateModel(model: CatalogModel | undefined): CatalogModel {
  if (!model || model.kind !== 'text' || model.lifecycle !== 'active') throw modelError('Active assistant text model is unavailable')
  if (model.endpoint !== 'openrouter/router') throw modelError('Agent Host allows only a catalog OpenRouter text endpoint')
  if (!validPricing(model.textPricing)) throw modelError('Model has no verified token pricing')
  if (model.defaults?.reasoning === true) throw modelError('Model requires reasoning, which is disabled for Agent Host')
  if (!Number.isSafeInteger(model.contextWindowTokens) || (model.contextWindowTokens ?? 0) <= AGENT_LLM_OUTPUT_TOKENS) {
    throw modelError('Model has no valid context window')
  }
  return model
}

function modelFromCatalog(catalog: AgentLlmCatalogSource, modelId: string): CatalogModel {
  return validateModel(catalog.models().find((candidate) => candidate.id === modelId))
}

function samePricing(left: TextTokenPricing, right: TextTokenPricing): boolean {
  return left.inputPerMillion === right.inputPerMillion
    && left.outputPerMillion === right.outputPerMillion
    && left.checkedAt === right.checkedAt
}

function statusFor(budget: AgentLlmBudgetView, operations: AgentLlmOperation[] = []): AgentLlmBudgetView['status'] {
  // A provider request with an unknown outcome is not a refund.  Keep its
  // reservation and block admission until a durable result is reconciled.
  if (operations.some((operation) => operation.status === 'uncertain' || (operation.status === 'cancelled' && operation.reservedMicros > 0))) return 'blocked'
  if (budget.overshootMicros > 0) return 'overspent'
  if (budget.calls >= budget.maxCalls || budget.chargedMicros + budget.reservedMicros >= budget.maxCostMicros) return 'exhausted'
  return 'active'
}

function estimateMicros(pricing: TextTokenPricing, inputTokens: number): number {
  const estimate = Math.ceil(inputTokens * pricing.inputPerMillion) + Math.ceil(AGENT_LLM_OUTPUT_TOKENS * pricing.outputPerMillion)
  if (!Number.isSafeInteger(estimate) || estimate < 1) throw new AgentToolError('BUDGET_INVALID', 'Could not calculate a positive cost estimate for the model')
  return estimate
}

function operationOf(task: AgentTaskRecord, operationId: string): AgentLlmOperation | undefined {
  return task.llmOperations?.find((operation) => operation.operationId === operationId)
}

type BudgetWithModelSnapshot = AgentLlmBudgetView & { modelSnapshot?: CatalogModel }

function budgetModelSnapshot(budget: AgentLlmBudgetView): CatalogModel | undefined {
  return (budget as BudgetWithModelSnapshot).modelSnapshot
}

function messageInput(value: unknown): AgentLlmMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new AgentToolError('INPUT_INVALID', 'llm.request.messages has an invalid size')
  let total = 0
  const messages = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AgentToolError('INPUT_INVALID', 'llm.request.messages contains an invalid item')
    const row = item as Record<string, unknown>
    if (row.role !== 'system' && row.role !== 'user' && row.role !== 'assistant') throw new AgentToolError('INPUT_INVALID', 'llm.request.messages.role is not supported')
    if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16_000) throw new AgentToolError('INPUT_INVALID', 'llm.request.messages.text has an invalid size')
    total += row.text.length
    return { role: row.role, text: row.text } as AgentLlmMessage
  })
  if (total > AGENT_LLM_MAX_INPUT_CHARS) throw new AgentToolError('INPUT_INVALID', 'LLM text input is too large')
  return messages
}

function providerError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AgentToolError) return { code: error.code, message: error.message, retryable: error.retryable }
  return { code: 'LLM_OUTCOME_UNCERTAIN', message: 'fal did not confirm the external operation outcome; resubmission is forbidden', retryable: true }
}

export class AgentLlmBroker {
  private readonly provider: AgentLlmProvider
  private readonly gate: GenerationGate
  private readonly now: () => number
  private readonly connectionReady: () => boolean
  private readonly mockMode: boolean
  private readonly cancelTimeoutMs: number
  /** Serializes paid requests for one task without nesting journal.withTaskLock. */
  private readonly taskOperationLocks = new Map<string, Promise<void>>()

  constructor(private readonly options: AgentLlmBrokerOptions) {
    this.provider = options.provider ?? defaultProvider
    this.gate = options.generationGate ?? generationGate
    this.now = options.now ?? Date.now
    this.connectionReady = options.connectionReady ?? (() => false)
    this.mockMode = options.mockMode ?? false
    this.cancelTimeoutMs = Number.isSafeInteger(options.cancelTimeoutMs) && (options.cancelTimeoutMs ?? 0) > 0
      ? options.cancelTimeoutMs!
      : AGENT_LLM_CANCEL_TIMEOUT_MS
  }

  connectionStatus(): 'ready' | 'unavailable' { return !this.mockMode && this.connectionReady() ? 'ready' : 'unavailable' }

  catalogView(): AgentLlmCatalogView {
    const models = this.options.catalog.models().filter((model) => model.kind === 'text').map((model) => ({
      id: model.id,
      name: model.name,
      active: model.lifecycle === 'active',
      ...(model.textPricing ? { textPricing: { inputPerMillion: model.textPricing.inputPerMillion, outputPerMillion: model.textPricing.outputPerMillion, checkedAt: model.textPricing.checkedAt } } : {}),
      ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    }))
    return {
      revision: this.options.catalog.view().revision,
      connection: { id: AGENT_LLM_CONNECTION, kind: 'llm', status: this.connectionStatus() },
      defaultModelId: this.options.catalog.defaultModelId('assistant'),
      models,
    }
  }

  prepareTask(taskId: string, projectSource: 'local' | 'cloud', permissions: string[], authorization?: AgentLlmAuthorization): AgentLlmBudgetView | undefined {
    const requested = permissions.includes('llm.request')
    if (!requested) {
      if (authorization) throw new AgentToolError('PERMISSION_DENIED', 'LLM authorization does not belong to a package without llm.request')
      return undefined
    }
    if (projectSource !== 'local') throw new AgentToolError('LLM_LOCAL_ONLY', 'llm.request is available only to the local project', false)
    if (!authorization || authorization.connectionId !== AGENT_LLM_CONNECTION || authorization.textTransferConsent !== true) throw new AgentToolError('LLM_AUTH_REQUIRED', 'Explicit approval is required to send text to local fal.ai')
    if (!Number.isSafeInteger(authorization.maxCostMicros) || authorization.maxCostMicros < 1 || authorization.maxCostMicros > 1_000_000_000_000) throw new AgentToolError('BUDGET_INVALID', 'LLM limit must be a positive integer in USD micros')
    if (typeof authorization.expectedModelId !== 'string' || !authorization.expectedModelId.trim() || !Number.isSafeInteger(authorization.expectedCatalogRevision)) {
      throw new AgentToolError('LLM_AUTH_REQUIRED', 'An approved assistant model and catalog revision are required before running')
    }
    if (this.mockMode || !this.connectionReady()) throw new AgentToolError('LLM_CONNECTION_UNAVAILABLE', 'Local fal.ai connection is unavailable')
    const modelId = this.options.catalog.defaultModelId('assistant')
    if (!modelId) throw modelError('The catalog has no default assistant model')
    const model = modelFromCatalog(this.options.catalog, modelId)
    const catalogRevision = this.options.catalog.view().revision
    if (authorization.expectedModelId !== model.id) throw modelError('Selected assistant model is stale; refresh the catalog', 'LLM_MODEL_PIN_MISMATCH')
    if (authorization.expectedCatalogRevision !== catalogRevision) {
      throw modelError('Assistant model catalog is stale; refresh the model list', 'LLM_CATALOG_STALE')
    }
    const maxCalls = authorization.maxCalls !== undefined ? authorization.maxCalls : AGENT_LLM_MAX_CALLS
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > AGENT_LLM_MAX_CALLS_LIMIT) {
      throw new AgentToolError('BUDGET_INVALID', `LLM call limit must be an integer from 1 to ${AGENT_LLM_MAX_CALLS_LIMIT}`)
    }
    const pricing = model.textPricing!
    const budget: BudgetWithModelSnapshot = {
      grantId: stableScopedId('grant', taskId, AGENT_LLM_CONNECTION),
      connectionId: AGENT_LLM_CONNECTION,
      currency: 'USD',
      maxCostMicros: authorization.maxCostMicros,
      reservedMicros: 0,
      chargedMicros: 0,
      overshootMicros: 0,
      calls: 0,
      maxCalls,
      status: 'active',
      modelId: model.id,
      catalogRevision,
      pricing: { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion, checkedAt: pricing.checkedAt },
      modelSnapshot: structuredClone(model),
    }
    return budget
  }

  startAccess(task: AgentTaskRecord): { connections: AgentConnection[]; grants: AgentGrant[] } {
    if (!task.llmBudget) return { connections: [], grants: [] }
    return {
      connections: [{ id: AGENT_LLM_CONNECTION, kind: 'llm', status: this.connectionStatus() }],
      grants: [{ id: task.llmBudget.grantId, tools: ['llm.request'], connectionId: AGENT_LLM_CONNECTION, artifactRefs: [], maxCalls: task.llmBudget.maxCalls, maxCost: { currency: 'USD', amountMicros: task.llmBudget.maxCostMicros }, status: task.llmBudget.status === 'active' ? 'active' : 'exhausted' }],
    }
  }

  async execute(task: AgentTaskRecord, rawArguments: unknown, operationId: string): Promise<ToolResult> {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(operationId)) {
      throw new AgentToolError('INPUT_INVALID', 'LLM operationId has an invalid format')
    }
    return this.withTaskOperationLock(task.taskId, async () => {
      const current = await this.options.journal.get(task.taskId)
      if (!current) throw new AgentToolError('TASK_NOT_FOUND', 'Agent task not found')
      return this.executeUnlocked(current, rawArguments, operationId)
    })
  }

  private async executeUnlocked(task: AgentTaskRecord, rawArguments: unknown, operationId: string): Promise<ToolResult> {
    if (task.projectRef.source !== 'local') throw new AgentToolError('LLM_LOCAL_ONLY', 'llm.request cannot pay for a Cloud task with a local key')
    const budget = task.llmBudget
    if (!budget) throw new AgentToolError('LLM_AUTH_REQUIRED', 'Task has no approved LLM grant')
    const spend = task.spendBudget
    if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) throw new AgentToolError('INPUT_INVALID', 'llm.request.arguments must be an object')
    const args = rawArguments as Record<string, unknown>
    const allowed = new Set(['connectionId', 'grantId', 'messages', 'refs', 'modelId'])
    if (Object.keys(args).some((key) => !allowed.has(key))) throw new AgentToolError('INPUT_INVALID', 'llm.request contains an unsupported field')
    if (args.connectionId !== AGENT_LLM_CONNECTION || args.grantId !== (spend?.grantId ?? budget.grantId)) throw new AgentToolError('GRANT_REQUIRED', 'LLM connection or grant does not belong to this task')
    if (args.modelId !== undefined && args.modelId !== budget.modelId) throw modelError('Attempt to change the pinned assistant model', 'LLM_MODEL_PIN_MISMATCH')
    if (!Array.isArray(args.refs) || args.refs.length !== 0) throw new AgentToolError('INPUT_INVALID', 'llm.request v1 accepts only text and refs=[]')
    const messages = messageInput(args.messages)
    const argumentsHash = digest({ tool: 'llm.request', arguments: args })
    const previous = operationOf(task, operationId)
    if (previous) {
      if (previous.argumentsHash !== argumentsHash) throw new AgentToolError('OPERATION_CONFLICT', 'operationId was already used with different LLM arguments')
      if (previous.status === 'succeeded' && previous.result) return { result: structuredClone(previous.result) }
      if (previous.status === 'failed') throw new AgentToolError(previous.error?.code ?? 'LLM_FAILED', previous.error?.message ?? 'LLM operation already failed')
      if (!previous.providerRequestId) {
        await this.markUncertain(task.taskId, operationId)
        throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM operation has no saved provider request ID; resubmission is forbidden', true)
      }
      return this.resume(task.taskId, previous, this.modelForOperation(budget, previous))
    }
    if (task.state !== 'running') throw new AgentToolError('TASK_NOT_RUNNING', 'New LLM actions are forbidden in the current task state')
    const model = this.pinnedCurrentModel(budget)
    const inputTokens = Math.ceil((messages.reduce((sum, message) => sum + message.text.length, 0) + messages.length * 8) / 4)
    if (inputTokens + AGENT_LLM_OUTPUT_TOKENS > (model.contextWindowTokens ?? 0)) throw new AgentToolError('INPUT_INVALID', 'LLM input exceeds the pinned context window')
    const reserved = estimateMicros(model.textPricing!, inputTokens)
    const reservation = await this.reserve(task, operationId, argumentsHash, model, reserved)
    const operation = reservation.operation
    if (!reservation.created) {
      if (operation.status === 'succeeded' && operation.result) return { result: structuredClone(operation.result) }
      if (operation.status === 'failed' || operation.status === 'cancelled') throw new AgentToolError(operation.error?.code ?? 'LLM_FAILED', operation.error?.message ?? 'LLM operation already failed')
      if (!operation.providerRequestId) {
        await this.markUncertain(task.taskId, operationId)
        throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM operation already started without a saved provider request ID; resubmission is forbidden', true)
      }
      return this.resume(task.taskId, operation, this.modelForOperation(budget, operation))
    }
    return this.submit(task.taskId, operation, model, messages)
  }

  async cancelTask(task: AgentTaskRecord): Promise<void> {
    const current = await this.options.journal.get(task.taskId)
    const operations = current?.llmOperations ?? task.llmOperations ?? []
    for (const operation of operations) {
      if (!['reserved', 'submitted', 'uncertain'].includes(operation.status)) continue
      const fresh = await this.options.journal.get(task.taskId)
      const latest = fresh?.llmOperations?.find((item) => item.operationId === operation.operationId)
      if (!latest || !fresh?.llmBudget || !['reserved', 'submitted', 'uncertain'].includes(latest.status)) continue
      if (!latest.providerRequestId) {
        // An intent without a durable provider ID is ambiguous: the journal
        // may have failed after fal accepted the request.  Hold the money and
        // forbid a second submit; only a known gate rejection releases it.
        await this.markUncertain(task.taskId, latest.operationId)
        continue
      }
      let model: CatalogModel
      try { model = this.modelForOperation(fresh.llmBudget, latest) }
      catch { await this.markUncertain(task.taskId, latest.operationId); continue }
      try {
        // Cancellation is best-effort and deliberately does not wait for the
        // broker's paid request lock.  fal may ACK queue cancellation while a
        // result is already in flight; reconcile then charges that result once.
        await this.cancelProvider(model, latest.providerRequestId)
        await this.options.journal.mutate(task.taskId, (entry) => {
          const currentOperation = entry.llmOperations?.find((item) => item.operationId === latest.operationId)
          if (!currentOperation || !entry.llmBudget || !['submitted', 'uncertain'].includes(currentOperation.status)) return
          currentOperation.status = 'cancelled'
          currentOperation.error = { code: 'LLM_CANCELLED', message: 'Provider confirmed cancellation, but refund was not confirmed', retryable: true }
          currentOperation.updatedAt = this.now()
          // Cancel ACK is not a refund proof. Keep the reservation and block
          // new paid work until the financial outcome is known.
          if (entry.spendBudget) {
            entry.spendBudget.status = 'blocked'
            syncSpendBudget(entry)
          } else {
            entry.llmBudget.status = 'blocked'
          }
        }, { type: 'llm.cancelled', payload: { operationId: latest.operationId } })
      } catch {
        await this.markUncertain(task.taskId, latest.operationId)
      }
    }
  }

  /** Resume only already-submitted journal entries; never consult current catalog admission. */
  async recoverPersisted(task: AgentTaskRecord): Promise<void> {
    const current = await this.options.journal.get(task.taskId)
    if (!current || current.projectRef.source !== 'local') return
    for (const operation of current.llmOperations ?? []) {
      if (!['reserved', 'submitted', 'uncertain', 'cancelled'].includes(operation.status)) continue
      await this.withTaskOperationLock(task.taskId, async () => {
        const fresh = await this.options.journal.get(task.taskId)
        const latest = fresh?.llmOperations?.find((candidate) => candidate.operationId === operation.operationId)
        if (!fresh || !fresh.llmBudget || !latest || latest.status === 'succeeded' || latest.status === 'failed') return
        if (!latest.providerRequestId) {
          await this.markUncertain(task.taskId, latest.operationId)
          return
        }
        if (this.mockMode) return
        if (!latest.modelSnapshot) {
          await this.markUncertain(task.taskId, latest.operationId)
          return
        }
        const model = this.modelForOperation(fresh.llmBudget, latest)
        await this.resume(task.taskId, latest, model)
      })
    }
  }

  private pinnedCurrentModel(budget: AgentLlmBudgetView): CatalogModel {
    const snapshot = budgetModelSnapshot(budget)
    const model = modelFromCatalog(this.options.catalog, budget.modelId)
    if (!samePricing(model.textPricing!, budget.pricing)) throw modelError('Pinned assistant model pricing changed', 'LLM_MODEL_PIN_MISMATCH')
    if (snapshot) {
      if (snapshot.id !== model.id || snapshot.endpoint !== model.endpoint || snapshot.defaults?.model !== model.defaults?.model) {
        throw modelError('Pinned assistant model parameters changed', 'LLM_MODEL_PIN_MISMATCH')
      }
    }
    return model
  }

  private async cancelProvider(model: CatalogModel, providerRequestId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancellation = Promise.resolve().then(() => this.provider.cancel(model, providerRequestId))
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new AgentToolError('LLM_CANCEL_TIMEOUT', 'LLM cancellation confirmation did not arrive in time', true)), this.cancelTimeoutMs)
      cancellation.then(resolve, reject)
    }).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  private modelForOperation(budget: AgentLlmBudgetView, operation: AgentLlmOperation): CatalogModel {
    if (!operation.modelSnapshot) return this.pinnedCurrentModel(budget)
    if (operation.modelSnapshot.id !== budget.modelId || !validPricing(operation.modelSnapshot.textPricing) || !samePricing(operation.modelSnapshot.textPricing, budget.pricing)) {
      throw modelError('Pinned assistant model parameters changed', 'LLM_MODEL_PIN_MISMATCH')
    }
    return validateModel(operation.modelSnapshot)
  }

  private async reserve(task: AgentTaskRecord, operationId: string, argumentsHash: string, model: CatalogModel, reservedMicros: number): Promise<{ operation: AgentLlmOperation; created: boolean }> {
    let result!: AgentLlmOperation
    let created = false
    await this.options.journal.mutate(task.taskId, (entry) => {
      const budget = entry.llmBudget
      const spend = entry.spendBudget
      if (!budget || budget.status !== 'active' || budget.calls >= budget.maxCalls) throw new AgentToolError('BUDGET_EXCEEDED', 'LLM budget no longer allows new calls')
      if (spend && (spend.status !== 'active' || spend.calls >= spend.maxCalls)) throw new AgentToolError('BUDGET_EXCEEDED', 'Shared task budget no longer allows new calls')
      const existing = operationOf(entry, operationId)
      if (existing) {
        if (existing.argumentsHash !== argumentsHash) throw new AgentToolError('OPERATION_CONFLICT', 'operationId was already used with different LLM arguments')
        result = structuredClone(existing); return
      }
      // The preflight estimate must fit the user-approved ceiling.  Only the
      // provider's final actual charge may overshoot that estimate on the last
      // admitted call; never reserve an estimate above the approval itself.
      const ledger = spend ?? budget
      if (ledger.chargedMicros + ledger.reservedMicros + reservedMicros > ledger.maxCostMicros) throw new AgentToolError('BUDGET_EXCEEDED', 'LLM cost estimate exceeds the remaining limit')
      const now = this.now()
      result = {
        operationId,
        requestId: stableScopedId('llm', entry.taskId, operationId),
        argumentsHash,
        receiptId: stableScopedId('receipt', entry.taskId, operationId),
        status: 'reserved',
        modelId: model.id,
        catalogRevision: budget.catalogRevision,
        modelSnapshot: structuredClone(model),
        reservedMicros,
        createdAt: now,
        updatedAt: now,
      }
      entry.llmOperations ??= []
      entry.llmOperations.push(result)
      ledger.reservedMicros += reservedMicros
      budget.calls += 1
      created = true
      if (spend) {
        spend.calls += 1
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.llmOperations)
      }
    }, { type: 'llm.reserved', payload: { operationId, amountMicros: reservedMicros } })
    return { operation: result, created }
  }

  private async submit(taskId: string, operation: AgentLlmOperation, model: CatalogModel, messages: AgentLlmMessage[]): Promise<ToolResult> {
    let lease = this.gate.tryEnter()
    let gateRejected = false
    const release = () => {
      if (!lease) return
      lease.release()
      lease = null
    }
    try {
      if (!lease) {
        gateRejected = true
        await this.markFailure(taskId, operation.operationId, { code: 'GENERATION_SHUTTING_DOWN', message: 'CanAI is shutting down; LLM submit deferred', retryable: true }, false, true)
        throw new AgentToolError('GENERATION_SHUTTING_DOWN', 'CanAI is shutting down; LLM submit deferred', true)
      }
      const current = await this.options.journal.get(taskId)
      if (!current || current.state !== 'running') {
        gateRejected = true
        await this.markFailure(taskId, operation.operationId, { code: 'TASK_NOT_RUNNING', message: 'New LLM actions are forbidden in the current task state', retryable: true }, false, true)
        throw new AgentToolError('TASK_NOT_RUNNING', 'New LLM actions are forbidden in the current task state', true)
      }
      const currentOperation = current.llmOperations?.find((item) => item.operationId === operation.operationId)
      if (!currentOperation || currentOperation.status === 'uncertain' || currentOperation.status === 'cancelled') {
        await this.markFailure(taskId, operation.operationId, { code: 'LLM_OUTCOME_UNCERTAIN', message: 'LLM operation already stopped; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM operation already stopped; resubmission is forbidden', true)
      }
      let enqueued = false
      const result = await this.provider.submit(model, messages, AGENT_LLM_OUTPUT_TOKENS, async (providerRequestId, endpoint) => {
        if (typeof providerRequestId !== 'string' || !/^[^\s]{1,300}$/u.test(providerRequestId)) throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'Provider did not return a valid request ID', true)
        await this.options.journal.mutate(taskId, (entry) => {
          const current = entry.llmOperations?.find((item) => item.operationId === operation.operationId)
          if (!current) throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM operation disappeared before the provider request ID was saved', true)
          current.status = 'submitted'; current.providerRequestId = providerRequestId; current.providerEndpoint = endpoint; current.updatedAt = this.now()
        }, { type: 'llm.submitted', payload: { operationId: operation.operationId } })
        enqueued = true
        // The provider ID is durable before the lease is released.  A crash
        // after this point can only resume the same request, never submit a
        // second paid request.
        release()
      })
      release()
      if (!enqueued) {
        await this.markFailure(taskId, operation.operationId, { code: 'LLM_OUTCOME_UNCERTAIN', message: 'Provider did not confirm the durable request ID; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'Provider did not confirm the durable request ID; resubmission is forbidden', true)
      }
      return this.reconcile(taskId, operation.operationId, result)
    } catch (error) {
      release()
      try { await this.markFailure(taskId, operation.operationId, providerError(error), !gateRejected, gateRejected) } catch { /* journal failure keeps the prior intent; retry must reconcile, never submit */ }
      throw error instanceof AgentToolError ? error : new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'fal did not confirm the LLM operation outcome; resubmission is forbidden', true)
    }
  }

  private async resume(taskId: string, operation: AgentLlmOperation, model: CatalogModel): Promise<ToolResult> {
    try {
      const result = await this.provider.resume(model, operation.providerRequestId!)
      return this.reconcile(taskId, operation.operationId, result)
    } catch (error) {
      try { await this.markFailure(taskId, operation.operationId, providerError(error), true) } catch { /* preserve uncertain intent when the journal is unavailable */ }
      throw error instanceof AgentToolError ? error : new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'fal did not confirm the saved LLM operation outcome; resubmission is forbidden', true)
    }
  }

  private async reconcile(taskId: string, operationId: string, result: AgentLlmProviderResult): Promise<ToolResult> {
    if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 16_000
      || !Number.isSafeInteger(result.usage.inputTokens) || result.usage.inputTokens < 0
      || !Number.isSafeInteger(result.usage.outputTokens) || result.usage.outputTokens < 0
      || !Number.isSafeInteger(result.usage.costMicros) || result.usage.costMicros < 0) {
      // A provider response without a mandatory actual cost is financially
      // ambiguous.  Hold the reservation and require resume/reconciliation;
      // releasing it would allow a second paid request to compound the loss.
      try { await this.markFailure(taskId, operationId, { code: 'LLM_COST_INVALID', message: 'LLM result does not contain valid text/usage.cost', retryable: true }, true) } catch { /* no receipt is safer than financial success when the journal is unavailable */ }
      throw new AgentToolError('LLM_COST_INVALID', 'LLM result does not contain valid text/usage.cost', true)
    }
    const resultPayload: Record<string, unknown> = {
      text: result.text.trim(),
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      charged: { currency: 'USD', amountMicros: result.usage.costMicros },
    }
    const updated = await this.options.journal.mutate(taskId, (entry) => {
      const operation = entry.llmOperations?.find((item) => item.operationId === operationId)
      const budget = entry.llmBudget
      if (!operation || !budget) throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM ledger is missing during reconciliation', true)
      if (operation.status === 'succeeded' && operation.result) return
      // A late result after a cancel ACK is still a real provider result.  It
      // settles the held reservation exactly once; cancellation never refunds
      // by itself.
      operation.status = 'succeeded'; operation.result = structuredClone(resultPayload); delete operation.error; operation.updatedAt = this.now()
      const spend = entry.spendBudget
      const ledger = spend ?? budget
      ledger.reservedMicros = Math.max(0, ledger.reservedMicros - operation.reservedMicros)
      ledger.chargedMicros += result.usage.costMicros
      ledger.overshootMicros = Math.max(0, ledger.chargedMicros - ledger.maxCostMicros)
      if (spend) {
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.llmOperations)
      }
    }, { type: 'llm.succeeded', payload: { operationId, chargedMicros: result.usage.costMicros } })
    const saved = operationOf(updated, operationId)
    if (!saved?.result) throw new AgentToolError('LLM_OUTCOME_UNCERTAIN', 'LLM receipt was not saved', true)
    return { result: structuredClone(saved.result) }
  }

  private async markUncertain(taskId: string, operationId: string): Promise<void> {
    await this.markFailure(taskId, operationId, { code: 'LLM_OUTCOME_UNCERTAIN', message: 'LLM operation outcome is unknown; resubmission is forbidden', retryable: true }, true)
  }

  private async markFailure(taskId: string, operationId: string, error: { code: string; message: string; retryable: boolean }, holdReservation: boolean, refundUnsubmittedCall = false): Promise<void> {
    await this.options.journal.mutate(taskId, (entry) => {
      const operation = entry.llmOperations?.find((item) => item.operationId === operationId)
      const budget = entry.llmBudget
      if (!operation || !budget || operation.status === 'succeeded') return
      const canRefundCall = refundUnsubmittedCall && operation.status === 'reserved' && !operation.providerRequestId
      operation.status = holdReservation ? 'uncertain' : 'failed'; operation.error = error; operation.updatedAt = this.now()
      const spend = entry.spendBudget
      const ledger = spend ?? budget
      if (!holdReservation) {
        ledger.reservedMicros = Math.max(0, ledger.reservedMicros - operation.reservedMicros)
        operation.reservedMicros = 0
        if (canRefundCall) {
          budget.calls = Math.max(0, budget.calls - 1)
          if (spend) spend.calls = Math.max(0, spend.calls - 1)
        }
      }
      if (spend) {
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.llmOperations)
      }
    }, { type: holdReservation ? 'llm.uncertain' : 'llm.failed', payload: { operationId, code: error.code } })
  }

  private async withTaskOperationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskOperationLocks.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.taskOperationLocks.set(taskId, chain)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.taskOperationLocks.get(taskId) === chain) this.taskOperationLocks.delete(taskId)
    }
  }
}
