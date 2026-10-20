import { useEffect, useRef } from 'react'
import { api, type GenerationSubmitOptions } from '../../api'
import { log } from '../../diag/log'
import type { GenRef, GenerationQuote, Job, JobKind, ProjectSource } from '../../types'
import { registerGenerationSink, trackGeneration, getGenerationTasks } from './generationRegistry'
import { createGenerationTarget, type GenerationLaunchMeta } from './generationLaunches'
import type { CanvasSettleContext } from './canvasGenerationSettle'
import { askConfirm } from '../../ui/confirmBus'
import { newId } from '../../ui/ids'
import { formatExactUsd } from '../../ui/money'
import {
  aggregateQuoteNeedsConfirmation,
  isFalMeteredQuote,
  isUncappedMeteredQuote,
  quoteConfirmationRequest,
} from '../../ui/quotePresentation'
import type { GenerationConsentInput } from './agents/agentGenerationConsentModel'
import { generationReviewRows } from './generationReviewRows'

export interface GenerationPreparation {
  options: GenerationSubmitOptions
  quote?: GenerationQuote
  /**
   * Exact immutable input of the paid run. The review dialog shows only its
   * prompt: ids, params and catalog revisions are not for people.
   */
  consent?: GenerationConsentInput
}

/**
 * Prepare one generation without depending on React.  The canvas hook delegates
 * here so a caller that already reserved a real placeholder can keep the
 * quote's idempotency key and hash all the way through submit.
 */
export async function prepareGeneration(
  projectId: string,
  projectSource: ProjectSource,
  kind: JobKind,
  prompt: string,
  refs: GenRef[],
  model: string | undefined,
  params: Record<string, unknown> | undefined,
  placeholderId: string | undefined,
  consent?: GenerationConsentInput,
): Promise<GenerationPreparation> {
  const target = placeholderId
    ? createGenerationTarget({ source: projectSource, id: projectId }, placeholderId)
    : undefined
  const idempotencyKey = newId()
  const preparation: GenerationPreparation = {
    options: { idempotencyKey },
    ...(consent ? { consent: structuredClone(consent) } : {}),
  }
  if (projectSource === 'cloud' && target && model) {
    const response = await api.quoteGeneration(kind, prompt, refs, model, params, target, idempotencyKey)
    if (response.quote) {
      validateQuote(response.quote)
      preparation.quote = response.quote
      preparation.options = {
        idempotencyKey,
        quoteId: response.quote.id,
        quoteHash: response.quote.requestHash,
        // Low-cost quotes are accepted without a dialog. High-cost quotes
        // are marked confirmed by approvePreparedGenerationQuotes.
        quoteConfirmed: !response.quote.needsConfirmation,
      }
    }
  }
  return preparation
}

/** Submit an already prepared request and bind result delivery to its actual slot. */
export async function startPreparedGeneration(input: {
  projectId: string
  projectSource: ProjectSource
  kind: JobKind
  prompt: string
  refs: GenRef[]
  model?: string
  params?: Record<string, unknown>
  launch?: GenerationLaunchMeta
  placeholderId?: string
  preparation: GenerationPreparation
}): Promise<string> {
  const target = input.placeholderId
    ? createGenerationTarget({ source: input.projectSource, id: input.projectId }, input.placeholderId)
    : undefined
  const { jobId } = await api.generate(
    input.kind,
    input.prompt,
    input.refs,
    input.model,
    input.params,
    target,
    input.preparation.options,
  )
  trackGeneration(
    { kind: 'canvas', projectId: input.projectId, ...(input.placeholderId ? { placeholderId: input.placeholderId } : {}) },
    jobId,
    input.kind,
    {
      kind: input.kind,
      prompt: input.prompt,
      refs: structuredClone(input.refs),
      model: input.model,
      params: input.params ? structuredClone(input.params) : undefined,
      projectRef: { source: input.projectSource, id: input.projectId },
    },
    input.launch,
  )
  return jobId
}

function validateQuote(quote: GenerationQuote): void {
  if (
    typeof quote.id !== 'string' || !quote.id
    || typeof quote.requestHash !== 'string' || !quote.requestHash
    || typeof quote.amountMicro !== 'number' || !Number.isSafeInteger(quote.amountMicro) || quote.amountMicro < 0
    || typeof quote.amountUsd !== 'number' || !Number.isFinite(quote.amountUsd) || quote.amountUsd < 0
    || typeof quote.needsConfirmation !== 'boolean'
    || (quote.confirmAboveMicro !== undefined && (
      typeof quote.confirmAboveMicro !== 'number'
      || !Number.isSafeInteger(quote.confirmAboveMicro)
      || quote.confirmAboveMicro < 0
    ))
  ) throw new Error("The server returned an incorrect quote")
}

export async function approvePreparedGenerationQuotes(
  prepared: Array<{ variant: GenerationLaunchMeta; slotId: string; value: unknown }>,
): Promise<boolean> {
  const rows = prepared.flatMap((entry) => {
    const value = entry.value as GenerationPreparation
    return value.quote ? [{ variant: entry.variant, quote: value.quote, preparation: value }] : []
  })
  const total = rows.reduce((sum, row) => sum + row.quote.amountUsd, 0)
  const totalQuantity = rows.reduce((sum, row) => (
    sum + (Number.isSafeInteger(row.quote.quantity) && row.quote.quantity > 0 ? row.quote.quantity : 1)
  ), 0)
  // The server owns the confirmation policy. For a prepared series, newer
  // servers expose the team threshold on every quote so the aggregate total is
  // checked once; an explicit zero disables that aggregate check. Older servers
  // omit the field, so retain the historical batch confirmation fallback.
  const aggregateNeedsConfirmation = aggregateQuoteNeedsConfirmation(rows.map((row) => row.quote))
  // A single quote also needs a dialog when its exact preflight amount differs
  // from the estimate shown beside the Create button; otherwise the user would
  // silently accept a different amount than the one they saw.
  const estimated = rows[0]?.variant.estimatedTotalCostUsd
  const displayedEstimate = estimated == null ? null : formatExactUsd(estimated)
  const exactTotal = formatExactUsd(total)
  const amountChanged = displayedEstimate != null && displayedEstimate !== exactTotal
  const confirmationRequired = rows.some((row) => row.quote.needsConfirmation)
    || aggregateNeedsConfirmation
    || amountChanged
  if (!confirmationRequired) return true
  const cappedMetered = rows.some((row) => isFalMeteredQuote(row.quote))
  const uncappedMetered = rows.some((row) => isUncappedMeteredQuote(row.quote))
  const metered = cappedMetered || uncappedMetered
  const mixedPricing = metered && rows.some((row) => (
    row.quote.pricingMode !== 'fal-metered' || (cappedMetered && uncappedMetered)
  ))
  const sharedRequest = quoteConfirmationRequest({
    amountUsd: total,
    quantity: metered ? (totalQuantity || rows.length) : rows.length,
    model: rows[0]?.variant.modelName,
    pricingMode: metered ? 'fal-metered' : undefined,
    guaranteed: cappedMetered && !uncappedMetered,
    meteredUncapped: uncappedMetered,
    mixedPricing,
    quantityLabel: "Tasks",
  })
  // Keep the existing fixed-price dialog byte-for-byte familiar. Metered
  // quotes already show their ceiling in the amount row and explain the
  // reservation/settlement lifecycle in the shared detail text.
  const request = metered
    ? sharedRequest
    : { ...sharedRequest, rows: [...(sharedRequest.rows ?? []), ["Total", exactTotal] as [string, string]] }
  request.rows = generationReviewRows(request.rows ?? [], {
    prompts: rows.map((row) => row.preparation.consent?.prompt ?? row.variant.promptPreview),
    shownEstimate: amountChanged ? displayedEstimate : null,
  })
  const ok = await askConfirm(request)
  if (ok) {
    for (const row of rows) row.preparation.options.quoteConfirmed = true
  }
  return ok
}

// Тонкая обвязка над generationRegistry: стартует задачу и подписывает доску
// на результаты. Сам опрос живёт в реестре (модуль) — переживает смену доски,
// припаркованные результаты доезжают при следующем открытии этой доски.
// ВАЖНО: подписка — только когда доска ЗАГРУЖЕНА (ready): доставка результата
// в ещё пустой стор делала его «непустым», loadDoc пропускался, и на холсте
// оставался один свежий результат вместо всей доски.
export function useGeneration(
  projectId: string,
  ready: boolean,
  onSettled: (job: Job, context: CanvasSettleContext) => void,
  projectSource: ProjectSource = 'local',
) {
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  useEffect(() => {
    if (!ready) return
    return registerGenerationSink('canvas', projectId, (job, target) => {
      const task = getGenerationTasks().find((t) => t.jobId === job.id)
      if (task?.launch?.launchId.startsWith('macro:')) return
      onSettledRef.current(job, {
        placeholderId: target.kind === 'canvas' ? target.placeholderId : undefined,
        prompt: task?.retry?.prompt,
        modelId: task?.launch?.modelId ?? task?.retry?.model,
      })
    })
  }, [projectId, ready])

  async function prepare(
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model: string | undefined,
    params: Record<string, unknown> | undefined,
    placeholderId: string | undefined,
    consent?: GenerationConsentInput,
  ): Promise<GenerationPreparation> {
    return prepareGeneration(
      projectId,
      projectSource,
      kind,
      prompt,
      refs,
      model,
      params,
      placeholderId,
      consent,
    )
  }

  // возвращает jobId — вызывающий связывает его с заглушкой на канвасе
  async function start(
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model?: string,
    params?: Record<string, unknown>,
    launch?: GenerationLaunchMeta,
    placeholderId?: string,
    prepared?: GenerationPreparation,
  ): Promise<string> {
    log.info('gen', "I start generation", {
      board: projectId,
      boardView: projectSource,
      kind,
      model,
      references: refs.length,
      referenceKinds: refs.map((ref) => ref.kind),
      placeholder: placeholderId,
      prompt,
    })
    const ownPreparation = prepared ?? await prepare(kind, prompt, refs, model, params, placeholderId)
    if (!prepared && ownPreparation.quote) {
      const singleLaunch = launch ?? {
        launchId: `single:${ownPreparation.options.idempotencyKey}`,
        variantIndex: 1,
        variantCount: 1,
        projectId,
        promptPreview: prompt.slice(0, 120),
        modelId: model,
        modelName: model ?? "model",
        createdAt: Date.now(),
      }
      if (!await approvePreparedGenerationQuotes([{ variant: singleLaunch, slotId: placeholderId ?? '', value: ownPreparation }])) {
        throw new Error("Run cancelled.")
      }
    }
    const jobId = await startPreparedGeneration({
      projectId,
      projectSource,
      kind,
      prompt,
      refs,
      model,
      params,
      launch,
      placeholderId,
      preparation: ownPreparation,
    })
    log.info('gen', "task started", { board: projectId, boardView: projectSource, jobId, placeholder: placeholderId })
    return jobId
  }

  return { start, prepare, approvePreparedGenerationQuotes }
}
