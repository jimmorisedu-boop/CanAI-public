import { config } from './config.js'
import {
  catalogDefinitionHash,
  catalogLibrary,
  catalogTariffHash,
  CatalogLibrary,
  CatalogLibraryError,
} from './catalogLibrary.js'
import { isPdfInputParamName, type CatalogModel } from './catalog.js'
import { jobs, JobStore, type Job } from './jobs.js'
import { persistAndEnqueueJob } from './runner.js'
import { loadSettings } from './settings.js'
import type { IncomingRef } from './refs.js'
import type { GenerationRoute } from './generationGate.js'
import { paramValueAllowed } from '../../packages/model-catalog/macroModels.js'
import { parameterActive } from '../../packages/model-catalog/parameterRules.js'

export interface DraftTestQuote {
  amountUsd: number
  requiresConfirmation: boolean
  definitionHash: string
  tariffHash: string
}

export interface DraftTestStatus {
  jobId: string
  status: Job['status']
  result?: Job['result']
  error?: string
  actualCostUsd: number | null
}

export class CatalogDraftTestError extends CatalogLibraryError {}

function durationUnits(model: CatalogModel, params: Record<string, unknown>): number {
  const spec = (model.params ?? []).find(item => item.name === 'duration')
  for (const candidate of [params.duration, spec?.default]) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0) return value
  }
  return model.pricing?.defaultDuration ?? 8
}

function mediaCost(model: CatalogModel, params: Record<string, unknown>, referenceCount: number): number {
  if (!model.pricing) throw new CatalogDraftTestError('Confirm the model pricing first')
  let rate = model.pricing.usd
  const matrix = model.pricing.byParams
  const matrixKey = matrix?.names.map(name => {
    const spec = (model.params ?? []).find(item => item.name === name)
    return String(params[name] ?? spec?.default ?? '')
  }).join('|')
  const matrixRate = matrixKey ? matrix?.usd[matrixKey] : undefined
  if (matrixRate !== undefined) rate = matrixRate
  else if (model.pricing.byParam) {
    const table = model.pricing.byParam
    const spec = (model.params ?? []).find(item => item.name === table.name)
    const selected = params[table.name] ?? spec?.default
    const selectedRate = selected === undefined ? undefined : table.usd[String(selected)]
    if (selectedRate !== undefined) rate = selectedRate
  }
  const units = model.pricing.unit === 'second' ? durationUnits(model, params) : 1
  const references = referenceCount * (model.pricing.perReferenceUsd ?? 0)
    + Math.max(0, referenceCount - 1) * (model.pricing.additionalReferenceUsd ?? 0)
  return rate * units + references
}

function textCost(model: CatalogModel): number {
  if (model.pricing?.unit === 'call') return model.pricing.usd
  if (!model.textPricing) throw new CatalogDraftTestError('Confirm the model pricing first')
  return (model.textPricing.inputPerMillion + model.textPricing.outputPerMillion) / 1_000
}

export function quoteDraftTest(
  draft: CatalogModel,
  params: Record<string, unknown>,
  confirmCostAboveUsd = 1,
  referenceCount = 0,
): DraftTestQuote {
  const raw = draft.kind === 'text' ? textCost(draft) : mediaCost(draft, params, referenceCount)
  if (!Number.isFinite(raw) || raw <= 0) throw new CatalogDraftTestError('Invalid model pricing')
  const amountUsd = Math.round(raw * 1_000_000) / 1_000_000
  return {
    amountUsd,
    requiresConfirmation: amountUsd >= confirmCostAboveUsd,
    definitionHash: catalogDefinitionHash(draft),
    tariffHash: catalogTariffHash(draft),
  }
}

function validateParams(draft: CatalogModel, params: Record<string, unknown>): void {
  const modelParams = draft.params ?? []
  const specs = new Map(modelParams.map(spec => [spec.name, spec]))
  for (const [name, value] of Object.entries(params)) {
    const spec = specs.get(name)
    if (!spec || !parameterActive(spec, modelParams, params) || !paramValueAllowed(spec, value)) {
      throw new CatalogDraftTestError(`Parameter “${name}” does not match the model schema`)
    }
  }
}

function validateRefs(draft: CatalogModel, refs: IncomingRef[], params: Record<string, unknown>): void {
  const images = refs.filter(ref => ref.kind === 'image').length
  const videos = refs.filter(ref => ref.kind === 'video').length
  const audios = refs.filter(ref => ref.kind === 'audio').length
  if (images < (draft.minImageRefs ?? 0)) throw new CatalogDraftTestError(`Model “${draft.name}” requires an image`)
  if (videos < (draft.minVideoRefs ?? 0)) throw new CatalogDraftTestError(`Model “${draft.name}” requires video`)
  if (audios < (draft.minAudioRefs ?? 0)) throw new CatalogDraftTestError(`Model “${draft.name}” requires audio selection`)
  if (images > (draft.maxImageRefs ?? 0)) throw new CatalogDraftTestError(`Model «${draft.name}” does not accept this many images`)
  if (videos > (draft.maxVideoRefs ?? 0)) throw new CatalogDraftTestError(`Model «${draft.name}” does not accept this many videos`)
  if (audios > (draft.maxAudioRefs ?? 0)) throw new CatalogDraftTestError(`Model «${draft.name}” does not accept this many audio files`)
  if (images + videos + audios > (draft.maxTotalRefs ?? 16)) throw new CatalogDraftTestError(`Model “${draft.name}” has too many references`)
  if (audios > 0 && draft.audioRequiresVisualRef && images + videos === 0) {
    throw new CatalogDraftTestError(`Model “${draft.name}” requires an image or video with audio`)
  }
  if (draft.conditionalReferenceRequirement === 'image-or-video-or-pdf') {
    const hasPdf = Object.entries(params).some(([name, value]) => (
      isPdfInputParamName(name) && typeof value === 'string' && Boolean(value.trim())
    ))
    if (images + videos === 0 && !hasPdf) {
      throw new CatalogDraftTestError(`Model “${draft.name}”; add an image, video, or PDF`)
    }
  }
}

function validateRefsShape(value: IncomingRef[]): void {
  if (!Array.isArray(value) || value.some(ref => {
    if (!ref || typeof ref !== 'object') return true
    if (ref.kind === 'text') return typeof ref.text !== 'string'
    return !['image', 'video', 'audio'].includes(ref.kind) || typeof ref.src !== 'string'
  })) throw new CatalogDraftTestError('References have an invalid format')
}

interface DraftTestDependencies {
  getConfirmCostAboveUsd(): Promise<number>
  generationRoute(): GenerationRoute
  persistAndEnqueue(job: Job): Promise<void>
}

export class CatalogDraftTestService {
  private readonly inFlightStarts = new Map<string, Promise<Job>>()

  constructor(
    private readonly library: CatalogLibrary,
    private readonly store: JobStore,
    private readonly dependencies: DraftTestDependencies,
  ) {}

  private draft(id: string): CatalogModel {
    const draft = this.library.view().drafts.find(model => model.id === id)
    if (!draft) throw new CatalogDraftTestError('Model draft not found', 404)
    return draft
  }

  private async startOnce(input: {
    draftId: string
    prompt: string
    refs: IncomingRef[]
    params: Record<string, unknown>
    idempotencyKey: string
    confirmedAmountUsd?: number
  }): Promise<Job> {
    const repeated = this.store.all().find(job => (
      job.catalogDraftTest?.draftId === input.draftId
      && job.catalogDraftTest.idempotencyKey === input.idempotencyKey
    ))
    if (repeated) return repeated
    const draft = this.draft(input.draftId)
    if (typeof input.prompt !== 'string' || input.prompt.length > 200_000
      || draft.promptInputField !== null && !input.prompt.trim()) {
      throw new CatalogDraftTestError('Provide a test prompt')
    }
    const quote = await this.quote(draft.id, input.params, input.refs)
    if (quote.requiresConfirmation && (
      input.confirmedAmountUsd === undefined || input.confirmedAmountUsd + 1e-9 < quote.amountUsd
    )) throw new CatalogDraftTestError(`Confirm the paid test for $${quote.amountUsd.toFixed(3)}`, 409)

    const job = this.store.create(draft.kind, input.prompt.trim(), structuredClone(input.refs), draft.id, structuredClone(input.params))
    job.generationRoute = this.dependencies.generationRoute()
    job.modelSnapshot = structuredClone(draft)
    job.catalogDraftTest = {
      draftId: draft.id,
      definitionHash: quote.definitionHash,
      tariffHash: quote.tariffHash,
      idempotencyKey: input.idempotencyKey,
    }
    try {
      await this.dependencies.persistAndEnqueue(job)
      return job
    } catch (error) {
      this.store.remove(job.id)
      throw error
    }
  }

  async quote(draftId: string, params: Record<string, unknown>, refs: IncomingRef[]): Promise<DraftTestQuote> {
    const draft = this.draft(draftId)
    validateRefsShape(refs)
    validateParams(draft, params)
    validateRefs(draft, refs, params)
    const quote = quoteDraftTest(
      draft,
      params,
      await this.dependencies.getConfirmCostAboveUsd(),
      refs.filter(ref => ref.kind !== 'text').length,
    )
    const meta = this.library.view().draftMeta[draft.id]
    if (!meta?.tariffConfirmedAt || meta.definitionHash !== quote.definitionHash || meta.tariffHash !== quote.tariffHash) {
      throw new CatalogDraftTestError('Confirm the current model pricing first', 409)
    }
    return quote
  }

  async start(input: {
    draftId: string
    prompt: string
    refs: IncomingRef[]
    params: Record<string, unknown>
    idempotencyKey: string
    confirmedAmountUsd?: number
  }): Promise<Job> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.draftId)) throw new CatalogDraftTestError('Invalid draft ID')
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 160) {
      throw new CatalogDraftTestError('Invalid test run key')
    }
    const key = `${input.draftId}\u0000${input.idempotencyKey}`
    const pending = this.inFlightStarts.get(key)
    if (pending) return pending
    const repeated = this.store.all().find(job => (
      job.catalogDraftTest?.draftId === input.draftId
      && job.catalogDraftTest.idempotencyKey === input.idempotencyKey
    ))
    if (repeated) return repeated
    const started = this.startOnce(input)
    this.inFlightStarts.set(key, started)
    const cleanup = () => {
      if (this.inFlightStarts.get(key) === started) this.inFlightStarts.delete(key)
    }
    started.then(cleanup, cleanup)
    return started
  }

  async status(draftId: string, jobId: string): Promise<DraftTestStatus> {
    const job = this.store.get(jobId)
    if (!job || job.catalogDraftTest?.draftId !== draftId) throw new CatalogDraftTestError('Test job not found', 404)
    if (job.status === 'done' && job.result) {
      const resultKind = job.kind === 'other'
        ? job.result.text !== undefined
          ? 'text'
          : job.result.mime?.startsWith('video/')
            ? 'video'
            : job.result.mime?.startsWith('audio/')
              ? 'audio'
              : 'image'
        : job.kind
      await this.library.recordDraftTest(draftId, {
        jobId: job.id,
        completedAt: job.finishedAt ?? Date.now(),
        resultKind,
        actualCostUsd: job.chargedAmountUsd ?? null,
        definitionHash: job.catalogDraftTest.definitionHash,
        tariffHash: job.catalogDraftTest.tariffHash,
      })
    }
    return {
      jobId: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
      actualCostUsd: job.chargedAmountUsd ?? null,
    }
  }
}

export const catalogDraftTestService = new CatalogDraftTestService(catalogLibrary, jobs, {
  getConfirmCostAboveUsd: async () => (await loadSettings()).confirmCostAboveUsd,
  generationRoute: () => config.mockMode ? 'mock' : 'local',
  persistAndEnqueue: persistAndEnqueueJob,
})
