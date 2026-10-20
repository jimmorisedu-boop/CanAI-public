import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isPdfInputParamName } from '../../../packages/model-catalog/catalog.js'
import { api, apiRequest } from '../api.js'
import type {
  CatalogDraftTestReceipt,
  CatalogDraftSetupResponse,
  CatalogLibraryView,
  CatalogModel,
  DraftTariffInput,
  DraftTestInput,
  DraftTestQuote,
  GenRef,
  JobResult,
  ParamSpec,
} from '../types.js'
import { askConfirm, type ConfirmRequest } from '../ui/confirmBus.js'
import { InlineNotice } from '../ui/InlineNotice.js'
import { formatExactUsd } from '../ui/money.js'
import { quoteConfirmationRequest } from '../ui/quotePresentation.js'
import { newId } from '../ui/ids.js'
import { MediaPlaybackControls } from '../ui/MediaPlaybackControls.js'
import { catalogLibraryClient } from './catalogLibraryClient.js'

export type WizardStep = 'url' | 'schema' | 'tariff' | 'inputs' | 'testing' | 'ready'
export type WizardReferenceKind = 'image' | 'video' | 'audio'

export interface WizardReferenceSlot {
  kind: WizardReferenceKind
  required: boolean
}

function WizardMediaPreview({
  kind,
  src,
  ariaLabel,
  className,
  muted = false,
}: {
  kind: 'video' | 'audio'
  src: string
  ariaLabel: string
  className?: string
  muted?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  return (
    <div className="fal-wizard-media-player" ref={fullscreenRef}>
      {kind === 'video' ? (
        <video ref={videoRef} className={className} src={src} aria-label={ariaLabel} muted={muted} preload="metadata" />
      ) : (
        <audio ref={audioRef} className={className} src={src} aria-label={ariaLabel} preload="metadata" />
      )}
      <MediaPlaybackControls mediaRef={kind === 'video' ? videoRef : audioRef} fullscreenRef={fullscreenRef} />
    </div>
  )
}

export interface WizardState {
  step: WizardStep
  url: string
  draft: CatalogModel | null
  issues: string[]
  tariff: DraftTariffInput | null
  quote: DraftTestQuote | null
  confirmationRequest: ConfirmRequest | null
  test: CatalogDraftTestReceipt | null
  jobId: string | null
  idempotencyKey: string | null
  idempotencyFingerprint: string | null
  setup: CatalogDraftSetupResponse | null
  setupStatus: 'idle' | 'loading' | 'ready' | 'error'
  result: JobResult | null
}

type WizardAction =
  | { type: 'urlChanged'; url: string }
  | { type: 'discovered'; draft: CatalogModel; issues: string[] }
  | { type: 'setupReady'; draft: CatalogModel; setup: CatalogDraftSetupResponse }
  | { type: 'setupFailed' }
  | { type: 'reviewed' }
  | { type: 'tariffChanged'; pricing: DraftTariffInput }
  | { type: 'tariffSaved'; pricing: DraftTariffInput }
  | { type: 'quoteReady'; quote: DraftTestQuote; confirmationRequest: ConfirmRequest }
  | { type: 'testAttemptReserved'; idempotencyKey: string; fingerprint: string }
  | { type: 'testStarted'; jobId: string; idempotencyKey: string; fingerprint?: string; quote?: DraftTestQuote }
  | { type: 'testFailed'; preserveAttempt?: boolean }
  | { type: 'retryTest' }
  | { type: 'testCompleted'; receipt: CatalogDraftTestReceipt; result: JobResult | null }

export function initialWizardState(): WizardState {
  return {
    step: 'url', url: '', draft: null, issues: [], tariff: null,
    quote: null, confirmationRequest: null, test: null, jobId: null,
    idempotencyKey: null, idempotencyFingerprint: null,
    setup: null, setupStatus: 'idle', result: null,
  }
}

export function reduceWizard(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'urlChanged': return { ...initialWizardState(), url: action.url }
    // Schema, tariff, and test inputs are one visible setup stage. Keep the
    // old action names so existing callers and saved sessions remain compatible.
    case 'discovered': return {
      ...state, step: 'schema', draft: action.draft, issues: action.issues,
      tariff: null, quote: null, confirmationRequest: null, test: null,
      jobId: null, idempotencyKey: null, idempotencyFingerprint: null,
      setup: null, setupStatus: 'loading', result: null,
    }
    case 'setupReady': return {
      ...state, step: 'inputs', draft: action.draft, setup: action.setup, setupStatus: 'ready',
      tariff: null, quote: null, confirmationRequest: null, test: null,
      jobId: null, idempotencyKey: null, idempotencyFingerprint: null, result: null,
    }
    case 'setupFailed': return { ...state, setupStatus: 'error' }
    case 'reviewed': return { ...state, step: 'inputs' }
    case 'tariffChanged': return {
      ...state, step: 'tariff', tariff: action.pricing, quote: null,
      confirmationRequest: null, test: null, jobId: null,
      idempotencyKey: null, idempotencyFingerprint: null,
    }
    case 'tariffSaved': return {
      ...state, step: 'inputs', tariff: action.pricing, quote: null,
      confirmationRequest: null, test: null, jobId: null,
      idempotencyKey: null, idempotencyFingerprint: null,
    }
    case 'quoteReady': return {
      ...state, quote: action.quote, confirmationRequest: action.confirmationRequest,
    }
    case 'testAttemptReserved': return {
      ...state, idempotencyKey: action.idempotencyKey, idempotencyFingerprint: action.fingerprint,
    }
    case 'testStarted': return {
      ...state, step: 'testing', jobId: action.jobId, idempotencyKey: action.idempotencyKey,
      idempotencyFingerprint: action.fingerprint ?? state.idempotencyFingerprint,
      quote: action.quote ?? state.quote, result: null,
    }
    case 'testFailed': return {
      ...state, step: 'inputs', jobId: null,
      result: null,
      ...(action.preserveAttempt ? {} : { idempotencyKey: null, idempotencyFingerprint: null }),
    }
    case 'retryTest': return {
      ...state, step: 'inputs', jobId: null, test: null, result: null, quote: null,
      confirmationRequest: null, idempotencyKey: null, idempotencyFingerprint: null,
    }
    case 'testCompleted': return {
      ...state, step: 'ready', test: action.receipt, result: action.result, jobId: null,
      idempotencyKey: null, idempotencyFingerprint: null,
    }
  }
}

/** Stable intent identity for retrying one draft test without double-submitting it. */
export function testAttemptFingerprint(
  draftId: string,
  input: DraftTestInput,
  tariff: DraftTariffInput | null = null,
): string {
  const encode = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${encode(key)}:${encode(item)}`).join(',')}}`
    }
    return `${typeof value}:${String(value)}`
  }
  return `${encode(draftId)}|${encode(tariff)}|${encode(input.prompt)}|${encode(input.params)}|${encode(input.refs)}`
}

export function existingTestAttemptKey(
  state: Pick<WizardState, 'idempotencyKey' | 'idempotencyFingerprint'>,
  fingerprint: string,
): string | null {
  return state.idempotencyFingerprint === fingerprint ? state.idempotencyKey : null
}

function defaultParamValue(spec: ParamSpec): string | number | boolean {
  if (spec.default !== undefined && ['string', 'number', 'boolean'].includes(typeof spec.default)) {
    return spec.default as string | number | boolean
  }
  if (spec.widget === 'boolean') return false
  if (spec.widget === 'number' || spec.widget === 'slider' || spec.widget === 'seed') return spec.min ?? 0
  return spec.options?.[0]?.value ?? ''
}

function initialParams(model: CatalogModel): Record<string, string | number | boolean> {
  return Object.fromEntries((model.params ?? []).map(spec => [spec.name, defaultParamValue(spec)]))
}

function minimumRefs(model: CatalogModel, kind: WizardReferenceKind): number {
  if (kind === 'image') return Math.max(0, model.minImageRefs ?? 0)
  if (kind === 'video') return Math.max(0, model.minVideoRefs ?? 0)
  return Math.max(0, model.minAudioRefs ?? 0)
}

function maximumRefs(model: CatalogModel, kind: WizardReferenceKind): number {
  const value = kind === 'image' ? model.maxImageRefs : kind === 'video' ? model.maxVideoRefs : model.maxAudioRefs
  return Math.max(minimumRefs(model, kind), value ?? 16)
}

function supportsRefs(model: CatalogModel, kind: WizardReferenceKind): boolean {
  if (kind === 'image') return Boolean(
    model.imageInputField || model.minImageRefs !== undefined || model.maxImageRefs !== undefined
      || model.refs && model.kind === 'image',
  ) && maximumRefs(model, kind) > 0
  if (kind === 'video') return Boolean(
    model.videoInputField || model.videoRefs || model.minVideoRefs !== undefined || model.maxVideoRefs !== undefined
      || model.refs && model.kind === 'video',
  ) && maximumRefs(model, kind) > 0
  return Boolean(
    model.audioInputField || model.minAudioRefs !== undefined || model.maxAudioRefs !== undefined
      || model.refs && model.kind === 'audio',
  ) && maximumRefs(model, kind) > 0
}

/** Mandatory reference kinds, retained as a pure helper for validation/tests. */
export function requiredRefs(model: CatalogModel): WizardReferenceKind[] {
  return (['image', 'video', 'audio'] as const).flatMap(kind => (
    Array.from({ length: minimumRefs(model, kind) }, () => kind)
  ))
}

/**
 * Initial visible slots: every mandatory slot plus one optional slot for each
 * supported media input. Optional image_urls must therefore be usable even
 * when fal's schema reports minItems=0.
 */
export function supportedReferenceSlots(model: CatalogModel): WizardReferenceSlot[] {
  return (['image', 'video', 'audio'] as const).flatMap(kind => {
    if (!supportsRefs(model, kind)) return []
    const required = minimumRefs(model, kind)
    const capacity = maximumRefs(model, kind)
    const count = Math.min(capacity, required + 1)
    return Array.from({ length: count }, (_, index) => ({ kind, required: index < required }))
  })
}

// Friendly alias for callers that describe these as reference slots.
export const referenceSlots = supportedReferenceSlots

export function compactRefs(refs: ReadonlyArray<GenRef | null | undefined>): GenRef[] {
  return refs.filter((ref): ref is GenRef => Boolean(ref))
}

function referenceIdentity(ref: GenRef): string {
  return ref.kind === 'text' ? `text:${ref.text}` : `${ref.kind}:${ref.src}`
}

function sameReferences(left: ReadonlyArray<GenRef>, right: ReadonlyArray<GenRef>): boolean {
  return [...left].map(referenceIdentity).sort().join('\u0000') === [...right].map(referenceIdentity).sort().join('\u0000')
}

function hasConditionalReferenceRequirement(model: CatalogModel, issues: readonly string[] = []): boolean {
  return model.conditionalReferenceRequirement === 'image-or-video-or-pdf'
    || issues.some(issue => /image_urls.*(?:video_url|pdf_url).*(?:video_url|pdf_url)/i.test(issue))
}

function hasReferenceAlternative(refs: ReadonlyArray<GenRef>, params: Record<string, unknown>): boolean {
  if (refs.some(ref => ref.kind === 'image' || ref.kind === 'video')) return true
  return Object.entries(params).some(([name, value]) => (
    isPdfInputParamName(name) && typeof value === 'string' && Boolean(value.trim())
  ))
}

export function refsMeetMinimum(
  model: CatalogModel,
  refs: ReadonlyArray<GenRef>,
  params: Record<string, unknown> = {},
  issues: readonly string[] = [],
): boolean {
  if (!(['image', 'video', 'audio'] as const).every(kind => (
    refs.filter(ref => ref.kind === kind).length >= minimumRefs(model, kind)
  ))) return false
  return !hasConditionalReferenceRequirement(model, issues) || hasReferenceAlternative(refs, params)
}

export function positiveFiniteRate(value: string | number): boolean {
  const amount = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(amount) && amount > 0
}

/** Tariff units use seconds only for video models; all other result media are per result. */
export function tariffUnitForKind(kind: CatalogModel['kind']): 'image' | 'second' {
  return kind === 'video' ? 'second' : 'image'
}

export function tariffUnitLabel(kind: CatalogModel['kind'], unit: 'image' | 'second'): string {
  return unit === 'second' ? (kind === 'video' ? 'Per video second' : 'Per second') : 'Per result'
}

export function setupPricingReady(
  pricing: CatalogDraftSetupResponse['pricing'],
): pricing is NonNullable<CatalogDraftSetupResponse['pricing']> {
  return Boolean(
    pricing
    && typeof pricing.sourceUrl === 'string'
    && pricing.sourceUrl.trim()
    && Number.isFinite(pricing.amountUsd)
    && pricing.amountUsd > 0,
  )
}

export function setupTariffReady(setup: CatalogDraftSetupResponse | null, draftId: string | undefined): boolean {
  if (!setup || !draftId || !setupPricingReady(setup.pricing)) return false
  const meta = setup.library?.draftMeta?.[draftId]
  return Boolean(meta?.tariffConfirmedAt && meta.definitionHash && meta.tariffHash)
}

/**
 * A repeated URL import may return a draft whose paid test already finished.
 * Only resume that receipt when it still belongs to the server's current
 * schema and tariff; an orphaned or invalidated receipt must require a new
 * user-confirmed test.
 */
export function persistedTestReceipt(
  setup: CatalogDraftSetupResponse | null,
  draftId: string | undefined,
): CatalogDraftTestReceipt | null {
  if (!setup || !draftId) return null
  const meta = setup.library?.draftMeta?.[draftId]
  const receipt = meta?.test
  if (!receipt || !meta.definitionHash || !meta.tariffHash) return null
  if (receipt.definitionHash !== meta.definitionHash || receipt.tariffHash !== meta.tariffHash) return null
  return receipt
}

export function deliveredTestResult(
  receipt: Pick<CatalogDraftTestReceipt, 'resultKind'> | null,
  result: JobResult | null,
): boolean {
  if (!receipt || !result) return false
  if (receipt.resultKind === 'text') return typeof result.text === 'string' && Boolean(result.text.trim())
  if (result.mime) {
    const expectedPrefix = `${receipt.resultKind}/`
    if (!result.mime.startsWith(expectedPrefix)) return false
  }
  return typeof result.url === 'string' && Boolean(result.url.trim())
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function kindLabel(kind: WizardReferenceKind): string {
  return { image: 'Image', video: 'Video', audio: 'Audio' }[kind]
}

function resultKindLabel(kind: CatalogModel['kind']): string {
  return { image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', other: 'Other' }[kind]
}

function endpointFromOfficialUrl(value: string): string {
  try {
    const pathname = new URL(value).pathname.replace(/^\/+|\/+$/g, '')
    const marker = pathname.indexOf('models/')
    if (marker < 0) return ''
    return pathname.slice(marker + 'models/'.length).replace(/\/api\/?$/i, '')
  } catch {
    return ''
  }
}

function paramLabel(spec: ParamSpec): string {
  const key = spec.name.toLowerCase()
  if (key === 'resolution' || key.endsWith('_resolution')) return 'Resolution'
  if (key === 'image_size' || key === 'size') return 'Image size'
  if (key === 'aspect_ratio' || key === 'aspect') return 'Aspect ratio'
  if (key === 'output_format' || key === 'format') return 'Output format'
  if (key === 'quality') return 'Quality'
  if (key === 'duration') return 'Duration'
  if (key === 'seed') return 'Seed (optional)'
  if (/(^|[_-])pdf([_-]|$)|document/.test(key)) return 'PDF document (optional)'
  return spec.label || spec.name
}

function isPdfParam(spec: ParamSpec): boolean {
  return isPdfInputParamName(spec.name)
}

function isPrimaryParam(spec: ParamSpec): boolean {
  if (isPdfParam(spec)) return false
  return /resolution|aspect|output|quality|duration|(^|_)size($|_)/.test(spec.name.toLowerCase())
}

function testFailureMessage(reported: string | undefined): string {
  const clean = reported?.trim()
  if (!clean) return 'Model test failed: fal did not provide a reason.'
  if (/at least one image url is required/i.test(clean)) {
    return 'Model test failed: fal requires at least one image. Add an image in “Prompt and references” or choose a supported alternative input.'
  }
  return `Model test failed: ${clean}`
}

function setupFailureMessage(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'status' in cause
    ? Number((cause as { status?: unknown }).status)
    : undefined
  if (status === 404) return 'Automatic test setup is available after updating CanAI. Update the app and try again.'
  if (status === 409) return 'The catalog changed. Prepare the test again.'
  return cause instanceof Error ? cause.message : 'Could not prepare the model test. Try again.'
}

function isSetupParamValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

class TerminalTestError extends Error {}

interface ReferenceDetail {
  name: string
  mime: string
  previewUrl?: string
}

export function FalModelWizard({
  library,
  onLibrary,
  onClose,
  onSelect,
}: {
  library: CatalogLibraryView
  onLibrary(next: CatalogLibraryView): void
  onClose(): void
  onSelect?(modelId: string): void
}) {
  const [state, dispatch] = useReducer(reduceWizard, undefined, initialWizardState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [params, setParams] = useState<Record<string, string | number | boolean>>({})
  const [refs, setRefs] = useState<Array<GenRef | null>>([])
  const [refSlots, setRefSlots] = useState<WizardReferenceSlot[]>([])
  const [refDetails, setRefDetails] = useState<Array<ReferenceDetail | null>>([])
  const [prompt, setPrompt] = useState('CanAI model test')
  const revisionRef = useRef(library.revision)
  const previewUrlsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const neededRefs = useMemo(() => state.draft ? requiredRefs(state.draft) : [], [state.draft])

  useEffect(() => { revisionRef.current = library.revision }, [library.revision])
  useEffect(() => {
    // React StrictMode mounts, cleans up, and mounts effects once in
    // development. Set the sentinel in the effect body as well as clearing
    // it in cleanup so an async setup/test isn't treated as unmounted after
    // that replay.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
      previewUrlsRef.current.clear()
    }
  }, [])

  function releasePreview(url: string | undefined): void {
    if (!url) return
    URL.revokeObjectURL(url)
    previewUrlsRef.current.delete(url)
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete action')
    } finally { setBusy(false) }
  }

  async function discover(): Promise<void> {
    const previous = new Set(library.drafts.map(model => model.id))
    const requestedEndpoint = endpointFromOfficialUrl(state.url.trim())
    const result = await catalogLibraryClient.discover(apiRequest, state.url.trim(), revisionRef.current)
    if (result.existingModel) {
      onSelect?.(result.existingModel)
      setMessage(result.issues.join(' '))
      return
    }
    if (!result.library) throw new Error('fal did not return a model description')
    revisionRef.current = result.library.revision
    onLibrary(result.library)
    const draft = result.library.drafts.find(model => model.endpoint === requestedEndpoint)
      ?? result.library.drafts.find(model => !previous.has(model.id))
      ?? result.library.drafts.at(-1)
    if (!draft) throw new Error('Model draft was not found after import')
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
    previewUrlsRef.current.clear()
    dispatch({ type: 'discovered', draft, issues: result.issues })
    await prepareSetup(draft, result.library.revision)
  }

  async function prepareSetup(draft: CatalogModel, revision: number): Promise<void> {
    let setup: CatalogDraftSetupResponse
    try {
      setup = await catalogLibraryClient.setup(apiRequest, draft.id, revision)
    } catch (cause) {
      if (mountedRef.current) dispatch({ type: 'setupFailed' })
      throw new Error(setupFailureMessage(cause))
    }
    if (!setup.library || !Array.isArray(setup.library.drafts) || !setup.library.draftMeta
      || !setup.input || typeof setup.input.prompt !== 'string'
      || !Array.isArray(setup.input.refs) || !setup.input.params || typeof setup.input.params !== 'object' || Array.isArray(setup.input.params)
      || !Array.isArray(setup.samples) || !setup.samples.every(sample => (
        sample && ['image', 'video', 'audio'].includes(sample.kind) && typeof sample.name === 'string' && typeof sample.url === 'string'
      )) || !Array.isArray(setup.warnings)) {
      if (mountedRef.current) dispatch({ type: 'setupFailed' })
      throw new Error('The server returned incomplete test setup. Try again.')
    }
    const preparedDraft = setup.library.drafts.find(model => model.id === draft.id) ?? draft
    revisionRef.current = setup.library.revision
    onLibrary(setup.library)

    const slots = supportedReferenceSlots(preparedDraft)
    const queues = new Map<WizardReferenceKind, GenRef[]>([
      ['image', setup.input.refs.filter(ref => ref.kind === 'image')],
      ['video', setup.input.refs.filter(ref => ref.kind === 'video')],
      ['audio', setup.input.refs.filter(ref => ref.kind === 'audio')],
    ])
    const nextRefs: Array<GenRef | null> = []
    const nextDetails: Array<ReferenceDetail | null> = []
    const nextSlots = [...slots]
    for (let index = 0; index < nextSlots.length; index += 1) {
      const slot = nextSlots[index]
      const ref = queues.get(slot.kind)?.shift() ?? null
      nextRefs.push(ref)
      const refSrc = ref && ref.kind !== 'text' ? ref.src : ''
      const sample = ref && ref.kind !== 'text' ? setup.samples.find(item => item.kind === ref.kind && item.url === refSrc) : undefined
      nextDetails.push(ref ? { name: sample?.name ?? refSrc, mime: '' } : null)
    }
    for (const kind of ['image', 'video', 'audio'] as const) {
      const queue = queues.get(kind) ?? []
      while (queue.length > 0 && nextSlots.filter(slot => slot.kind === kind).length < maximumRefs(preparedDraft, kind)) {
        nextSlots.push({ kind, required: false })
        nextRefs.push(queue.shift() ?? null)
        const ref = nextRefs.at(-1)
        const refSrc = ref && ref.kind !== 'text' ? ref.src : ''
        const sample = ref && ref.kind !== 'text' ? setup.samples.find(item => item.kind === ref.kind && item.url === refSrc) : undefined
        nextDetails.push(ref ? { name: sample?.name ?? refSrc, mime: '' } : null)
      }
    }
    const nextParams = initialParams(preparedDraft)
    for (const [name, value] of Object.entries(setup.input.params)) {
      if (isSetupParamValue(value)) nextParams[name] = value
    }
    if (mountedRef.current) {
      setPrompt(setup.input.prompt)
      setParams(nextParams)
      setRefs(nextRefs)
      setRefSlots(nextSlots)
      setRefDetails(nextDetails)
      dispatch({ type: 'setupReady', draft: preparedDraft, setup })
    }
    await resumePersistedTest(preparedDraft.id, setup)
  }

  async function retrySetup(): Promise<void> {
    if (!state.draft) return
    await prepareSetup(state.draft, revisionRef.current)
  }

  async function addReference(index: number, kind: WizardReferenceKind, file: File): Promise<void> {
    const uploaded = await api.uploadFile(file)
    const previewUrl = file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : undefined
    if (previewUrl) previewUrlsRef.current.add(previewUrl)
    const previousDetail = refDetails[index]
    releasePreview(previousDetail?.previewUrl)
    const nextDetail: ReferenceDetail = { name: file.name, mime: file.type, previewUrl }
    setRefs(current => { const next = [...current]; next[index] = { kind, src: uploaded.url }; return next })
    setRefDetails(current => { const next = [...current]; next[index] = nextDetail; return next })

    // Keep one empty optional slot available, growing only up to the schema cap.
    const hasEmptyOptional = refSlots.some((slot, slotIndex) => (
      slot.kind === kind && !slot.required && slotIndex !== index && !refs[slotIndex]
    ))
    const count = refSlots.filter(slot => slot.kind === kind).length
    if (!hasEmptyOptional && count < (state.draft ? maximumRefs(state.draft, kind) : count)) {
      setRefSlots(current => [...current, { kind, required: false }])
      setRefs(current => [...current, null])
      setRefDetails(current => [...current, null])
    }
  }

  function removeReference(index: number): void {
    const detail = refDetails[index]
    releasePreview(detail?.previewUrl)
    setRefs(current => current.map((ref, refIndex) => refIndex === index ? null : ref))
    setRefDetails(current => current.map((item, refIndex) => refIndex === index ? null : item))
  }

  async function resumePersistedTest(draftId: string, setup: CatalogDraftSetupResponse): Promise<void> {
    const receipt = persistedTestReceipt(setup, draftId)
    if (!receipt || !mountedRef.current) return
    let status: Awaited<ReturnType<typeof catalogLibraryClient.testStatus>>
    try {
      // A duplicate URL import may already have a completed test. Reading its
      // status is free and lets the wizard show the stored result without a
      // second quote, confirmation, or paid start.
      status = await catalogLibraryClient.testStatus(apiRequest, draftId, receipt.jobId)
    } catch {
      return
    }
    if (!mountedRef.current || status.status !== 'done' || !status.result) return
    const next = await catalogLibraryClient.load(apiRequest)
    if (!mountedRef.current) return
    const currentReceipt = next.draftMeta[draftId]?.test
    if (!currentReceipt || currentReceipt.jobId !== receipt.jobId) return
    revisionRef.current = next.revision
    onLibrary(next)
    dispatch({ type: 'testCompleted', receipt: currentReceipt, result: status.result })
    setMessage(currentReceipt.actualCostUsd === null
      ? 'Saved test completed. fal.ai did not report the actual cost.'
      : `Saved test completed. Actual cost: $${currentReceipt.actualCostUsd.toFixed(6)}.`)
  }

  async function pollTest(draftId: string, jobId: string): Promise<void> {
    for (;;) {
      if (!mountedRef.current) return
      const status = await catalogLibraryClient.testStatus(apiRequest, draftId, jobId)
      if (!mountedRef.current) return
      if (status.status === 'error') throw new TerminalTestError(testFailureMessage(status.error))
      if (status.status === 'done') {
        const next = await catalogLibraryClient.load(apiRequest)
        if (!mountedRef.current) return
        revisionRef.current = next.revision
        onLibrary(next)
        const receipt = next.draftMeta[draftId]?.test
        if (!receipt) throw new Error('The test completed, but its receipt was not saved to the catalog')
        dispatch({ type: 'testCompleted', receipt, result: status.result ?? null })
        setMessage(receipt.actualCostUsd === null
          ? 'Test completed. fal.ai did not report the actual cost.'
          : `Test completed. Actual cost: $${receipt.actualCostUsd.toFixed(6)}.`)
        return
      }
      await wait(1500)
    }
  }

  async function startTest(): Promise<void> {
    if (!state.draft || state.setupStatus !== 'ready' || !state.setup) return
    if (!setupPricingReady(state.setup.pricing)) {
      throw new Error('Test price is not confirmed. Prepare the test again.')
    }
    if (!setupTariffReady(state.setup, state.draft.id)) {
      throw new Error('Test price is not saved for quoting yet. Prepare the test again.')
    }
    const input: DraftTestInput = { prompt, params, refs: compactRefs(refs) }
    if (!refsMeetMinimum(state.draft, input.refs, input.params, state.issues)) {
      throw new Error(hasConditionalReferenceRequirement(state.draft, state.issues)
        ? 'Add an image, video, or PDF before testing the model'
        : 'Add the required references before testing the model')
    }
    const quote = await catalogLibraryClient.quoteTest(apiRequest, state.draft.id, input)
    const confirmation = quoteConfirmationRequest({
      amountUsd: quote.amountUsd,
      model: state.draft.name,
      quantity: 1,
      quantityLabel: 'Test runs',
      ...(state.setup.pricing.approximate ? {
        pricingMode: 'fal-metered' as const,
        meteredUncapped: true,
        guaranteed: false,
      } : {}),
    })
    dispatch({ type: 'quoteReady', quote, confirmationRequest: confirmation })
    const accepted = await askConfirm(confirmation)
    if (!accepted) return
    // Setup persists the provider tariff and its hashes server-side. Keep the
    // client attempt identity tied to the actual test input, never reinterpret
    // a displayed call estimate as a local image/second rate.
    const fingerprint = testAttemptFingerprint(state.draft.id, input, null)
    const idempotencyKey = existingTestAttemptKey(state, fingerprint) ?? newId()
    dispatch({ type: 'testAttemptReserved', idempotencyKey, fingerprint })
    const started = await catalogLibraryClient.startTest(
      apiRequest,
      state.draft.id,
      { ...input, confirmedAmountUsd: quote.amountUsd },
      idempotencyKey,
    )
    dispatch({ type: 'testStarted', jobId: started.jobId, idempotencyKey, fingerprint, quote })
    try { await pollTest(state.draft.id, started.jobId) }
    catch (cause) {
      dispatch({ type: 'testFailed', preserveAttempt: !(cause instanceof TerminalTestError) })
      throw cause
    }
  }

  async function publish(): Promise<void> {
    if (!state.draft) return
    if (!state.test || !deliveredTestResult(state.test, state.result)) throw new Error('Wait for the test result before adding the model')
    const next = await catalogLibraryClient.publish(apiRequest, state.draft.id, revisionRef.current)
    revisionRef.current = next.revision
    onLibrary(next); onSelect?.(state.draft.id); onClose()
  }

  const visibleStage = state.step === 'url' ? 1 : state.step === 'ready' ? 3 : 2
  const promptRequired = state.draft ? state.draft.promptInputField !== null : false
  const inputRefs = state.draft ? compactRefs(refs) : []
  const minimumRefsSatisfied = state.draft ? refsMeetMinimum(state.draft, inputRefs, params, state.issues) : false
  const promptReady = !promptRequired || Boolean(prompt.trim())
  const primaryParams = state.draft?.params.filter(isPrimaryParam) ?? []
  const pdfParams = state.draft?.params.filter(isPdfParam) ?? []
  const advancedParams = state.draft?.params.filter(spec => !isPrimaryParam(spec) && !isPdfParam(spec)) ?? []
  const setupVisible = state.step === 'schema' || state.step === 'tariff' || state.step === 'inputs'
  const setupPriceReady = setupPricingReady(state.setup?.pricing ?? null)
  const setupTariffIsReady = setupTariffReady(state.setup, state.draft?.id)
  const currentRefs = compactRefs(refs)
  const customRefsChanged = Boolean(state.setup && !sameReferences(currentRefs, state.setup.input.refs))
  const displaySamples = state.setup
    ? customRefsChanged
      ? refs.flatMap((ref, index) => {
          if (!ref || ref.kind === 'text') return []
          const detail = refDetails[index]
          return [{ kind: ref.kind, name: detail?.name ?? ref.src, url: detail?.previewUrl ?? ref.src }]
        })
      : state.setup.samples
    : []
  const testReady = Boolean(
    state.setupStatus === 'ready'
    && state.setup
    && setupPriceReady
    && setupTariffIsReady
    && promptReady
    && minimumRefsSatisfied,
  )

  return <div className="fal-model-wizard" role="region" aria-label="Add fal.ai model">
    <div className="catalog-panel-heading">
      <div><h4>Add fal.ai model</h4><p className="settings-note">Step {visibleStage} of 3</p></div>
      <button type="button" className="editor-close" disabled={busy} onClick={onClose}>Close wizard</button>
    </div>
    <ol className="fal-wizard-stages" aria-label="Model setup steps">
      {(['Link', 'Test', 'Add'] as const).map((label, index) => {
        const stage = index + 1
        return <li key={label} data-active={visibleStage === stage} data-complete={visibleStage > stage} aria-current={visibleStage === stage ? 'step' : undefined}>
          <span>{stage}</span><strong>{label}</strong>
        </li>
      })}
    </ol>
    {error && <InlineNotice tone="error" title={error} />}
    {message && state.step !== 'ready' && <InlineNotice tone="success" system title={message} />}
    {state.step === 'url' && <section className="fal-wizard-section">
      <label className="settings-label" htmlFor="fal-model-url">Official model link</label>
      <div className="catalog-library-row">
        <input id="fal-model-url" type="url" placeholder="https://fal.ai/models/…" value={state.url} disabled={busy}
          onChange={event => dispatch({ type: 'urlChanged', url: event.target.value })} />
        <button type="button" className="generate" disabled={busy || !state.url.trim()} onClick={() => void run(discover)}>Prepare test</button>
      </div>
      <p className="settings-note">Paste the model page link. CanAI prepares an example and shows the test price. It runs only after confirmation.</p>
    </section>}
    {setupVisible && state.draft && <>
      <section className="fal-wizard-model-summary" aria-live="polite">
        <div><span className="fal-wizard-kicker">Model</span><strong>{state.draft.name}</strong></div>
        <div><span className="fal-wizard-kicker">Result</span><strong>{resultKindLabel(state.draft.kind)}</strong></div>
      </section>
      {state.setupStatus === 'loading' && <InlineNotice tone="info" title="Preparing test…" detail="The example, parameters, and estimated price load automatically." />}
      {state.setupStatus === 'error' && <section className="fal-wizard-setup-retry">
        <InlineNotice tone="error" title="Could not prepare test" detail="The model draft was saved. Prepare it again after updating CanAI or checking the connection." />
        <button type="button" className="editor-close" disabled={busy} onClick={() => void run(retrySetup)}>Prepare again</button>
      </section>}
      {state.setupStatus === 'ready' && state.setup && <>
        <div className="fal-wizard-test-overview">
          {!!displaySamples.length && <section className="fal-wizard-section fal-wizard-samples">
            <div className="fal-wizard-section-heading"><h5>Test references</h5><span className="settings-note">{customRefsChanged ? 'Current files' : 'Prepared automatically'}</span></div>
            <div className="fal-setup-sample-grid">
              {displaySamples.map(sample => <figure className="fal-setup-sample" key={`${sample.kind}-${sample.url}`}>
                {sample.kind === 'image' && <img src={sample.url} alt={sample.name} loading="lazy" />}
                {sample.kind === 'video' && <WizardMediaPreview key={`video:${sample.url}`} kind="video" src={sample.url} ariaLabel={sample.name} />}
                {sample.kind === 'audio' && <WizardMediaPreview key={`audio:${sample.url}`} kind="audio" src={sample.url} ariaLabel={sample.name} />}
                <figcaption>{sample.name}</figcaption>
              </figure>)}
            </div>
          </section>}
          <section className="fal-wizard-section fal-wizard-pricing" aria-label="Test price">
            <div className="fal-wizard-section-heading"><h5>Estimated test price</h5><span className="settings-note">Paid run only after confirmation</span></div>
            {setupPricingReady(state.setup.pricing) ? <>
              <strong className="fal-wizard-price">{formatExactUsd(state.setup.pricing.amountUsd)}</strong>
              <p className="settings-note">The final cost depends on the text, settings, and source files.</p>
              {!!state.setup.pricing.note && <details className="settings-technical fal-wizard-details">
                <summary>Estimate details</summary>
                <p className="settings-note">{state.setup.pricing.note}</p>
              </details>}
            {!!state.setup.pricing.sourceUrl && <a className="fal-wizard-source-link" href={state.draft.endpoint ? `https://fal.ai/models/${state.draft.endpoint}` : state.setup.pricing.sourceUrl} target="_blank" rel="noreferrer">Open fal.ai pricing page</a>}
              {!setupTariffIsReady && <>
                <InlineNotice tone="warning" title="Price received but not saved for quoting" detail="Prepare the test again; the run is blocked until the server confirms the tariff." />
                <button type="button" className="editor-close" disabled={busy} onClick={() => void run(retrySetup)}>Prepare again</button>
              </>}
            </> : <>
              <InlineNotice tone="warning" title="Test price is not confirmed yet" detail="Prepare again; paid runs are blocked until a price is available." />
              <button type="button" className="editor-close" disabled={busy} onClick={() => void run(retrySetup)}>Prepare again</button>
            </>}
          </section>
        </div>
        {customRefsChanged && <InlineNotice tone="info" title="You changed the test files" detail="The price will be recalculated before confirmation." />}
        {!!state.setup.warnings.length && <div className="fal-wizard-issues">{state.setup.warnings.map(warning => <InlineNotice key={warning} tone="info" system title={warning} />)}</div>}

        <details className="settings-technical fal-wizard-details">
          <summary>Technical details</summary>
          <dl className="catalog-schema-summary">
            <div><dt>Endpoint</dt><dd><code>{state.draft.endpoint}</code></dd></div>
            <div><dt>Schema parameters</dt><dd>{state.draft.params.length || 'none'}</dd></div>
            <div><dt>Required references</dt><dd>{neededRefs.length || 'none'}</dd></div>
          </dl>
          {state.issues.length > 0 && <div className="fal-wizard-issues">{state.issues.map(issue => <InlineNotice key={issue} tone="info" system title={issue} />)}</div>}
        </details>

        <details className="fal-wizard-edit">
          <summary>Edit test</summary>
          <section className="fal-wizard-section fal-wizard-primary">
            {promptRequired && <label className="settings-label fal-wizard-prompt">Test prompt
              <textarea className="settings-textarea" aria-label="Test prompt" rows={4} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} />
            </label>}
            {refSlots.length > 0 && <div className="fal-reference-grid">
              {refSlots.map((slot, index) => {
                const detail = refDetails[index]
                const ref = refs[index]
                const previewSrc = detail?.previewUrl ?? (ref && (ref.kind === 'image' || ref.kind === 'video' || ref.kind === 'audio') ? ref.src : undefined)
                return <div className="fal-reference-card" key={`${slot.kind}-${index}`} data-required={slot.required ? 'true' : 'false'}>
                  <div className="fal-reference-heading"><strong>{kindLabel(slot.kind)} {slot.required ? '— required' : '— optional'}</strong>
                    {ref && <button type="button" className="editor-close" disabled={busy} onClick={() => removeReference(index)}>Remove</button>}
                  </div>
                  {previewSrc && slot.kind === 'image' && <img className="fal-reference-preview" src={previewSrc} alt={detail?.name ?? 'Reference preview'} />}
                  {previewSrc && slot.kind === 'video' && <WizardMediaPreview key={`video:${previewSrc}`} kind="video" className="fal-reference-preview" src={previewSrc} ariaLabel={detail?.name ?? 'Video preview'} muted />}
                  {previewSrc && slot.kind === 'audio' && <WizardMediaPreview key={`audio:${previewSrc}`} kind="audio" className="fal-reference-audio" src={previewSrc} ariaLabel={detail?.name ?? 'Audio preview'} />}
                  {ref && <div className="fal-reference-file-name" title={detail?.name}>{detail?.name ?? (ref.kind === 'text' ? ref.text : ref.src)}</div>}
                  <label className="fal-reference-file-label">{ref ? 'Replace file' : 'Choose file'}
                    <input className="fal-reference-file" type="file" accept={`${slot.kind}/*`} disabled={busy} onChange={event => {
                      const file = event.target.files?.[0]
                      event.currentTarget.value = ''
                      if (file) void run(() => addReference(index, slot.kind, file))
                    }} />
                  </label>
                </div>
              })}
            </div>}
            {refSlots.length === 0 && <p className="settings-note">This model has no media references.</p>}
            {!!primaryParams.length && <div className="catalog-test-params">{primaryParams.map(spec => <ParamInput key={spec.name} spec={spec} value={params[spec.name]} onChange={value => setParams(current => ({ ...current, [spec.name]: value }))} />)}</div>}
            {(advancedParams.length > 0 || pdfParams.length > 0) && <details className="settings-technical fal-wizard-details fal-wizard-advanced">
              <summary>Additional parameters and PDF document</summary>
              {!!advancedParams.length && <div className="catalog-test-params">{advancedParams.map(spec => <ParamInput key={spec.name} spec={spec} value={params[spec.name]} onChange={value => setParams(current => ({ ...current, [spec.name]: value }))} />)}</div>}
              {!!pdfParams.length && <div className="catalog-test-params">{pdfParams.map(spec => <ParamInput key={spec.name} spec={spec} value={params[spec.name]} onChange={value => setParams(current => ({ ...current, [spec.name]: value }))} />)}</div>}
            </details>}
          </section>
        </details>
        {!minimumRefsSatisfied && (hasConditionalReferenceRequirement(state.draft, state.issues) || neededRefs.length > 0) && <p className="fal-wizard-validation" role="status">
          {hasConditionalReferenceRequirement(state.draft, state.issues)
            ? 'Add an image, video, or PDF document to continue.'
            : 'Add the required references to continue.'}
        </p>}
        {!promptReady && <p className="fal-wizard-validation" role="status">Add a test prompt to continue.</p>}
        <div className="fal-wizard-actions">
          <p className="settings-note">Click “Test model”, then confirm the paid test in a separate window.</p>
          <button type="button" className="generate fal-wizard-verify" disabled={busy || !testReady} onClick={() => void run(startTest)}>Test model</button>
        </div>
      </>}
    </>}
    {state.step === 'testing' && <InlineNotice tone="info" title="Model test is running through the fal.ai queue…" detail={state.jobId ? `Job ${state.jobId}` : undefined} />}
    {state.step === 'ready' && state.draft && <section className="fal-wizard-section fal-wizard-ready">
      <InlineNotice tone="success" title="Model test complete" detail={state.test?.actualCostUsd === null ? 'fal.ai did not report the actual cost.' : undefined} />
      {state.test && state.result && state.test.resultKind === 'image' && state.result.url && <img className="fal-test-result-preview" src={state.result.url} alt={`Test result for ${state.draft.name}`} />}
      {state.test && state.result && state.test.resultKind === 'video' && state.result.url && <WizardMediaPreview key={`video:${state.result.url}`} kind="video" className="fal-test-result-preview" src={state.result.url} ariaLabel={`Test result for ${state.draft.name}`} />}
      {state.test && state.result && state.test.resultKind === 'audio' && state.result.url && <WizardMediaPreview key={`audio:${state.result.url}`} kind="audio" className="fal-test-result-audio" src={state.result.url} ariaLabel={`Test result for ${state.draft.name}`} />}
      {state.test && state.result && state.test.resultKind === 'text' && state.result.text && <pre className="fal-test-result-text">{state.result.text}</pre>}
      {!deliveredTestResult(state.test, state.result) && <InlineNotice tone="warning" title="Test result has not arrived yet" detail="You can add the model after the result arrives." />}
      <p className="settings-note">The model appears in the local board list after you add it.</p>
      <div className="fal-wizard-actions">
        {!deliveredTestResult(state.test, state.result) && <button type="button" className="editor-close" disabled={busy} onClick={() => dispatch({ type: 'retryTest' })}>Retry test</button>}
        <button type="button" className="generate" disabled={busy || !state.test || !deliveredTestResult(state.test, state.result)} onClick={() => void run(publish)}>Add model</button>
      </div>
    </section>}
  </div>
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: string | number | boolean | undefined; onChange(value: string | number | boolean): void }) {
  const label = paramLabel(spec)
  if (spec.widget === 'boolean') return <label className="settings-label catalog-param-boolean">
    <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />{label}
  </label>
  if (spec.widget === 'select') return <label className="settings-label">{label}<select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
    {spec.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
  if (spec.widget === 'number' || spec.widget === 'slider' || spec.widget === 'seed') return <label className="settings-label">{label}<input type="number" min={spec.min} max={spec.max} step={spec.step} value={Number(value ?? 0)} onChange={event => onChange(event.target.valueAsNumber)} /></label>
  return <label className="settings-label">{label}<textarea className="settings-textarea" aria-label={label} rows={2} value={String(value ?? '')} onChange={event => onChange(event.target.value)} /></label>
}
