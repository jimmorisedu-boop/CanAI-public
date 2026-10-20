import crypto from 'node:crypto'
import type {
  AgentArtifact,
  AgentArtifactRef,
  AgentGenerationReviewSpec,
} from '../../../packages/agent-protocol/index.js'
import { parameterActive } from '../../../packages/model-catalog/parameterRules.js'
import { paramValueAllowed } from '../../../packages/model-catalog/macroModels.js'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { mediaLaunchUsd, type CostInputs } from '../../../packages/model-catalog/mediaCost.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolError } from './tool-shared.js'

export const MAX_REFS = 16
export const MAX_PARAMS_BYTES = 32_000

export interface AgentGenerationCatalogSource {
  models(): CatalogModel[]
  view(): { revision: number }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

export function errorOf(error: unknown, fallbackCode = 'GENERATION_OUTCOME_UNCERTAIN'): { code: string; message: string; retryable: boolean } {
  if (error instanceof AgentToolError) return { code: error.code, message: error.message, retryable: error.retryable }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function sameRef(left: AgentArtifactRef, right: AgentArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.revision === right.revision && left.checksum === right.checksum
}

export function sameRefs(left: AgentArtifactRef[], right: AgentArtifactRef[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameRef(entry, right[index]!))
}

export function validateArtifactRefs(value: unknown): AgentArtifactRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new AgentToolError('INPUT_INVALID', 'generation.request.refs has an invalid size')
  const refs = value.map((raw, index) => {
    if (!isRecord(raw)
      || typeof raw.artifactId !== 'string' || !raw.artifactId.trim()
      || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
      || typeof raw.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.checksum)) {
      throw new AgentToolError('INPUT_INVALID', `generation.request.refs[${index}] has an invalid format`)
    }
    return { artifactId: raw.artifactId, revision: Number(raw.revision), checksum: raw.checksum }
  })
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = `${ref.artifactId}:${ref.revision}:${ref.checksum}`
    if (seen.has(key)) throw new AgentToolError('INPUT_INVALID', 'generation.request.refs must not contain duplicates')
    seen.add(key)
  }
  return refs
}

export function validateParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PARAMS_BYTES) {
    throw new AgentToolError('INPUT_INVALID', 'generation.request.params has an invalid size')
  }
  return structuredClone(value)
}

export function modelFor(catalog: AgentGenerationCatalogSource, modelId: string, kind: 'image' | 'video' | 'audio'): CatalogModel {
  const model = catalog.models().find((candidate) => candidate.id === modelId)
  if (!model || model.lifecycle !== 'active' || model.kind !== kind) throw new AgentToolError('GENERATION_MODEL_UNSUPPORTED', 'Generation model does not match the pinned catalog')
  if (typeof model.endpoint !== 'string' || !model.endpoint.trim() || model.endpoint.includes('://')) {
    throw new AgentToolError('GENERATION_MODEL_UNSUPPORTED', 'Agent Host allows only a catalog media endpoint')
  }
  if (!model.pricing || !Number.isFinite(model.pricing.usd) || model.pricing.usd <= 0) {
    throw new AgentToolError('GENERATION_COST_INVALID', 'Media model has no verified price')
  }
  return structuredClone(model)
}

export function modelParamCheck(model: CatalogModel, params: Record<string, unknown>): void {
  const specs = model.params ?? []
  const known = new Map(specs.map((spec) => [spec.name, spec]))
  for (const [name, value] of Object.entries(params)) {
    const spec = known.get(name)
    if (!spec || !parameterActive(spec, specs, params) || !paramValueAllowed(spec, value)) {
      throw new AgentToolError('GENERATION_PARAMS_INVALID', `Parameter ${name} does not match the pinned model`)
    }
  }
  if (typeof params.num_images === 'number' && params.num_images !== 1) {
    throw new AgentToolError('GENERATION_MULTI_RESULT_UNSUPPORTED', 'The first Agent generation slice accepts exactly one result')
  }
}

function referenceKinds(refs: AgentArtifact[]): { image: number; video: number; audio: number } {
  return {
    image: refs.filter((ref) => ref.kind === 'image').length,
    video: refs.filter((ref) => ref.kind === 'video').length,
    audio: refs.filter((ref) => ref.kind === 'audio').length,
  }
}

export function validateModelRefs(model: CatalogModel, refs: AgentArtifact[]): void {
  const counts = referenceKinds(refs)
  const total = refs.length
  if (!model.refs && total > 0) throw new AgentToolError('GENERATION_REFS_UNSUPPORTED', 'Pinned model does not accept media refs')
  if (model.maxTotalRefs !== undefined && total > model.maxTotalRefs) throw new AgentToolError('GENERATION_REFS_INVALID', 'Too many refs for the pinned model')
  for (const kind of ['image', 'video', 'audio'] as const) {
    const value = counts[kind]
    const min = model[`min${kind[0].toUpperCase()}${kind.slice(1)}Refs` as 'minImageRefs' | 'minVideoRefs' | 'minAudioRefs']
    const max = model[`max${kind[0].toUpperCase()}${kind.slice(1)}Refs` as 'maxImageRefs' | 'maxVideoRefs' | 'maxAudioRefs']
    if (min !== undefined && value < min) throw new AgentToolError('GENERATION_REFS_INVALID', `Pinned model requires at least ${min} ${kind} refs`)
    if (max !== undefined && value > max) throw new AgentToolError('GENERATION_REFS_INVALID', `Pinned model accepts at most ${max} ${kind} refs`)
  }
  if (model.inputModalities && refs.some((ref) => !model.inputModalities!.includes(ref.kind as 'image' | 'video' | 'audio'))) {
    throw new AgentToolError('GENERATION_REFS_INVALID', 'Ref type is not in the pinned model inputModalities')
  }
}

/** Самая крупная по площади картинка среди референсов — по ней считается апскейл. */
function largestImageArtifact(refs: AgentArtifact[]): CostInputs['inputImage'] {
  let largest: CostInputs['inputImage']
  for (const ref of refs) {
    if (ref.kind !== 'image' || !ref.width || !ref.height) continue
    if (!largest || ref.width * ref.height > largest.width * largest.height) largest = { width: ref.width, height: ref.height }
  }
  return largest
}

/**
 * Оценка агентской генерации в микродолларах — по тем же правилам, что кнопка
 * «Создать» (`mediaLaunchUsd` в общем модуле каталога), с округлением ВВЕРХ.
 *
 * ⚠️ Число — часть контракта одобрения: человек видит его в ревью, и
 * `specMatches` сверяет его с пересчитанным СТРОГО на равенство. Поэтому:
 * - `prompt` передаёт только тот, кто его знает (`computeGenerationSpec`).
 *   Грант Creator (`generationGrantSpec` в tools.ts) считает без промпта, а
 *   Creator отдаёт это число в ревью как есть, и запрос потом пересчитывает
 *   его уже с промптом — значит у модели, где цена зависит от длины текста,
 *   два числа не совпали бы никогда. Такая модель без промпта получает отказ,
 *   а не потолок: потолок у Creator тоже разошёлся бы с запросом. Сегодня до
 *   этого не доходит — Creator берёт только картинки и видео (index.mjs).
 * - Смена формулы делает неиспользованные одобрения прежней формулы
 *   недействительными: `reviewFor` откажет ДО резерва, деньги не тронуты, и
 *   человек одобрит заново уже верную сумму. Версии у оценки нет намеренно:
 *   держать прежнюю формулу ради старых одобрений значит держать и её
 *   занижения (видео без длительности считалось за 1 секунду). Оплаченную
 *   работу в пути это не задевает: восстановление (`recoverPersisted`,
 *   `resumeAndReconcile`) идёт по сохранённому резерву и оценку не считает.
 * - Чего не знаем (длина текста, размер входа) — отказ словами, не догадка:
 *   занизить хуже, чем завысить.
 */
export function estimateMicros(model: CatalogModel, params: Record<string, unknown>, refs: AgentArtifact[], prompt?: string): number {
  if (model.pricing?.perPromptChars != null && prompt === undefined) {
    throw new AgentToolError('GENERATION_COST_INVALID', 'The price of this model depends on the prompt length and cannot be pinned before the prompt is known')
  }
  const inputImage = largestImageArtifact(refs)
  const amount = mediaLaunchUsd(model, params, refs.length, {
    ...(prompt !== undefined ? { promptChars: prompt.length } : {}),
    ...(inputImage ? { inputImage } : {}),
  })
  if (amount == null) throw new AgentToolError('GENERATION_COST_INVALID', 'Could not calculate the generation price for these inputs')
  // Вверх — до целого микродоллара, но без шума плавающей точки: 0.05 × 3 даёт
  // 0.15000000000000002, и без поправки $0.15 превращались бы в 150 001.
  // Поправка в миллионную долю микродоллара настоящую долю не съест никогда.
  const micros = Math.ceil(amount * 1_000_000 - 1e-6)
  if (!Number.isSafeInteger(micros) || micros < 1) throw new AgentToolError('GENERATION_COST_INVALID', 'Could not calculate a positive generation estimate')
  return micros
}

export function specMatches(spec: AgentGenerationReviewSpec | undefined, expected: AgentGenerationReviewSpec): boolean {
  // Hash-only legacy reviews remain readable in the journal, but cannot grant
  // a new paid request: approval must carry the exact human-visible echo.
  if (!spec
    || typeof spec.prompt !== 'string'
    || !isRecord(spec.params)
    || typeof spec.estimateMicros !== 'number'
    || !Number.isSafeInteger(spec.estimateMicros)
    || spec.estimateMicros < 1
    || typeof expected.prompt !== 'string'
    || !isRecord(expected.params)
    || !Number.isSafeInteger(expected.estimateMicros)) return false
  return Boolean(
    spec.kind === expected.kind
    && spec.modelId === expected.modelId
    && spec.catalogRevision === expected.catalogRevision
    && spec.promptHash === expected.promptHash
    && spec.paramsHash === expected.paramsHash
    && sameRefs(spec.refs, expected.refs)
    && spec.prompt === expected.prompt
    && spec.promptHash === digest(spec.prompt)
    && digest(spec.params) === digest(expected.params)
    && spec.paramsHash === digest(spec.params)
    && spec.estimateMicros === expected.estimateMicros)
}

export function isEligibleRef(task: AgentTaskRecord, budget: AgentTaskRecord['generationBudget'], ref: AgentArtifactRef): boolean {
  if (!budget) return false
  if (budget.artifactRefs?.some((consented) => sameRef(consented, ref))) {
    return true
  }
  if (budget.pins?.length) {
    const artifact = task.artifacts.find((candidate) => sameRef(candidate, ref))
    if (!artifact || artifact.provenance !== 'generated') return false
    if (artifact.kind !== 'image' && artifact.kind !== 'video' && artifact.kind !== 'audio') return false
    const operation = task.generationOperations?.find((op) =>
      op.status === 'succeeded'
      && op.result
      && Array.isArray((op.result as { artifacts?: unknown[] }).artifacts)
      && (op.result as { artifacts: AgentArtifact[] }).artifacts.some((a) => sameRef(a, ref))
    )
    if (!operation) return false
    const resultReviews = task.reviews.filter((review) =>
      review.materials?.some((material) => material.role === 'result' && sameRef(material, ref))
    )
    if (resultReviews.length === 0) return false
    const latestReview = resultReviews[resultReviews.length - 1]
    return latestReview.status === 'approved'
  }
  return false
}

export function reviewFor(task: AgentTaskRecord, expected: AgentGenerationReviewSpec): AgentTaskRecord['reviews'][number] {
  const consumed = new Set((task.generationOperations ?? []).map((op) => op.reviewKey).filter(Boolean))
  const review = task.reviews.find((candidate) =>
    candidate.status === 'approved'
    && specMatches(candidate.generationSpec, expected)
    && !consumed.has(`${candidate.reviewId}:${candidate.revision}`)
  )
  if (!review) throw new AgentToolError('GENERATION_REVIEW_REQUIRED', 'generation.request is not linked to an approved Host review')
  return review
}

export function artifactForRef(task: AgentTaskRecord, ref: AgentArtifactRef): AgentArtifact {
  const artifact = task.artifacts.find((candidate) => candidate.artifactId === ref.artifactId && candidate.revision === ref.revision && candidate.checksum === ref.checksum)
  if (!artifact) throw new AgentToolError('REF_NOT_AVAILABLE', 'generation.request contains an unknown artifact ref')
  if (artifact.kind !== 'image' && artifact.kind !== 'video' && artifact.kind !== 'audio') {
    throw new AgentToolError('REF_NOT_MEDIA', 'generation.request accepts only media refs')
  }
  if (!artifact.mediaSrc.startsWith('/media/')) throw new AgentToolError('REF_NOT_AVAILABLE', 'Media ref is not materialized in native storage')
  return artifact
}

