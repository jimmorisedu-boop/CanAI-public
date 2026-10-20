import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentArtifact,
  AgentArtifactRef,
  AgentConnection,
  AgentGenerationAuthorization,
  AgentGenerationBudgetView,
  AgentGenerationModelPin,
  AgentGenerationReviewSpec,
} from '../../../packages/agent-protocol/index.js'
import sharp from 'sharp'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { config } from '../config.js'
import { generationGate, type GenerationGate } from '../generationGate.js'
import { jobs, type Job } from '../jobs.js'
import { mediaFileName, resolveMediaIn } from '../mediaLayout.js'
import { mimeForExt } from '../mediaTypes.js'
import { cancelJobById, persistAndEnqueueJob } from '../runner.js'
import {
  artifactForRef,
  digest,
  errorOf,
  estimateMicros,
  isEligibleRef,
  modelFor,
  modelParamCheck,
  reviewFor,
  sameRefs,
  specMatches,
  validateArtifactRefs,
  validateModelRefs,
  validateParams,
} from './generation-broker-helpers.js'
import { AgentTaskJournal } from './journal.js'
import { syncSpendBudget, type AgentGenerationOperation, type AgentTaskRecord } from './types.js'
import { AgentToolError, sharedSpendStatusFor, stableId, stableScopedId, type ToolResult } from './tool-shared.js'

export const AGENT_GENERATION_CONNECTION = 'local-fal' as const
export const AGENT_GENERATION_MAX_CALLS = 1
export const AGENT_GENERATION_MAX_CALLS_LIMIT = 24
export const AGENT_GENERATION_MAX_PROMPT_CHARS = 16_000
export const AGENT_GENERATION_MAX_PARAMS_BYTES = 32_000
export const AGENT_GENERATION_POLL_MS = 250
export const AGENT_GENERATION_IMAGE_TIMEOUT_MS = 4 * 60_000
export const AGENT_GENERATION_VIDEO_TIMEOUT_MS = 15 * 60_000
export const AGENT_GENERATION_AUDIO_TIMEOUT_MS = 10 * 60_000

export interface AgentGenerationCatalogSource {
  models(): CatalogModel[]
  view(): { revision: number }
}

export interface AgentGenerationJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  result?: { url?: string; mime?: string; width?: number; height?: number; seed?: number; assetId?: string }
  error?: string
  chargedAmountUsd?: number
  falRequestId?: string
  paidResult?: { url: string }
}

export interface AgentGenerationJobRunner {
  create(input: {
    taskId: string
    operationId: string
    kind: 'image' | 'video' | 'audio'
    prompt: string
    refs: Array<{ kind: 'image' | 'video' | 'audio'; src: string; role?: string }>
    model: CatalogModel
    params: Record<string, unknown>
  }): Promise<{ jobId: string }>
  get(jobId: string): Promise<AgentGenerationJob | undefined> | AgentGenerationJob | undefined
  cancel(jobId: string): Promise<void>
}

export interface AgentGenerationBrokerOptions {
  journal: AgentTaskJournal
  catalog: AgentGenerationCatalogSource
  mediaDir?: string
  provider?: AgentGenerationJobRunner
  generationGate?: GenerationGate
  connectionReady?: () => boolean
  /** CANAI_MOCK is deliberately fail-closed for paid Agent generation. */
  mockMode?: boolean
  now?: () => number
  pollMs?: number
}

const SAFE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableJobId(taskId: string, operationId: string): string {
  const readable = stableId('agent-job', taskId, operationId)
  if (readable.length <= 100) return readable
  const digest = crypto.createHash('sha256').update(taskId).update('\0').update(operationId).digest('hex')
  return `agent-job-${digest}`
}

async function checksumFile(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  const handle = await fs.open(filePath, 'r')
  try {
    for await (const chunk of handle.createReadStream()) {
      const bytes = chunk as Buffer
      sizeBytes += bytes.length
      if (sizeBytes > MAX_ARTIFACT_BYTES) throw new AgentToolError('FILE_INVALID', 'Generation result is too large')
      hash.update(bytes)
    }
  } finally {
    await handle.close()
  }
  if (sizeBytes < 1) throw new AgentToolError('FILE_INVALID', 'Generation result is empty')
  return { checksum: hash.digest('hex'), sizeBytes }
}

async function generatedArtifact(
  task: AgentTaskRecord,
  operationId: string,
  kind: 'image' | 'video' | 'audio',
  result: NonNullable<AgentGenerationJob['result']>,
  mediaDir: string,
  model: CatalogModel,
): Promise<AgentArtifact> {
  if (typeof result.url !== 'string' || !result.url.startsWith('/media/')) throw new AgentToolError('GENERATION_RESULT_INVALID', 'Runner did not return a native /media result')
  const name = mediaFileName(result.url)
  const filePath = path.resolve(resolveMediaIn(mediaDir, name))
  const root = path.resolve(mediaDir)
  if (filePath !== root && !filePath.startsWith(root + path.sep)) throw new AgentToolError('PATH_INVALID', 'Generation result is outside the media root')
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) throw new AgentToolError('GENERATION_RESULT_INVALID', 'Native media result is missing')
  const mimeType = result.mime && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(result.mime)
    ? result.mime
    : mimeForExt(path.extname(name).slice(1))
  if (!mimeType.startsWith(`${kind}/`)) throw new AgentToolError('GENERATION_RESULT_INVALID', 'Generation result does not match the requested kind')
  const file = await checksumFile(filePath)
  let width = Number.isSafeInteger(result.width) && (result.width ?? 0) > 0 ? result.width : undefined
  let height = Number.isSafeInteger(result.height) && (result.height ?? 0) > 0 ? result.height : undefined
  let durationMs: number | undefined
  if (kind === 'image' && (!width || !height)) {
    try {
      const meta = await sharp(filePath).metadata()
      if (meta.width && meta.height) {
        width = meta.width
        height = meta.height
      }
    } catch {}
  }
  if (kind === 'video' && (!width || !height || !durationMs)) {
    try {
      const { probeVideoFile } = await import('../mediaOps.js')
      const facts = await probeVideoFile(filePath)
      if (!width && facts.width) width = facts.width
      if (!height && facts.height) height = facts.height
      if (!durationMs && typeof facts.duration === 'number' && Number.isFinite(facts.duration)) {
        durationMs = Math.round(facts.duration * 1000)
      }
    } catch {}
  }
  if (kind === 'audio' && !durationMs) {
    try {
      const { probeAudio } = await import('../mediaOps.js')
      const probed = await probeAudio(filePath)
      if (typeof probed.duration === 'number' && Number.isFinite(probed.duration)) {
        durationMs = Math.round(probed.duration * 1000)
      }
    } catch {}
  }
  return {
    artifactId: stableScopedId('artifact', task.taskId, operationId, '0'),
    revision: 1,
    checksum: file.checksum,
    kind,
    caption: `Generated: ${model.name}`,
    mimeType,
    sizeBytes: file.sizeBytes,
    mediaSrc: `/media/${name}`,
    provenance: 'generated',
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

function actualCostMicros(job: AgentGenerationJob, fallback: number): number | null {
  if (job.chargedAmountUsd === undefined) return null
  if (!Number.isFinite(job.chargedAmountUsd) || job.chargedAmountUsd < 0 || job.chargedAmountUsd * 1_000_000 > Number.MAX_SAFE_INTEGER) {
    throw new AgentToolError('GENERATION_COST_INVALID', 'Runner returned an invalid actual generation cost')
  }
  return Math.ceil(job.chargedAmountUsd * 1_000_000)
}

const defaultRunner: AgentGenerationJobRunner = {
  async create(input): Promise<{ jobId: string }> {
    // Job IDs are persisted in the jobs store and also become native media
    // basenames in the existing mock runner.  Keep this ID deterministic for
    // replay, but filesystem-safe on Windows (stableScopedId's `:` is not).
    const job = jobs.create(input.kind, input.prompt, input.refs, input.model.id, input.params, undefined, false, stableJobId(input.taskId, input.operationId))
    // The normal desktop route remains local-fal.  An explicit CANAI_MOCK
    // process uses the existing runner's deterministic mock lane so focused
    // broker tests can exercise durable jobs without a provider or key.
    job.generationRoute = config.mockMode ? 'mock' : 'local'
    job.modelSnapshot = structuredClone(input.model)
    await persistAndEnqueueJob(job)
    return { jobId: job.id }
  },
  get(jobId): AgentGenerationJob | undefined {
    const job = jobs.get(jobId)
    return job ? structuredClone(job) : undefined
  },
  async cancel(jobId): Promise<void> {
    await cancelJobById(jobId)
  },
}

function operationOf(task: AgentTaskRecord, operationId: string): AgentGenerationOperation | undefined {
  return task.generationOperations?.find((operation) => operation.operationId === operationId)
}

function statusFor(budget: AgentGenerationBudgetView, operations: AgentGenerationOperation[]): AgentGenerationBudgetView['status'] {
  if (operations.some((operation) => operation.status === 'uncertain' || (operation.status === 'cancelled' && operation.reservedMicros > 0))) return 'blocked'
  if (budget.overshootMicros > 0) return 'overspent'
  if (budget.calls >= budget.maxCalls || budget.chargedMicros + budget.reservedMicros >= budget.maxCostMicros) return 'exhausted'
  return 'active'
}

export class AgentGenerationBroker {
  private readonly runner: AgentGenerationJobRunner
  private readonly gate: GenerationGate
  private readonly now: () => number
  private readonly connectionReady: () => boolean
  private readonly mockMode: boolean
  private readonly mediaDir: string
  private readonly pollMs: number
  private readonly taskOperationLocks = new Map<string, Promise<void>>()

  constructor(private readonly options: AgentGenerationBrokerOptions) {
    this.runner = options.provider ?? defaultRunner
    this.gate = options.generationGate ?? generationGate
    this.now = options.now ?? Date.now
    this.connectionReady = options.connectionReady ?? (() => false)
    this.mockMode = options.mockMode ?? false
    this.mediaDir = path.resolve(options.mediaDir ?? config.mediaDir)
    this.pollMs = Number.isSafeInteger(options.pollMs) && (options.pollMs ?? 0) > 0 ? options.pollMs! : AGENT_GENERATION_POLL_MS
  }

  connectionStatus(): 'ready' | 'unavailable' { return !this.mockMode && this.connectionReady() ? 'ready' : 'unavailable' }

  /** Narrow local Host catalog DTO; Cloud has a separate wallet-owned catalog. */
  catalogView(): { revision: number; connection: { id: 'local-fal'; kind: 'generation'; status: 'ready' | 'unavailable' }; models: CatalogModel[] } {
    return {
      revision: this.options.catalog.view().revision,
      connection: { id: AGENT_GENERATION_CONNECTION, kind: 'generation', status: this.connectionStatus() },
      models: this.options.catalog.models()
        .filter((model) => model.kind === 'image' || model.kind === 'video' || model.kind === 'audio')
        .map((model) => structuredClone(model)),
    }
  }

  prepareTask(
    taskId: string,
    projectSource: 'local' | 'cloud',
    permissions: string[],
    authorization?: AgentGenerationAuthorization,
    existingBudget?: AgentGenerationBudgetView,
  ): AgentGenerationBudgetView | undefined {
    const requested = permissions.includes('generation.request')
    if (!requested) {
      if (authorization) throw new AgentToolError('PERMISSION_DENIED', 'Generation authorization does not belong to a package without generation.request')
      return undefined
    }
    if (projectSource !== 'local') throw new AgentToolError('GENERATION_LOCAL_ONLY', 'generation.request through local-fal is available only to the local project')
    if (!authorization || authorization.connectionId !== AGENT_GENERATION_CONNECTION || authorization.mediaTransferConsent !== true) {
      throw new AgentToolError('GENERATION_AUTH_REQUIRED', 'Explicit approval is required to send media refs to local fal.ai')
    }
    if (!Number.isSafeInteger(authorization.maxCostMicros) || authorization.maxCostMicros < 1 || authorization.maxCostMicros > 1_000_000_000_000) {
      throw new AgentToolError('BUDGET_INVALID', 'Generation limit must be a positive integer in USD micros')
    }
    if (this.mockMode || !this.connectionReady()) throw new AgentToolError('GENERATION_CONNECTION_UNAVAILABLE', 'Local fal.ai generation connection is unavailable')
    if (existingBudget && existingBudget.maxCostMicros !== authorization.maxCostMicros) throw new AgentToolError('BUDGET_CONFLICT', 'LLM and generation must use the same task maxCostMicros')

    const catalogRevision = this.options.catalog.view().revision
    const isMultiOp = Array.isArray(authorization.models) && authorization.models.length > 0
    if (isMultiOp) {
      if (authorization.models!.length < 1 || authorization.models!.length > 3) {
        throw new AgentToolError('GENERATION_SCOPE_INVALID', 'Multi-operation generation allows 1 to 3 models')
      }
      const seenKinds = new Set<'image' | 'video' | 'audio'>()
      const pins: AgentGenerationModelPin[] = []
      for (const pin of authorization.models!) {
        if (pin.kind !== 'image' && pin.kind !== 'video' && pin.kind !== 'audio') {
          throw new AgentToolError('INPUT_INVALID', 'Unsupported generation model kind')
        }
        if (seenKinds.has(pin.kind)) {
          throw new AgentToolError('GENERATION_SCOPE_INVALID', 'Multi-operation generation requires unique model kinds')
        }
        seenKinds.add(pin.kind)
        const model = modelFor(this.options.catalog, pin.modelId, pin.kind)
        if (pin.params) {
          if (!isRecord(pin.params)) throw new AgentToolError('INPUT_INVALID', 'Model parameters must be an object')
          modelParamCheck(model, pin.params)
        }
        pins.push({
          kind: pin.kind,
          modelId: model.id,
          ...(pin.params ? { params: structuredClone(pin.params) } : {}),
        })
      }
      if (!Number.isSafeInteger(authorization.maxCalls) || authorization.maxCalls! < 1 || authorization.maxCalls! > AGENT_GENERATION_MAX_CALLS_LIMIT) {
        throw new AgentToolError('GENERATION_SCOPE_INVALID', `maxCalls is required and must be an integer from 1 to ${AGENT_GENERATION_MAX_CALLS_LIMIT}`)
      }
      if (!Number.isSafeInteger(authorization.expectedCatalogRevision)) {
        throw new AgentToolError('GENERATION_AUTH_REQUIRED', 'Catalog revision is required')
      }
      if (authorization.expectedCatalogRevision !== catalogRevision) {
        throw new AgentToolError('GENERATION_CATALOG_STALE', 'Media model catalog is stale; refresh the model list')
      }
      if (authorization.expectedModelId !== undefined && authorization.expectedModelId !== pins[0].modelId) {
        throw new AgentToolError('GENERATION_MODEL_PIN_MISMATCH', 'expectedModelId must match the first pinned model')
      }
      const budget: AgentGenerationBudgetView = existingBudget
        ? {
            ...structuredClone(existingBudget),
            maxCalls: authorization.maxCalls!,
            modelId: pins[0].modelId,
            pins,
            catalogRevision,
            artifactRefs: structuredClone(authorization.artifactRefs ?? existingBudget.artifactRefs ?? []),
          }
        : {
            grantId: stableScopedId('grant', taskId, AGENT_GENERATION_CONNECTION),
            connectionId: AGENT_GENERATION_CONNECTION,
            currency: 'USD',
            maxCostMicros: authorization.maxCostMicros,
            reservedMicros: 0,
            chargedMicros: 0,
            overshootMicros: 0,
            calls: 0,
            maxCalls: authorization.maxCalls!,
            status: 'active',
            modelId: pins[0].modelId,
            pins,
            catalogRevision,
            artifactRefs: structuredClone(authorization.artifactRefs ?? []),
          }
      return budget
    }

    if (typeof authorization.expectedModelId !== 'string' || !authorization.expectedModelId.trim() || !Number.isSafeInteger(authorization.expectedCatalogRevision)) {
      throw new AgentToolError('GENERATION_AUTH_REQUIRED', 'An approved media model and catalog revision are required before running')
    }
    if (authorization.maxCalls !== undefined && authorization.maxCalls !== AGENT_GENERATION_MAX_CALLS) {
      throw new AgentToolError('GENERATION_SCOPE_INVALID', 'generation.request v1 allows exactly one paid call per task')
    }
    const model = this.options.catalog.models().find((candidate) => candidate.id === authorization.expectedModelId)
    if (!model || model.kind === 'text' || model.lifecycle !== 'active') throw new AgentToolError('GENERATION_MODEL_UNSUPPORTED', 'Pinned media model is unavailable')
    if (authorization.expectedCatalogRevision !== catalogRevision) throw new AgentToolError('GENERATION_CATALOG_STALE', 'Media model catalog is stale; refresh the model list')
    const budget: AgentGenerationBudgetView = existingBudget
      ? { ...structuredClone(existingBudget), maxCalls: AGENT_GENERATION_MAX_CALLS, modelId: model.id, catalogRevision, artifactRefs: structuredClone(authorization.artifactRefs ?? existingBudget.artifactRefs ?? []) }
      : {
          grantId: stableScopedId('grant', taskId, AGENT_GENERATION_CONNECTION),
          connectionId: AGENT_GENERATION_CONNECTION,
          currency: 'USD',
          maxCostMicros: authorization.maxCostMicros,
          reservedMicros: 0,
          chargedMicros: 0,
          overshootMicros: 0,
          calls: 0,
          maxCalls: AGENT_GENERATION_MAX_CALLS,
          status: 'active',
          modelId: model.id,
          catalogRevision,
          artifactRefs: structuredClone(authorization.artifactRefs ?? []),
        }
    return budget
  }

  startAccess(task: AgentTaskRecord): { connections: AgentConnection[]; grants: Array<{ id: string; tools: Array<'llm.request' | 'generation.request'>; connectionId: string; artifactRefs: AgentArtifactRef[]; maxCalls: number; maxCost: { currency: 'USD'; amountMicros: number }; status: 'active' | 'exhausted' | 'revoked' }> } {
    const budget = task.generationBudget
    if (!budget) return { connections: [], grants: [] }
    return {
      connections: [{ id: AGENT_GENERATION_CONNECTION, kind: 'generation', status: this.connectionStatus() }],
      grants: [{ id: budget.grantId, tools: ['generation.request'], connectionId: AGENT_GENERATION_CONNECTION, artifactRefs: structuredClone(budget.artifactRefs ?? []), maxCalls: budget.maxCalls, maxCost: { currency: 'USD', amountMicros: budget.maxCostMicros }, status: budget.status === 'active' ? 'active' : 'exhausted' }],
    }
  }

  async execute(task: AgentTaskRecord, rawArguments: unknown, operationId: string): Promise<ToolResult> {
    if (!SAFE_OPERATION.test(operationId)) throw new AgentToolError('INPUT_INVALID', 'Generation operationId has an invalid format')
    return this.withTaskOperationLock(task.taskId, async () => {
      const fresh = await this.options.journal.get(task.taskId)
      if (!fresh) throw new AgentToolError('TASK_NOT_FOUND', 'Agent task not found')
      return await this.executeUnlocked(fresh, rawArguments, operationId)
    })
  }

  async cancelTask(task: AgentTaskRecord): Promise<void> {
    const current = await this.options.journal.get(task.taskId)
    for (const operation of current?.generationOperations ?? task.generationOperations ?? []) {
      if (!['reserved', 'submitted', 'uncertain'].includes(operation.status)) continue
      if (!operation.jobId) {
        await this.markFailure(task.taskId, operation.operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Generation operation has no durable job ID; resubmission is forbidden', retryable: true }, true)
        continue
      }
      try {
        await this.runner.cancel(operation.jobId)
        await this.options.journal.mutate(task.taskId, (entry) => {
          const currentOperation = entry.generationOperations?.find((item) => item.operationId === operation.operationId)
          const budget = entry.generationBudget
          const spend = entry.spendBudget
          if (!currentOperation || !budget || !['submitted', 'uncertain'].includes(currentOperation.status)) return
          currentOperation.status = 'cancelled'
          currentOperation.error = { code: 'GENERATION_CANCELLED', message: 'Runner confirmed cancellation; a late paid result may still be reconciled', retryable: true }
          currentOperation.updatedAt = this.now()
          if (spend) {
            spend.status = 'blocked'
            syncSpendBudget(entry)
          } else {
            budget.status = 'blocked'
          }
        }, { type: 'generation.cancelled', payload: { operationId: operation.operationId, jobId: operation.jobId } })
      } catch {
        await this.markFailure(task.taskId, operation.operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Runner did not confirm generation cancellation; resubmission is forbidden', retryable: true }, true)
      }
    }
  }

  /** Resume only already-submitted journal entries; never consult current catalog admission. */
  async recoverPersisted(task: AgentTaskRecord): Promise<void> {
    const current = await this.options.journal.get(task.taskId)
    if (!current || current.projectRef.source !== 'local') return
    for (const operation of current.generationOperations ?? []) {
      if (!['reserved', 'submitted', 'uncertain', 'cancelled'].includes(operation.status)) continue
      await this.withTaskOperationLock(task.taskId, async () => {
        const fresh = await this.options.journal.get(task.taskId)
        const latest = fresh?.generationOperations?.find((candidate) => candidate.operationId === operation.operationId)
        if (!fresh || !fresh.generationBudget || !latest || latest.status === 'succeeded' || latest.status === 'failed') return
        if (!latest.jobId || !latest.modelSnapshot) {
          await this.markFailure(task.taskId, latest.operationId, {
            code: 'GENERATION_OUTCOME_UNCERTAIN',
            message: 'Generation operation has no durable job/model ID; resubmission is forbidden',
            retryable: true,
          }, true)
          return
        }
        if (this.mockMode) return
        const kind = latest.modelSnapshot.kind
        if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
          await this.markFailure(task.taskId, latest.operationId, {
            code: 'GENERATION_OUTCOME_UNCERTAIN',
            message: 'Generation operation has no safe immutable model snapshot; resubmission is forbidden',
            retryable: true,
          }, true)
          return
        }
        const expectedModelId = fresh.generationBudget.pins?.find((candidate) => candidate.kind === kind)?.modelId ?? fresh.generationBudget.modelId
        if (latest.modelSnapshot.id !== expectedModelId) {
          await this.markFailure(task.taskId, latest.operationId, {
            code: 'GENERATION_OUTCOME_UNCERTAIN',
            message: 'Generation operation has no safe immutable model snapshot; resubmission is forbidden',
            retryable: true,
          }, true)
          return
        }
        await this.resumeAndReconcile(task.taskId, latest, structuredClone(latest.modelSnapshot), kind)
      })
    }
  }

  computeGenerationSpec(task: AgentTaskRecord, rawInput: unknown): AgentGenerationReviewSpec & { estimateMicros: number; prompt: string; params: Record<string, unknown> } {
    const budget = task.generationBudget
    if (!budget) throw new AgentToolError('GENERATION_AUTH_REQUIRED', 'Task has no approved generation grant')
    if (!isRecord(rawInput)) throw new AgentToolError('INPUT_INVALID', 'generation arguments must be an object')
    const args = rawInput
    if (args.kind !== 'image' && args.kind !== 'video' && args.kind !== 'audio') {
      throw new AgentToolError('INPUT_INVALID', 'generation kind is not supported')
    }
    const kind = args.kind
    let model: CatalogModel
    if (budget.pins?.length) {
      const pin = budget.pins.find((candidate) => candidate.kind === kind)
      if (!pin) throw new AgentToolError('GENERATION_MODEL_PIN_MISMATCH', 'No pinned model for kind ' + kind)
      if (args.modelId !== undefined && args.modelId !== pin.modelId) {
        throw new AgentToolError('GENERATION_MODEL_PIN_MISMATCH', 'Attempt to change the pinned media model')
      }
      model = modelFor(this.options.catalog, pin.modelId, kind)
    } else {
      if (args.modelId !== undefined && args.modelId !== budget.modelId) {
        throw new AgentToolError('GENERATION_MODEL_PIN_MISMATCH', 'Attempt to change the pinned media model')
      }
      model = modelFor(this.options.catalog, budget.modelId, kind)
    }
    if (budget.catalogRevision !== this.options.catalog.view().revision) {
      throw new AgentToolError('GENERATION_CATALOG_STALE', 'Pinned generation catalog revision is stale')
    }
    const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : ''
    if (!prompt || prompt.length > AGENT_GENERATION_MAX_PROMPT_CHARS) {
      throw new AgentToolError('INPUT_INVALID', 'generation prompt has an invalid size')
    }
    const refs = validateArtifactRefs(args.refs)
    const params = validateParams(args.params)
    modelParamCheck(model, params)
    if (budget.pins?.length) {
      for (const ref of refs) {
        if (!isEligibleRef(task, budget, ref)) {
          throw new AgentToolError('REF_NOT_APPROVED', 'Media ref was not approved by the user')
        }
      }
    } else {
      if (!sameRefs(budget.artifactRefs ?? [], refs)) {
        throw new AgentToolError('TRANSFER_CONSENT_MISMATCH', 'Generation refs do not match the explicitly approved transfer grant')
      }
    }
    const artifacts = refs.map((ref) => artifactForRef(task, ref))
    validateModelRefs(model, artifacts)
    const reservedMicros = estimateMicros(model, params, artifacts, prompt)
    return {
      kind,
      modelId: model.id,
      catalogRevision: budget.catalogRevision,
      promptHash: digest(prompt),
      refs,
      paramsHash: digest(params),
      prompt,
      params: structuredClone(params),
      estimateMicros: reservedMicros,
    }
  }

  async quote(task: AgentTaskRecord, rawArguments: unknown, operationId: string): Promise<ToolResult> {
    if (!SAFE_OPERATION.test(operationId)) throw new AgentToolError('INPUT_INVALID', 'Generation operationId has an invalid format')
    if (task.state !== 'running') throw new AgentToolError('TASK_NOT_RUNNING', 'New generation actions are forbidden in the current task state')
    const spec = this.computeGenerationSpec(task, rawArguments)
    const budget = task.generationBudget!
    const ledger = task.spendBudget ?? budget
    const remainingMicros = Math.max(0, ledger.maxCostMicros - ledger.chargedMicros - ledger.reservedMicros)
    let callsLeft = Math.max(0, budget.maxCalls - budget.calls)
    if (task.spendBudget) {
      callsLeft = Math.min(callsLeft, Math.max(0, task.spendBudget.maxCalls - task.spendBudget.calls))
    }
    return {
      result: {
        spec,
        budget: {
          remainingMicros,
          callsLeft,
        },
      },
    }
  }

  private async executeUnlocked(task: AgentTaskRecord, rawArguments: unknown, operationId: string): Promise<ToolResult> {
    if (task.projectRef.source !== 'local') throw new AgentToolError('GENERATION_LOCAL_ONLY', 'generation.request cannot pay for a Cloud task with a local key')
    const budget = task.generationBudget
    if (!budget) throw new AgentToolError('GENERATION_AUTH_REQUIRED', 'Task has no approved generation grant')
    const spend = task.spendBudget
    if (!isRecord(rawArguments)) throw new AgentToolError('INPUT_INVALID', 'generation.request.arguments must be an object')
    const args = rawArguments
    const allowed = new Set(['connectionId', 'grantId', 'kind', 'prompt', 'refs', 'params', 'modelId'])
    if (Object.keys(args).some((key) => !allowed.has(key))) throw new AgentToolError('INPUT_INVALID', 'generation.request contains an unsupported field')
    if (args.connectionId !== AGENT_GENERATION_CONNECTION || args.grantId !== (spend?.grantId ?? budget.grantId)) throw new AgentToolError('GRANT_REQUIRED', 'Generation connection or grant does not belong to this task')

    const kind = args.kind as 'image' | 'video' | 'audio'
    const argumentsHash = digest({ tool: 'generation.request', arguments: args })
    const previous = operationOf(task, operationId)
    if (previous) {
      if (previous.argumentsHash !== argumentsHash) throw new AgentToolError('OPERATION_CONFLICT', 'operationId was already used with different generation arguments')
      if (previous.status === 'succeeded' && previous.result) return { result: structuredClone(previous.result) }
      if (previous.status === 'failed') throw new AgentToolError(previous.error?.code ?? 'GENERATION_FAILED', previous.error?.message ?? 'Generation operation already failed')
      if (!previous.jobId) {
        await this.markFailure(task.taskId, operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Generation operation already started without a durable job ID; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation outcome is unknown; resubmission is forbidden', true)
      }
      const expectedModelId = budget.pins?.find((candidate) => candidate.kind === kind)?.modelId ?? budget.modelId
      if (!previous.modelSnapshot || previous.modelSnapshot.id !== expectedModelId || previous.modelSnapshot.kind !== kind) {
        throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation has no safe pinned model snapshot; resubmission is forbidden', true)
      }
      // Existing paid/uncertain work is resumed against the immutable model
      // snapshot.  A terminal task may reconcile that work, but this branch
      // never admits a new operation or changes the task lifecycle state.
      return this.resumeAndReconcile(task.taskId, previous, structuredClone(previous.modelSnapshot), kind)
    }
    if (task.state !== 'running') throw new AgentToolError('TASK_NOT_RUNNING', 'New generation actions are forbidden in the current task state')
    const spec = this.computeGenerationSpec(task, args)
    const model = modelFor(this.options.catalog, spec.modelId, spec.kind)
    reviewFor(task, spec)
    const reservation = await this.reserve(task, operationId, argumentsHash, model, spec.estimateMicros, spec)
    if (!reservation.created) {
      if (reservation.operation.status === 'succeeded' && reservation.operation.result) return { result: structuredClone(reservation.operation.result) }
      if (!reservation.operation.jobId) {
        await this.markFailure(task.taskId, operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Generation operation already started without a durable job ID; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation outcome is unknown; resubmission is forbidden', true)
      }
      return this.resumeAndReconcile(task.taskId, reservation.operation, model, kind)
    }
    const artifacts = spec.refs.map((ref) => artifactForRef(task, ref))
    const params = spec.params as Record<string, unknown>
    const mediaRefs = artifacts.map((artifact) => ({ kind: artifact.kind as 'image' | 'video' | 'audio', src: artifact.mediaSrc, role: undefined }))
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
        await this.markFailure(task.taskId, operationId, { code: 'GENERATION_SHUTTING_DOWN', message: 'CanAI is shutting down; generation submit deferred', retryable: true }, false, true)
        throw new AgentToolError('GENERATION_SHUTTING_DOWN', 'CanAI is shutting down; generation submit deferred', true)
      }
      const current = await this.options.journal.get(task.taskId)
      if (!current || current.state !== 'running') {
        gateRejected = true
        await this.markFailure(task.taskId, operationId, { code: 'TASK_NOT_RUNNING', message: 'New generation actions are forbidden in the current task state', retryable: true }, false, true)
        throw new AgentToolError('TASK_NOT_RUNNING', 'New generation actions are forbidden in the current task state', true)
      }
      const currentOperation = operationOf(current, operationId)
      if (!currentOperation || currentOperation.status === 'uncertain' || currentOperation.status === 'cancelled') {
        await this.markFailure(task.taskId, operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Generation operation already stopped; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation already stopped; resubmission is forbidden', true)
      }
      const submitted = await this.runner.create({ taskId: task.taskId, operationId, kind, prompt: spec.prompt!, refs: mediaRefs, model, params })
      if (!submitted || typeof submitted.jobId !== 'string' || !submitted.jobId.trim()) throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Runner did not return a durable job ID', true)
      const updated = await this.options.journal.mutate(task.taskId, (entry) => {
        const operation = operationOf(entry, operationId)
        if (!operation) throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation disappeared before the job ID was saved', true)
        operation.status = 'submitted'
        operation.jobId = submitted.jobId
        operation.providerRequestId = submitted.jobId
        operation.updatedAt = this.now()
      }, { type: 'generation.submitted', payload: { operationId, jobId: submitted.jobId } })
      // The durable job ID is now in the journal; a crash after this point can
      // only resume this job and never submit a second paid request.
      release()
      const operation = operationOf(updated, operationId)
      if (!operation) throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation was not saved after submit', true)
      // Await inside the guarded submit block so a provider polling failure is
      // converted to a durable uncertain receipt before the caller sees it.
      // Returning the promise directly would bypass this catch/finalization.
      return await this.waitAndReconcile(task.taskId, operation, model, kind)
    } catch (error) {
      release()
      const failure = errorOf(error)
      const hold = !gateRejected && (failure.code === 'GENERATION_OUTCOME_UNCERTAIN' || !this.gate.shuttingDown)
      await this.markFailure(task.taskId, operationId, failure, hold, gateRejected).catch(() => undefined)
      throw error instanceof AgentToolError ? error : new AgentToolError(failure.code, failure.message, failure.retryable)
    }
  }

  private async reserve(
    task: AgentTaskRecord,
    operationId: string,
    argumentsHash: string,
    model: CatalogModel,
    reservedMicros: number,
    spec: AgentGenerationReviewSpec,
  ): Promise<{ operation: AgentGenerationOperation; created: boolean }> {
    let result!: AgentGenerationOperation
    let created = false
    await this.options.journal.mutate(task.taskId, (entry) => {
      const budget = entry.generationBudget
      const spend = entry.spendBudget
      if (!budget || budget.status !== 'active' || budget.calls >= budget.maxCalls) throw new AgentToolError('BUDGET_EXCEEDED', 'Generation budget no longer allows new calls')
      if (spend && (spend.status !== 'active' || spend.calls >= spend.maxCalls)) throw new AgentToolError('BUDGET_EXCEEDED', 'Shared task budget no longer allows new calls')
      const existing = operationOf(entry, operationId)
      if (existing) {
        if (existing.argumentsHash !== argumentsHash) throw new AgentToolError('OPERATION_CONFLICT', 'operationId was already used with different generation arguments')
        result = structuredClone(existing)
        return
      }
      const consumed = new Set((entry.generationOperations ?? []).map((op) => op.reviewKey).filter(Boolean))
      const matchingReview = entry.reviews.find((candidate) =>
        candidate.status === 'approved'
        && specMatches(candidate.generationSpec, spec)
        && !consumed.has(`${candidate.reviewId}:${candidate.revision}`)
      )
      if (!matchingReview) throw new AgentToolError('GENERATION_REVIEW_REQUIRED', 'generation.request is not linked to an approved Host review')
      const reviewKey = `${matchingReview.reviewId}:${matchingReview.revision}`

      const ledger = spend ?? budget
      if (ledger.chargedMicros + ledger.reservedMicros + reservedMicros > ledger.maxCostMicros) throw new AgentToolError('BUDGET_EXCEEDED', 'Generation cost estimate exceeds the remaining limit')
      const now = this.now()
      result = {
        operationId,
        requestId: stableScopedId('generation', entry.taskId, operationId),
        argumentsHash,
        receiptId: stableScopedId('receipt', entry.taskId, operationId),
        status: 'reserved',
        modelId: model.id,
        catalogRevision: budget.catalogRevision,
        modelSnapshot: structuredClone(model),
        reservedMicros,
        reviewKey,
        createdAt: now,
        updatedAt: now,
      }
      entry.generationOperations ??= []
      entry.generationOperations.push(result)
      ledger.reservedMicros += reservedMicros
      budget.calls += 1
      if (spend) {
        spend.calls += 1
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.generationOperations)
      }
      created = true
    }, { type: 'generation.reserved', payload: { operationId, amountMicros: reservedMicros } })
    return { operation: result, created }
  }

  private async waitAndReconcile(taskId: string, operation: AgentGenerationOperation, model: CatalogModel, kind: 'image' | 'video' | 'audio'): Promise<ToolResult> {
    const timeout = kind === 'video' ? AGENT_GENERATION_VIDEO_TIMEOUT_MS : kind === 'audio' ? AGENT_GENERATION_AUDIO_TIMEOUT_MS : AGENT_GENERATION_IMAGE_TIMEOUT_MS
    const deadline = this.now() + timeout
    for (;;) {
      const job = await this.runner.get(operation.jobId!)
      if (!job) {
        await this.markFailure(taskId, operation.operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Durable generation job disappeared; resubmission is forbidden', retryable: true }, true)
        throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation operation outcome is unknown; resubmission is forbidden', true)
      }
      if (job.falRequestId && job.falRequestId !== operation.providerRequestId) {
        try {
          await this.options.journal.mutate(taskId, (entry) => {
            const current = operationOf(entry, operation.operationId)
            if (current && current.providerRequestId === operation.jobId) current.providerRequestId = job.falRequestId
            if (current) current.updatedAt = this.now()
          }, { type: 'generation.provider-request', payload: { operationId: operation.operationId, requestId: job.falRequestId } })
        } catch {
          await this.markFailure(taskId, operation.operationId, { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Could not save the fal generation request ID; resubmission is forbidden', retryable: true }, true)
          throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Could not save the fal generation request ID; resubmission is forbidden', true)
        }
      }
      if (job.status === 'done' && job.result) return this.reconcile(taskId, operation, model, kind, job)
      if (job.status === 'error' && job.result) return this.reconcile(taskId, operation, model, kind, job)
      if (job.status === 'error') {
        const paid = Boolean(job.falRequestId || job.paidResult || job.result?.url)
        const failure = { code: paid ? 'GENERATION_OUTCOME_UNCERTAIN' : 'GENERATION_FAILED', message: job.error ?? (paid ? 'Paid generation result was not confirmed' : 'Generation failed'), retryable: paid }
        await this.markFailure(taskId, operation.operationId, failure, paid)
        throw new AgentToolError(failure.code, failure.message, failure.retryable)
      }
      if (this.now() >= deadline) {
        const failure = { code: 'GENERATION_OUTCOME_UNCERTAIN', message: 'Generation did not finish in time; resubmission is forbidden', retryable: true }
        await this.markFailure(taskId, operation.operationId, failure, true)
        throw new AgentToolError(failure.code, failure.message, true)
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
  }

  /** Resume paths run outside the submit lease/catch block.  Normalize a
   * provider poll failure here so a restart never leaks a raw exception or
   * accidentally turns an unknown paid request into a new submit. */
  private async resumeAndReconcile(taskId: string, operation: AgentGenerationOperation, model: CatalogModel, kind: 'image' | 'video' | 'audio'): Promise<ToolResult> {
    try {
      return await this.waitAndReconcile(taskId, operation, model, kind)
    } catch (error) {
      const failure = errorOf(error)
      await this.markFailure(taskId, operation.operationId, failure, true).catch(() => undefined)
      throw error instanceof AgentToolError
        ? error
        : new AgentToolError(failure.code, failure.message, failure.retryable)
    }
  }

  private async reconcile(taskId: string, operation: AgentGenerationOperation, model: CatalogModel, kind: 'image' | 'video' | 'audio', job: AgentGenerationJob): Promise<ToolResult> {
    const task = await this.options.journal.get(taskId)
    if (!task) throw new AgentToolError('TASK_NOT_FOUND', 'Agent task not found')
    const artifact = await generatedArtifact(task, operation.operationId, kind, job.result!, this.mediaDir, model)
    const suppressCancelledPublication = task.state === 'cancelled'
    const actual = actualCostMicros(job, operation.reservedMicros)
    const settled = actual ?? operation.reservedMicros
    const resultPayload: Record<string, unknown> = {
      jobId: operation.jobId,
      requestId: operation.requestId,
      artifacts: [artifact],
      ...(actual === null ? {} : { charged: { currency: 'USD', amountMicros: actual } }),
    }
    const updated = await this.options.journal.mutate(taskId, (entry) => {
      const current = operationOf(entry, operation.operationId)
      const budget = entry.generationBudget
      if (!current || !budget) throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation ledger is missing during reconciliation', true)
      if (current.status === 'succeeded' && current.result) return
      current.status = 'succeeded'
      current.result = structuredClone(resultPayload)
      delete current.error
      current.updatedAt = this.now()
      // A late paid result still settles the durable ledger, but a terminally
      // cancelled task must not publish that result into its visible artifact
      // list or revive its output surface.
      if (!suppressCancelledPublication && entry.state !== 'cancelled' && !entry.artifacts.some((candidate) => candidate.artifactId === artifact.artifactId && candidate.revision === artifact.revision && candidate.checksum === artifact.checksum)) {
        entry.artifacts.push(structuredClone(artifact))
      }
      const spend = entry.spendBudget
      const ledger = spend ?? budget
      ledger.reservedMicros = Math.max(0, ledger.reservedMicros - current.reservedMicros)
      ledger.chargedMicros += settled
      ledger.overshootMicros = Math.max(0, ledger.chargedMicros - ledger.maxCostMicros)
      if (spend) {
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.generationOperations ?? [])
      }
    }, { type: 'generation.succeeded', payload: { operationId: operation.operationId, jobId: operation.jobId, ...(actual === null ? {} : { chargedMicros: actual }) } })
    const saved = operationOf(updated, operation.operationId)
    if (!saved?.result) throw new AgentToolError('GENERATION_OUTCOME_UNCERTAIN', 'Generation receipt was not saved', true)
    return { result: structuredClone(saved.result) }
  }

  private async markFailure(taskId: string, operationId: string, error: { code: string; message: string; retryable: boolean }, holdReservation: boolean, refundUnsubmittedCall = false): Promise<void> {
    await this.options.journal.mutate(taskId, (entry) => {
      const operation = operationOf(entry, operationId)
      const budget = entry.generationBudget
      if (!operation || !budget || operation.status === 'succeeded') return { changed: false }
      const canRefundCall = refundUnsubmittedCall && operation.status === 'reserved' && !operation.providerRequestId
      if (holdReservation && operation.status === 'uncertain') return { changed: false }
      operation.status = holdReservation ? 'uncertain' : 'failed'
      operation.error = error
      operation.updatedAt = this.now()
      const spend = entry.spendBudget
      const ledger = spend ?? budget
      if (!holdReservation) {
        ledger.reservedMicros = Math.max(0, ledger.reservedMicros - operation.reservedMicros)
        operation.reservedMicros = 0
        if (canRefundCall) {
          budget.calls = Math.max(0, budget.calls - 1)
          if (spend) spend.calls = Math.max(0, spend.calls - 1)
          delete operation.reviewKey
        }
      }
      if (spend) {
        spend.status = sharedSpendStatusFor(spend, [
          ...(entry.llmOperations ?? []),
          ...(entry.generationOperations ?? []),
        ])
        syncSpendBudget(entry)
      } else {
        budget.status = statusFor(budget, entry.generationOperations ?? [])
      }
    }, { type: holdReservation ? 'generation.uncertain' : 'generation.failed', payload: { operationId, code: error.code } })
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
