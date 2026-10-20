import type { AgentDecisionPayload, AgentEnvelope, AgentGrant, AgentMessageType } from '../../../packages/agent-protocol/index.js'
import { AgentTaskJournal } from './journal.js'
import type { AgentTaskRecord } from './types.js'
import type { AgentProcessManager } from './host-process.js'
import { AgentHostError, type ControlRequest, TERMINAL, checkIdentifier, hash } from './host-shared.js'
import { stableScopedId } from './tool-shared.js'
import { takePaidApproveFromTablet } from './tabletApproveCount.js'

/**
 * Дополнительные условия для решения, известные только месту вызова
 * (HTTP-роуту): откуда пришёл запрос и каков дневной лимит планшета. Клиент
 * сам сообщать «я планшет» не может — это подделывается; флаг ставит только
 * сервер из res.locals.remoteTablet.
 */
export interface AgentDecideOptions {
  /** Запрос пришёл с планшета по локальной сети (res.locals.remoteTablet). */
  tablet?: boolean
  /** Дневной лимит подтверждённых ПЛАТНЫХ решений агентов с планшета. 0 = выключен. */
  tabletApproveDailyLimit?: number
}

export interface HostLifecycleContext {
  readonly journal: AgentTaskJournal
  readonly processes: Pick<AgentProcessManager, 'has'>
  actorId(): string
  now(): number
  require(taskId: string): Promise<AgentTaskRecord>
  cancelExternal(task: AgentTaskRecord): Promise<void>
  start(taskId: string): Promise<AgentTaskRecord>
  sendOrQueue(taskId: string, message: AgentEnvelope): void
  makeHostEnvelope(task: AgentTaskRecord, type: AgentMessageType, payload: Record<string, unknown>): AgentEnvelope
}

/** Implements revision-gated pause/resume/cancel and human review decisions. */
export class AgentTaskLifecycle {
  constructor(private readonly context: HostLifecycleContext) {}

  async control(taskId: string, action: ControlRequest['action'], request: Omit<ControlRequest, 'action'>): Promise<AgentTaskRecord> {
    const requestId = checkIdentifier(request.requestId, 'requestId')
    if (typeof request.expectedRevision !== 'number' || !Number.isSafeInteger(request.expectedRevision)) throw new AgentHostError('INPUT_INVALID', 'expectedRevision is required')
    if (typeof request.reason !== 'string' || !/\S/u.test(request.reason)) throw new AgentHostError('INPUT_INVALID', 'reason is required')
    await this.context.require(taskId)
    let duplicate = false
    let resumed = false
    let processRunning = false
    const changed = await this.context.journal.withTaskLock(taskId, async () => {
      processRunning = this.context.processes.has(taskId)
      return this.context.journal.mutate(taskId, (entry) => {
      const seen = entry.controlReceipts[requestId]
      if (seen) {
        if (seen.action !== action || seen.expectedRevision !== request.expectedRevision || seen.reason !== request.reason) {
          throw new AgentHostError('OPERATION_CONFLICT', 'requestId was already used for another control action', 409)
        }
        duplicate = true
        return { changed: false }
      }
      if (entry.revision !== request.expectedRevision) {
        throw new AgentHostError('REVISION_CONFLICT', 'Task already changed: revision ' + entry.revision, 409)
      }
      if (action === 'resume') {
        if (entry.state !== 'paused' && entry.state !== 'queued') {
          throw new AgentHostError('INPUT_INVALID', 'Only a paused or queued task can be resumed', 409)
        }
        entry.state = 'queued'
        entry.revision += 1
        entry.controlReceipts[requestId] = {
          action, expectedRevision: request.expectedRevision, reason: request.reason, resultRevision: entry.revision,
        }
        resumed = true
        return { event: { type: 'task.resume.requested', payload: { requestId, reason: request.reason } } }
      }
      if (TERMINAL.has(entry.state)) return { changed: false }
      const nextState = action === 'pause' ? 'pausing' : 'cancelling'
      entry.state = nextState
      entry.revision += 1
      entry.controlReceipts[requestId] = {
        action, expectedRevision: request.expectedRevision, reason: request.reason, resultRevision: entry.revision,
      }
      if (action === 'cancel' && !processRunning) {
        entry.state = 'cancelled'
        entry.revision += 1
        entry.controlReceipts[requestId]!.resultRevision = entry.revision
        return { event: { type: 'task.cancelled', payload: { requestId, reason: request.reason } } }
      }
      return { event: { type: 'task.' + action + '.requested', payload: { requestId, reason: request.reason } } }
      })
    })
    if (duplicate || TERMINAL.has(changed.state)) return changed
    if (action === 'cancel') {
      await this.context.cancelExternal(await this.context.require(taskId)).catch(() => undefined)
    }
    if (resumed) {
      void this.context.start(taskId).catch(() => undefined)
      return changed
    }
    const messageType: AgentMessageType = action === 'pause' ? 'task.pause' : 'task.cancel'
    if (this.context.processes.has(taskId)) this.context.sendOrQueue(taskId, this.context.makeHostEnvelope(changed, messageType, { requestId, expectedRevision: changed.revision, reason: request.reason }))
    return changed
  }

  async decide(taskId: string, reviewId: string, input: Partial<AgentDecisionPayload> & { requestId: string; expectedRevision: number }, opts: AgentDecideOptions = {}): Promise<AgentTaskRecord> {
    const requestId = checkIdentifier(input.requestId, 'requestId')
    const comment = typeof input.comment === 'string' ? input.comment : ''
    const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers as Record<string, string> : {}
    const requestHash = hash({ reviewId, expectedRevision: input.expectedRevision, revision: input.revision, decision: input.decision, comment, answers })
    await this.context.require(taskId)
    let duplicate = false
    let decision: AgentDecisionPayload | undefined
    const decided = await this.context.journal.withTaskLock(taskId, () => this.context.journal.mutate(taskId, async (entry) => {
      const previous = entry.decisionReceipts[requestId]
      if (previous) {
        if (previous.reviewId !== reviewId || previous.requestHash !== requestHash) {
          throw new AgentHostError('OPERATION_CONFLICT', 'requestId was already used for another decision', 409)
        }
        duplicate = true
        return { changed: false }
      }
      if (entry.revision !== input.expectedRevision) {
        throw new AgentHostError('REVISION_CONFLICT', 'Task already changed: revision ' + entry.revision, 409)
      }
      if (entry.state !== 'awaiting_review') {
        throw new AgentHostError('TASK_NOT_RUNNING', 'A decision is allowed only for a task waiting for approval', 409)
      }
      const review = entry.reviews.find((candidate) => candidate.reviewId === reviewId && candidate.status === 'pending')
      if (!review) throw new AgentHostError('REVIEW_SUPERSEDED', 'Approval card is no longer current', 409)
      if (input.revision !== review.revision) throw new AgentHostError('REVIEW_SUPERSEDED', 'Approval revision is stale', 409)
      if (input.decision !== 'approved' && input.decision !== 'changes-requested' && input.decision !== 'rejected') {
        throw new AgentHostError('INPUT_INVALID', 'Invalid decision')
      }
      if ((input.decision === 'changes-requested' || input.decision === 'rejected') && !/\S/u.test(comment)) {
        throw new AgentHostError('INPUT_INVALID', 'This decision requires a non-empty comment')
      }
      let grants: AgentGrant[] = []
      if (input.decision === 'approved' && review.generationSpec && entry.generationBudget) {
        // ПЛАТНОЕ одобрение: с планшета требуется явное согласие на оплату и
        // действует дневной лимит подтверждений. Счётчик списывается здесь, в
        // моменте коммита решения — это единственная точка, где известно, что
        // за одобрением реально стоит оплачиваемая генерация (маршрут этого
        // знать не может, бюджет есть только у записи задачи).
        const fromTablet = opts.tablet === true
        if (fromTablet && input.consent !== true) {
          throw new AgentHostError('CONSENT_REQUIRED', 'Paid approval from the tablet requires explicit payment consent', 403)
        }
        const cap = typeof opts.tabletApproveDailyLimit === 'number' ? opts.tabletApproveDailyLimit : 0
        if (fromTablet && cap > 0) {
          const taken = await takePaidApproveFromTablet(cap, new Date(this.context.now()))
          if (!taken) {
            throw new AgentHostError('TABLET_APPROVE_LIMIT_REACHED', 'The daily limit for approved paid agent decisions from the tablet is exhausted', 429)
          }
        }
        const spec = review.generationSpec
        grants = [{
          id: stableScopedId('opgrant', taskId, reviewId, String(review.revision)),
          tools: ['generation.request'],
          connectionId: 'local-fal',
          artifactRefs: structuredClone(spec.refs ?? []),
          maxCalls: 1,
          maxCost: { currency: 'USD', amountMicros: spec.estimateMicros ?? 0 },
          status: 'active',
          generationSpec: {
            kind: spec.kind,
            modelId: spec.modelId,
            catalogRevision: spec.catalogRevision,
            params: structuredClone(spec.params ?? {}),
            estimateMicros: spec.estimateMicros ?? 0,
          },
          reviewId,
          reviewRevision: review.revision,
        }]
      }
      decision = {
        reviewId,
        revision: review.revision,
        decision: input.decision,
        comment,
        answers,
        actorId: this.context.actorId(),
        decidedAt: new Date(this.context.now()).toISOString(),
        grants,
        // Подтверждение согласия остаётся в решении как доказательство:
        // для платных одобрений с планшета здесь всегда true (иначе выше
        // уже вылетела бы error CONSENT_REQUIRED). Ключ добавляется только
        // для таких решений — схема протокола отвергает сам факт присутствия
        // незнакомых/undefined-полей в payload.
        ...(grants.length > 0 && opts.tablet === true ? { consent: true } : {}),
      }
      const target = entry.reviews.find((candidate) => candidate.reviewId === reviewId && candidate.revision === review.revision)
      if (target) { target.status = decision!.decision; target.decision = decision }
      entry.decisions.push(decision!)
      entry.decisionReceipts[requestId] = { reviewId, requestHash, resultRevision: entry.revision + 1 }
      entry.state = 'running'
      entry.revision += 1
      return { event: { type: 'review.decision', payload: decision as unknown as Record<string, unknown> } }
    }))
    if (duplicate) return decided
    if (!decision) throw new AgentHostError('INTERNAL_ERROR', 'Decision was not created')
    if (!this.context.processes.has(taskId)) await this.context.start(taskId)
    this.context.sendOrQueue(taskId, this.context.makeHostEnvelope(decided, 'review.decision', decision as unknown as Record<string, unknown>))
    return decided
  }
}
