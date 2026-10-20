import crypto from 'node:crypto'
import type {
  AgentCheckpointPayload,
  AgentDecisionPayload,
  AgentEnvelope,
  AgentMessageType,
  AgentReviewPayload,
  AgentStartPayload,
  AgentTaskState,
  AgentTool,
} from '../../../packages/agent-protocol/index.js'
import { AGENT_MAX_MESSAGE_BYTES } from '../../../packages/agent-protocol/index.js'
import { AgentTaskJournal } from './journal.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolBroker } from './tools.js'
import { AgentProtocolError, AgentProtocolValidator } from './validation.js'
import { ManagedProcess } from './host-process.js'
import { AgentHostError, TERMINAL, checkIdentifier, clone, errorPayload, hash, outcomeState } from './host-shared.js'
import { assertFinishedState, assertProgressState, assertToolState } from './host-state.js'
import { sameRefs } from './generation-broker-helpers.js'

export interface HostProtocolContext {
  readonly journal: AgentTaskJournal
  readonly validator: AgentProtocolValidator
  readonly broker: AgentToolBroker
  now(): number
  require(taskId: string): Promise<AgentTaskRecord>
  assertPermission(task: AgentTaskRecord, permission: string): void
  sendOrQueue(taskId: string, message: AgentEnvelope): void
  makeHostEnvelope(task: AgentTaskRecord, type: AgentMessageType, payload: Record<string, unknown>): AgentEnvelope
  writeEnvelope(managed: ManagedProcess, message: AgentEnvelope): void
  writeHostAck(managed: ManagedProcess, acceptedMessageId: string, eventCursor: number): void
  writeToolResult(managed: ManagedProcess, request: AgentEnvelope, receipt: AgentTaskRecord['receipts'][number]): void
  wireReceipt(receipt: AgentTaskRecord['receipts'][number]): Record<string, unknown>
  startPayload(task: AgentTaskRecord): AgentStartPayload
  brokerTask(task: AgentTaskRecord): AgentTaskRecord
  verifyCheckpoint(task: AgentTaskRecord, checkpoint: AgentCheckpointPayload): Promise<void>
  failTask(taskId: string, error: { code: string; message: string; retryable: boolean }): Promise<void>
}

interface PendingToolRequest {
  managed: ManagedProcess
  request: AgentEnvelope
}

function assertGenerationSpecEcho(spec: AgentReviewPayload['generationSpec']): void {
  // Missing legacy echoes are retained for journal readability; the broker
  // refuses to use such a review for a new paid generation request.
  if (!spec) return
  if (spec.prompt !== undefined && (typeof spec.prompt !== 'string' || hash(spec.prompt) !== spec.promptHash)) {
    throw new AgentProtocolError('PROTOCOL_INVALID', 'generationSpec.prompt does not match promptHash')
  }
  if (spec.params !== undefined && (!spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params) || hash(spec.params) !== spec.paramsHash)) {
    throw new AgentProtocolError('PROTOCOL_INVALID', 'generationSpec.params does not match paramsHash')
  }
  if (spec.estimateMicros !== undefined && (!Number.isSafeInteger(spec.estimateMicros) || spec.estimateMicros < 1)) {
    throw new AgentProtocolError('PROTOCOL_INVALID', 'generationSpec.estimateMicros has an invalid value')
  }
}

/** Validates and dispatches the NDJSON protocol; task lifecycle stays in AgentHost. */
export class AgentProtocolDispatcher {
  private readonly pendingTools = new Map<string, PendingToolRequest>()
  /**
   * The protocol callback must not hold AgentTaskJournal.withTaskLock while a
   * broker performs an external call: the broker itself needs durable journal
   * mutations for reservations and provider request IDs.  This lock keeps a
   * single operation idempotent without creating that nested-lock deadlock.
   */
  private readonly operationLocks = new Map<string, Promise<void>>()

  constructor(private readonly context: HostProtocolContext) {}

  /** Complete a pending canvas delivery after the browser saved its snapshot. */
  completePendingTool(taskId: string, operationId: string, receipt: AgentTaskRecord['receipts'][number]): void {
    const key = `${taskId}:${operationId}`
    const pending = this.pendingTools.get(key)
    if (!pending) return
    this.pendingTools.delete(key)
    this.context.writeToolResult(pending.managed, pending.request, receipt)
  }

  async handleLine(taskId: string, managed: ManagedProcess, line: string): Promise<void> {
    let value: unknown
    try { value = JSON.parse(line) } catch { return this.protocolFailure(taskId, managed, 'Invalid JSON from the agent') }
    let message: AgentEnvelope
    try {
      message = this.context.validator.assertEnvelope(value, 'agent-to-host')
      this.context.validator.assertTaskBinding(message, { taskId, executionId: managed.executionId })
    } catch (error) {
      return this.protocolFailure(taskId, managed, error instanceof Error ? error.message : String(error))
    }
    let task: AgentTaskRecord
    try { task = await this.context.require(taskId) } catch (error) {
      return this.protocolFailure(taskId, managed, error instanceof Error ? error.message : String(error))
    }
    const prior = task.currentMessageAcks[message.messageId]
    if (prior !== undefined) {
      this.context.writeHostAck(managed, message.messageId, prior)
      return
    }
    try {
      if (message.type === 'hello') { await this.onHello(task, managed, message); return }
      if (!managed.hello) throw new AgentProtocolError('PROTOCOL_INVALID', 'hello must be the first message')
      if (message.type === 'task.progress') { await this.onProgress(task, managed, message); return }
      if (message.type === 'task.checkpoint') { await this.onCheckpoint(task, managed, message); return }
      if (message.type === 'tool.request') { await this.onToolRequest(task, managed, message); return }
      if (message.type === 'review.request') { await this.onReviewRequest(task, managed, message); return }
      if (message.type === 'task.paused') { await this.onPaused(task, managed, message); return }
      if (message.type === 'task.finished') { await this.onFinished(task, managed, message); return }
      if (message.type === 'heartbeat') { await this.accept(task, message, 'agent.heartbeat', message.payload); this.context.writeHostAck(managed, message.messageId, (await this.context.require(taskId)).eventCursor); return }
    } catch (error) {
      const payload = errorPayload(error)
      const accepted = await this.accept(task, message, 'agent.error', { error: payload })
      this.context.writeHostAck(managed, message.messageId, accepted.eventCursor)
      this.context.sendOrQueue(taskId, this.context.makeHostEnvelope(task, 'protocol.error', { error: payload, fatal: false }))
    }
  }

  private async onHello(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    const payload = message.payload as Record<string, unknown>
    const versions = Array.isArray(payload.supportedProtocolVersions) ? payload.supportedProtocolVersions : []
    if (!versions.includes('1.0')) throw new AgentProtocolError('PROTOCOL_UNSUPPORTED', 'Agent does not support protocol 1.0')
    managed.hello = true
    const accepted = await this.accept(task, message, 'agent.hello', { capabilities: payload.capabilities ?? [] })
    this.context.writeHostAck(managed, message.messageId, accepted.eventCursor)
    const fresh = await this.context.require(task.taskId)
    const start = this.context.startPayload(fresh)
    if (fresh.checkpoint) {
      this.context.sendOrQueue(task.taskId, this.context.makeHostEnvelope(fresh, 'task.resume', {
        start,
        checkpoint: fresh.checkpoint,
        decisions: fresh.decisions,
        receipts: fresh.receipts.map((receipt) => this.context.wireReceipt(receipt)),
        eventCursor: fresh.eventCursor,
      }))
    } else {
      this.context.sendOrQueue(task.taskId, this.context.makeHostEnvelope(fresh, 'task.start', start as unknown as Record<string, unknown>))
    }
    for (const pending of managed.pending.splice(0)) this.context.writeEnvelope(managed, pending)
  }

  private async onProgress(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    await this.context.journal.withTaskLock(task.taskId, async () => {
      const current = await this.context.require(task.taskId)
      const payload = message.payload as Record<string, unknown>
      this.context.validator.assertProgress(payload)
      const state = (payload.status === 'awaiting_review'
        ? 'awaiting_review'
        : payload.status === 'awaiting_input'
          ? 'awaiting_input'
          : payload.status === 'awaiting_connection' ? 'awaiting_connection' : 'running') as AgentTaskState
      assertProgressState(current, state)
      const updated = await this.accept(current, message, 'agent.progress', { ...payload, state }, (entry) => {
        assertProgressState(entry, state)
        entry.progress = {
          stageId: String(payload.stageId),
          label: String(payload.label),
          status: String(payload.status),
          ...(payload.completed !== undefined ? { completed: Number(payload.completed) } : {}),
          ...(payload.total !== undefined ? { total: Number(payload.total) } : {}),
        }
        entry.state = state
      })
      this.context.writeHostAck(managed, message.messageId, updated.eventCursor)
    })
  }

  private async onCheckpoint(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    const payload = message.payload as Record<string, unknown>
    this.context.validator.assertCheckpointFiles(payload)
    const checkpoint = payload as unknown as AgentCheckpointPayload
    await this.context.verifyCheckpoint(task, checkpoint)
    const file = await this.context.journal.writeCheckpoint(task, checkpoint, (value) => this.context.verifyCheckpoint(task, value))
    const updated = await this.accept(task, message, 'agent.checkpoint', { checkpointId: checkpoint.checkpointId }, (entry) => {
      entry.checkpoint = clone(checkpoint)
      entry.checkpointFile = file
    })
    this.context.writeHostAck(managed, message.messageId, updated.eventCursor)
  }

  private async onToolRequest(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    const payload = message.payload as Record<string, unknown>
    const operationId = checkIdentifier(payload.operationId, 'operationId')
    return this.withOperationLock(`${task.taskId}:${operationId}`, () => this.executeToolRequest(task, managed, message, operationId))
  }

  private async executeToolRequest(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope, operationId: string): Promise<void> {
    const current = await this.context.require(task.taskId)
    const payload = message.payload as Record<string, unknown>
    const tool = payload.tool as AgentTool
    const args = payload.arguments
    this.context.assertPermission(current, tool)
    const argumentsHash = hash({ tool, arguments: args })
    const intent = current.operationIntents[operationId]
    const existing = [...current.receipts].reverse().find((receipt) => receipt.operationId === operationId)
    if (intent && (intent.argumentsHash !== argumentsHash || intent.tool !== tool)) throw new AgentHostError('OPERATION_CONFLICT', 'operationId was already used with different arguments', 409)
    if (existing && existing.status !== 'uncertain') {
      this.context.writeToolResult(managed, message, existing)
      if (existing.status === 'pending') this.pendingTools.set(`${task.taskId}:${operationId}`, { managed, request: message })
      const replayed = await this.accept(current, message, 'tool.replayed', { operationId, receiptId: existing.receiptId })
      this.context.writeHostAck(managed, message.messageId, replayed.eventCursor)
      return
    }
    // Replaying a durable receipt is side-effect free and remains valid after
    // a pause/review.  Only a fresh/uncertain operation needs the state gate.
    assertToolState(current, tool)
    if (!intent) await this.context.journal.mutate(task.taskId, (entry) => { entry.operationIntents[operationId] = { tool, argumentsHash, createdAt: this.context.now() } }, { type: 'tool.intent', payload: { operationId, tool } })
    const fresh = await this.context.require(task.taskId)
    let executed: Awaited<ReturnType<AgentToolBroker['execute']>>
    try {
      executed = await this.context.broker.execute(this.context.brokerTask(fresh), tool, args, operationId)
    } catch (error) {
      const failure = errorPayload(error)
      const uncertain = failure.code === 'CLOUD_OUTCOME_UNCERTAIN' || failure.code === 'LLM_OUTCOME_UNCERTAIN' || failure.code === 'LLM_COST_INVALID' || failure.code === 'GENERATION_OUTCOME_UNCERTAIN' || failure.code === 'GENERATION_COST_INVALID'
      const receipt = { operationId, tool, receiptId: `receipt-${crypto.randomUUID()}`, status: uncertain ? 'uncertain' as const : 'failed' as const, error: failure, argumentsHash, createdAt: this.context.now() }
      const updated = await this.context.journal.mutate(task.taskId, (entry) => { entry.receipts.push(receipt) }, { type: 'tool.result', payload: receipt as unknown as Record<string, unknown> })
      this.context.writeToolResult(managed, message, receipt)
      const accepted = await this.accept(updated, message, 'tool.failed', { operationId })
      this.context.writeHostAck(managed, message.messageId, accepted.eventCursor)
      return
    }
    if (executed.pending) {
      const pending = {
        operationId,
        tool,
        receiptId: `receipt-${crypto.randomUUID()}`,
        status: 'pending' as const,
        result: { waitId: executed.pending.waitId },
        argumentsHash,
        createdAt: this.context.now(),
      }
      const updated = await this.context.journal.mutate(task.taskId, (entry) => {
        entry.receipts.push(pending)
        if (tool === 'canvas.create_results' && Array.isArray(executed.result.items)) {
          const items = executed.result.items as Array<Record<string, unknown>>
          const workspaceId = typeof executed.result.workspaceId === 'string' ? executed.result.workspaceId : ''
          for (const item of items) {
            if (typeof item.slotId !== 'string' || typeof item.itemId !== 'string' || typeof item.artifactId !== 'string') continue
            entry.pendingCanvasItems.push({
              operationId,
              waitId: executed.pending!.waitId,
              workspaceId,
              slotId: item.slotId,
              itemId: item.itemId,
              revision: Number(item.revision),
              artifactId: item.artifactId,
            })
          }
        }
      }, { type: 'tool.pending', payload: pending as unknown as Record<string, unknown> })
      this.pendingTools.set(`${task.taskId}:${operationId}`, { managed, request: message })
      this.context.writeToolResult(managed, message, pending)
      const accepted = await this.accept(updated, message, 'tool.accepted', { operationId, receiptId: pending.receiptId, status: 'pending' })
      this.context.writeHostAck(managed, message.messageId, accepted.eventCursor)
      return
    }
    const result = executed.result
    const receipt = { operationId, tool, receiptId: `receipt-${crypto.randomUUID()}`, status: 'succeeded' as const, result, argumentsHash, createdAt: this.context.now() }
    const render = tool === 'media.render' ? executed.mediaRender : undefined
    // Монтаж идёт минуты, и задачу за это время могли снять. Состояние
    // сверяем в ТОЙ ЖЕ записи журнала, что и квитанцию: проверка снаружи
    // оставила бы окно, в которое отменённая задача получает новый артефакт.
    const late = {
      operationId, tool, receiptId: receipt.receiptId, status: 'failed' as const,
      error: { code: 'TASK_NOT_RUNNING', message: 'Render finished after the task stopped and was not accepted', retryable: false },
      argumentsHash, createdAt: receipt.createdAt,
    }
    let rejected = false
    const updated = await this.context.journal.mutate(task.taskId, (entry) => {
      if (render && (TERMINAL.has(entry.state) || entry.state === 'cancelling')) {
        rejected = true
        entry.receipts.push(late)
        return { event: { type: 'tool.result', payload: late as unknown as Record<string, unknown> } }
      }
      entry.receipts.push(receipt)
      if (tool === 'artifact.publish' && result.artifact && typeof result.artifact === 'object') entry.artifacts.push(clone(result.artifact) as AgentTaskRecord['artifacts'][number])
      if (render) {
        const artifact = clone(render.artifact)
        const ref = { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }
        // Повтор после сбоя записи приходит с тем же артефактом — второй раз
        // в список он не ложится.
        if (!entry.artifacts.some((candidate) => candidate.artifactId === ref.artifactId && candidate.revision === ref.revision && candidate.checksum === ref.checksum)) {
          entry.artifacts.push(artifact)
        }
        entry.mediaRenderOperations = (entry.mediaRenderOperations ?? []).filter((operation) => operation.operationId !== operationId)
        entry.mediaRenderOperations.push({
          operationId,
          receiptId: receipt.receiptId,
          argumentsHash,
          manifestHash: render.manifestHash,
          sourceRefs: clone(render.sourceRefs),
          artifact: ref,
          manifest: clone(render.manifest),
          createdAt: receipt.createdAt,
          updatedAt: receipt.createdAt,
        })
      }
      if (tool === 'canvas.create_results' && Array.isArray(result.items)) entry.canvasItems.push(...clone(result.items) as AgentTaskRecord['canvasItems'])
    }, { type: 'tool.result', payload: receipt as unknown as Record<string, unknown> })
    if (rejected && render) {
      // Без ссылки из журнала выпущенный файл — мусор в медиа.
      await render.discard().catch(() => undefined)
      this.context.writeToolResult(managed, message, late)
      const refused = await this.accept(updated, message, 'tool.failed', { operationId })
      this.context.writeHostAck(managed, message.messageId, refused.eventCursor)
      return
    }
    this.context.writeToolResult(managed, message, receipt)
    const accepted = await this.accept(updated, message, 'tool.accepted', { operationId, receiptId: receipt.receiptId })
    this.context.writeHostAck(managed, message.messageId, accepted.eventCursor)
  }

  private async withOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.operationLocks.set(key, chain)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.operationLocks.get(key) === chain) this.operationLocks.delete(key)
    }
  }

  private async onReviewRequest(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    await this.context.journal.withTaskLock(task.taskId, async () => {
      const current = await this.context.require(task.taskId)
      const payload = message.payload as unknown as AgentReviewPayload
      this.context.assertPermission(current, 'review.request')
      if (TERMINAL.has(current.state) || current.state === 'cancelling' || current.state === 'pausing' || current.state === 'paused') throw new AgentHostError('TASK_NOT_RUNNING', 'New approvals are forbidden in the current task state', 409)
      if (!Array.isArray(payload.decisions) || payload.decisions.length < 3) throw new AgentProtocolError('PROTOCOL_INVALID', 'review.decisions must contain 3 decisions')
      if (Boolean(current.generationBudget?.pins?.length) && payload.generationSpec) {
        const spec = payload.generationSpec
        if (
          typeof spec.prompt !== 'string' ||
          !spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params) ||
          typeof spec.estimateMicros !== 'number'
        ) {
          throw new AgentHostError('GENERATION_SPEC_INVALID', 'generationSpec is missing required prompt, params, or estimateMicros', 400)
        }
        let hostSpec
        try {
          hostSpec = this.context.broker.computeGenerationSpec(current, {
            kind: spec.kind,
            prompt: spec.prompt,
            params: spec.params,
            refs: spec.refs,
            modelId: spec.modelId,
          })
        } catch (error) {
          throw new AgentHostError('GENERATION_SPEC_INVALID', error instanceof Error ? error.message : 'generationSpec is invalid', 400)
        }
        if (
          spec.kind !== hostSpec.kind ||
          spec.modelId !== hostSpec.modelId ||
          spec.catalogRevision !== hostSpec.catalogRevision ||
          spec.promptHash !== hostSpec.promptHash ||
          spec.paramsHash !== hostSpec.paramsHash ||
          spec.estimateMicros !== hostSpec.estimateMicros ||
          !sameRefs(spec.refs ?? [], hostSpec.refs)
        ) {
          throw new AgentHostError('GENERATION_SPEC_INVALID', 'generationSpec does not match the Host calculation', 400)
        }
      } else {
        assertGenerationSpecEcho(payload.generationSpec)
      }
      const existing = current.reviews.find((review) => review.reviewId === payload.reviewId && review.revision === payload.revision)
      const updated = await this.accept(current, message, existing ? 'review.replayed' : 'review.request', { reviewId: payload.reviewId, revision: payload.revision }, (entry) => {
        if (existing) {
          if (entry.reviews.some((review) => review.reviewId === payload.reviewId && review.revision === payload.revision && review.status === 'pending')) entry.state = 'awaiting_review'
          return
        }
        if (TERMINAL.has(entry.state) || entry.state === 'cancelling' || entry.state === 'pausing' || entry.state === 'paused') throw new AgentHostError('TASK_NOT_RUNNING', 'New approvals are forbidden in the current task state', 409)
        for (const review of entry.reviews) if (review.status === 'pending') review.status = 'superseded'
        entry.reviews.push({ ...clone(payload), status: 'pending', createdAt: this.context.now() })
        entry.state = 'awaiting_review'
        entry.revision += 1
      })
      this.context.writeHostAck(managed, message.messageId, updated.eventCursor)
    })
  }

  private async onPaused(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    await this.context.journal.withTaskLock(task.taskId, async () => {
      const current = await this.context.require(task.taskId)
      const checkpointId = (message.payload as Record<string, unknown>).checkpointId
      if (TERMINAL.has(current.state) || current.state === 'cancelling') throw new AgentHostError('TASK_NOT_RUNNING', 'Pause received after the task finished or was cancelled', 409)
      if (typeof checkpointId !== 'string' || current.checkpoint?.checkpointId !== checkpointId) throw new AgentProtocolError('CHECKPOINT_INVALID', 'task.paused refers to an unapproved checkpoint')
      const updated = await this.accept(current, message, 'task.paused', { checkpointId }, (entry) => { if (TERMINAL.has(entry.state) || entry.state === 'cancelling') throw new AgentHostError('TASK_NOT_RUNNING', 'Pause received after the task finished or was cancelled', 409); entry.state = 'paused'; entry.revision += 1 })
      this.context.writeHostAck(managed, message.messageId, updated.eventCursor)
    })
  }

  private async onFinished(task: AgentTaskRecord, managed: ManagedProcess, message: AgentEnvelope): Promise<void> {
    await this.context.journal.withTaskLock(task.taskId, async () => {
      const current = await this.context.require(task.taskId)
      const payload = message.payload as Record<string, unknown>
      const outcome = payload.outcome
      if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') throw new AgentProtocolError('PROTOCOL_INVALID', 'Invalid task.finished outcome')
      assertFinishedState(current)
      if (outcome === 'succeeded' && current.pendingCanvasItems.length > 0) throw new AgentHostError('RESULT_NOT_DURABLE', 'Canvas result has not been confirmed by a saved board', 409)
      const updated = await this.accept(current, message, 'task.finished', payload, (entry) => {
        assertFinishedState(entry)
        if (outcome === 'succeeded' && entry.pendingCanvasItems.length > 0) throw new AgentHostError('RESULT_NOT_DURABLE', 'Canvas result has not been confirmed by a saved board', 409)
        entry.state = outcomeState(outcome)
        if (payload.error && typeof payload.error === 'object') entry.error = payload.error as AgentTaskRecord['error']
        entry.revision += 1
      })
      this.context.writeHostAck(managed, message.messageId, updated.eventCursor)
    })
  }

  private async accept(
    task: AgentTaskRecord,
    message: AgentEnvelope,
    eventType: string,
    payload: Record<string, unknown>,
    extra?: (entry: AgentTaskRecord) => void,
  ): Promise<AgentTaskRecord> {
    return this.context.journal.mutate(task.taskId, (entry) => {
      extra?.(entry)
      entry.currentMessageAcks[message.messageId] = entry.eventCursor + 1
    }, { type: eventType, payload })
  }

  private protocolFailure(taskId: string, managed: ManagedProcess, message: string): void {
    this.context.writeEnvelope(managed, { protocolVersion: '1.0', messageId: `host-error-${crypto.randomUUID()}`, taskId, executionId: managed.executionId, type: 'protocol.error', payload: { error: { code: 'PROTOCOL_INVALID', message, retryable: false }, fatal: true } })
    void this.context.failTask(taskId, { code: 'PROTOCOL_INVALID', message, retryable: false })
  }
}
