/**
 * Pure client-side scope for a paid generation permission.
 *
 * This is deliberately not the wire DTO.  The Host/Cloud side owns the grant
 * id and the final budget decision; the browser only remembers exactly what
 * the person saw and approved.  Keeping the scope here gives both desktop and
 * tablet one regression-tested rule while the shared protocol is evolving.
 */

export type GenerationConsentKind = 'image' | 'video' | 'audio'
export type GenerationConsentMode = 'each' | 'together'

export interface GenerationConsentRef {
  kind: 'image' | 'video' | 'audio' | 'text'
  /** Stable board/asset identity, never an array index alone. */
  identity: string
  revision?: number | string | null
  checksum?: string | null
  /** Kept for the review receipt; not used as a source of authority. */
  label?: string | null
}

export interface GenerationConsentInput {
  projectRef: { source: 'local' | 'cloud'; id: string }
  kind: GenerationConsentKind
  modelId: string | null
  /** Catalog pin may be numeric or a server-defined revision string. */
  catalogRevision: number | string | null
  prompt: string
  /** Order is significant: @1/@2 and each-mode groups must not be reordered. */
  orderedRefs: readonly GenerationConsentRef[]
  params: Record<string, unknown>
  mode: GenerationConsentMode
  /** Number of paid attempts represented by this review. */
  attempts: number
  /** A single attempt is always maxCalls=1; a series has one entry per attempt. */
  maxCalls: number
  mediaTransferRequired: boolean
  mediaTransferConsent: boolean
  /** USD micros, when a server/catalog estimate is available. */
  estimatedCostMicros: number | null
  /** Optional helper text preparation identity. */
  textPreparation?: {
    assistantId: string
    versionId?: string | null
  } | null
}

export interface GenerationConsentDraft {
  granted: boolean
  scope: string | null
  version: number
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
  )
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function micros(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function usdToMicros(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null
  const result = Math.round(value * 1_000_000)
  return Number.isSafeInteger(result) ? result : null
}

/**
 * Convert a selection/reference-like value into the stable, ordered input
 * shape used by the consent scope.  The source is included in the identity so
 * replacing a file behind the same board card cannot reuse consent.
 */
export function freezeGenerationConsentRefs(
  refs: ReadonlyArray<{
    kind: GenerationConsentRef['kind']
    shapeId?: string
    assetId?: string
    src?: string
    text?: string
    label?: string
    revision?: number | string | null
    checksum?: string | null
  }>,
): GenerationConsentRef[] {
  return refs.map((ref, index) => ({
    kind: ref.kind,
    identity: ref.assetId
      ? `asset:${ref.assetId}:${ref.src ?? ''}`
      : ref.shapeId
        ? `shape:${ref.shapeId}:${ref.src ?? ref.text ?? ''}`
        : `${ref.kind}:${ref.src ?? ref.text ?? index}`,
    ...(ref.revision !== undefined ? { revision: ref.revision } : {}),
    ...(ref.checksum !== undefined ? { checksum: ref.checksum } : {}),
    ...(ref.label !== undefined ? { label: ref.label } : {}),
  }))
}

/** A deterministic scope fingerprint; array order is intentionally preserved. */
export function generationConsentScope(input: GenerationConsentInput): string {
  const payload: Record<string, unknown> = {
    version: 1,
    projectRef: input.projectRef,
    kind: input.kind,
    modelId: input.modelId ?? null,
    catalogRevision: input.catalogRevision ?? null,
    prompt: input.prompt,
    orderedRefs: input.orderedRefs,
    params: input.params,
    mode: input.mode,
    attempts: positiveInteger(input.attempts, 1),
    maxCalls: positiveInteger(input.maxCalls, 1),
    mediaTransferRequired: input.mediaTransferRequired,
    estimatedCostMicros: micros(input.estimatedCostMicros),
  }
  if (input.textPreparation?.assistantId) {
    payload.textPreparation = {
      assistantId: input.textPreparation.assistantId,
      versionId: input.textPreparation.versionId ?? null,
    }
  }
  return JSON.stringify(canonical(payload))
}

export function emptyGenerationConsentDraft(): GenerationConsentDraft {
  return { granted: false, scope: null, version: 0 }
}

export function hasCurrentGenerationConsent(
  draft: GenerationConsentDraft,
  scope: string,
): boolean {
  return draft.granted && draft.scope === scope
}

export function approveGenerationConsent(
  draft: GenerationConsentDraft,
  scope: string,
  granted: boolean,
): GenerationConsentDraft {
  return {
    ...draft,
    granted,
    scope: granted ? scope : null,
    version: granted ? draft.version + 1 : draft.version,
  }
}

export function revokeGenerationConsent(draft: GenerationConsentDraft): GenerationConsentDraft {
  return { ...draft, granted: false, scope: null }
}

/**
 * Media transfer is a separate permission from text-only LLM consent.  A
 * missing or stale consent is never upgraded by a model/catalog match.
 */
export function generationConsentIsReady(
  input: GenerationConsentInput,
  draft: GenerationConsentDraft,
): boolean {
  if (!input.modelId || input.catalogRevision === null || input.maxCalls !== 1) return false
  if (input.mediaTransferRequired && input.mediaTransferConsent !== true) return false
  return !input.mediaTransferRequired || hasCurrentGenerationConsent(draft, generationConsentScope(input))
}

function formatMicros(value: number): string {
  return `$${(value / 1_000_000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`
}

function refLine(ref: GenerationConsentRef, index: number): string {
  const label = ref.label?.trim() || ref.identity
  return `${index + 1}. ${ref.kind} · ${label}`
}

/**
 * Rows for the one aggregate expensive-generation review.  It intentionally
 * shows the complete scope instead of only the first model/price: each-mode
 * with two selected images is two attempts and one total, not one estimate
 * repeated twice.
 */
export function generationConsentRows(
  inputs: readonly GenerationConsentInput[],
  actualCostMicros: number | null = null,
): Array<[string, string]> {
  if (inputs.length === 0) return []
  const first = inputs[0]
  const uniqueValues = (values: readonly (string | number | null)[]) => [...new Set(values.filter((value): value is string | number => value !== null))]
  const uniqueStrings = (values: readonly string[]) => [...new Set(values)]
  const models = uniqueValues(inputs.map((input) => input.modelId))
  const catalogs = uniqueValues(inputs.map((input) => input.catalogRevision))
  const modes = uniqueStrings(inputs.map((input) => input.mode))
  const kinds = uniqueStrings(inputs.map((input) => input.kind))
  const prompts = uniqueStrings(inputs.map((input) => input.prompt))
  const paramStrings = uniqueStrings(inputs.map((input) => JSON.stringify(canonical(input.params))))
  const estimateValues = inputs.map((input) => input.estimatedCostMicros)
  const hasEstimates = estimateValues.every((value): value is number => value !== null && Number.isSafeInteger(value) && value >= 0)
  const estimateTotal = hasEstimates ? estimateValues.reduce((sum, value) => sum + value, 0) : null
  const refs = inputs.flatMap((input, inputIndex) => input.orderedRefs.map((ref, refIndex) => (
    `${inputs.length > 1 ? `${inputIndex + 1}/ ` : ''}${refLine(ref, refIndex)}`
  )))
  const mediaRequired = inputs.some((input) => input.mediaTransferRequired)
  const mediaConsented = inputs.filter((input) => input.mediaTransferRequired).every((input) => input.mediaTransferConsent === true)
  const helpers = uniqueValues(inputs.map((input) => input.textPreparation?.assistantId ?? null))
  const rows: Array<[string, string]> = [
    ['Type', kinds.join(', ')],
    ['Model', models.join(', ') || 'not pinned'],
    ...(helpers.length > 0 ? [['Assistant', helpers.join(', ')] as [string, string]] : []),
    ['Catalog', catalogs.length ? catalogs.map((value) => `revision ${value}`).join(', ') : 'revision not pinned'],
    ['Mode', modes.join(', ')],
    ['Attempts', String(inputs.length)],
    ['Calls per attempt', '1'],
    ['References in order', refs.length ? refs.join('\n') : 'none'],
    ['Prompt', prompts.length === 1 ? prompts[0]! : 'Prompts differ between attempts'],
    ['Parameters', paramStrings.length === 1 ? paramStrings[0]! : 'Parameters differ between attempts'],
    ['Media transfer', mediaRequired ? (mediaConsented ? 'approved separately' : 'not approved') : 'not required'],
  ]
  if (estimateTotal !== null) rows.push(['Total estimate', formatMicros(estimateTotal)])
  if (actualCostMicros !== null && Number.isSafeInteger(actualCostMicros) && actualCostMicros >= 0) {
    const overrun = estimateTotal !== null ? Math.max(0, actualCostMicros - estimateTotal) : 0
    rows.push(['Actual', overrun > 0
      ? `${formatMicros(actualCostMicros)} · estimate exceeded by ${formatMicros(overrun)}`
      : formatMicros(actualCostMicros)])
  }
  return rows
}
