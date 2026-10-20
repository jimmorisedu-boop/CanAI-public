import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  CATALOG,
  CATALOG_REVISION,
  DEFAULT_MODEL,
  normalizeEndpoint,
  replaceRuntimeCatalog,
  type CatalogModel,
  type MediaPricing,
  type TextTokenPricing,
} from './catalog.js'
import { paramValueAllowed } from '../../packages/model-catalog/macroModels.js'
import { config } from './config.js'
import { withOfficialPricing } from './officialFalPricing.js'

export type Lifecycle = 'active' | 'archived' | 'disabled'
export type CatalogDefaultSlot = 'image' | 'video' | 'audio' | 'assistant'
export type CatalogDefaults = Record<CatalogDefaultSlot, string | null>
export interface CatalogDraftMeta {
  tariffSourceUrl?: string
  tariffConfirmedAt?: number
  definitionHash?: string
  tariffHash?: string
  testInvalidatedAt?: number
  test?: {
    jobId: string
    completedAt: number
    resultKind: 'image' | 'video' | 'audio' | 'text'
    actualCostUsd: number | null
    definitionHash: string
    tariffHash: string
  }
}

interface State {
  schemaVersion?: 2
  revision: number
  lifecycle: Record<string, Lifecycle>
  drafts: CatalogModel[]
  extensions: CatalogModel[]
  defaults?: CatalogDefaults
  draftMeta?: Record<string, CatalogDraftMeta>
}

const DEFAULT_SLOTS: CatalogDefaultSlot[] = ['image', 'video', 'audio', 'assistant']
const SLOT_KIND = { image: 'image', video: 'video', audio: 'audio', assistant: 'text' } as const
const SLOT_LABEL = { image: 'images', video: 'video', audio: 'audio', assistant: 'assistant' } as const
const empty = (): State => ({
  schemaVersion: 2,
  revision: 0,
  lifecycle: {},
  drafts: [],
  extensions: [],
  draftMeta: {},
})

export class CatalogLibraryError extends Error { constructor(message: string, readonly status = 400) { super(message) } }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function catalogDefinitionHash(model: CatalogModel): string {
  const { pricing: _pricing, textPricing: _textPricing, pricingNote: _pricingNote, lifecycle: _lifecycle, ...definition } = model
  return sha256(definition)
}

export function catalogTariffHash(model: CatalogModel): string {
  return sha256({ pricing: model.pricing, textPricing: model.textPricing })
}

function officialFalUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new CatalogLibraryError('Provide an official fal.ai pricing link') }
  if (url.protocol !== 'https:' || !['fal.ai', 'www.fal.ai', 'api.fal.ai'].includes(url.hostname)) {
    throw new CatalogLibraryError('Provide an official fal.ai pricing link')
  }
  return url.toString()
}

function checkedMediaPricing(value: MediaPricing | undefined): MediaPricing {
  if (!value || !['image', 'second', 'call'].includes(value.unit) || !Number.isFinite(value.usd) || value.usd <= 0) {
    throw new CatalogLibraryError('Provide positive model pricing')
  }
  return structuredClone(value)
}

function checkedTextPricing(value: TextTokenPricing | undefined): TextTokenPricing {
  if (!value || !Number.isFinite(value.inputPerMillion) || value.inputPerMillion < 0
    || !Number.isFinite(value.outputPerMillion) || value.outputPerMillion <= 0
    || typeof value.checkedAt !== 'string' || !value.checkedAt.trim()) {
    throw new CatalogLibraryError('Provide input and output token pricing')
  }
  return structuredClone(value)
}

function checkedExtension(raw: CatalogModel): CatalogModel {
  if (!raw || typeof raw !== 'object' || !/^user-[A-Za-z0-9_-]{1,90}$/.test(raw.id)) throw new CatalogLibraryError('ID add-on must start with user-')
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120) throw new CatalogLibraryError('Provide a model name')
  if (!['image', 'video', 'audio', 'text', 'other'].includes(raw.kind)) throw new CatalogLibraryError('Unknown model type')
  const endpoint = typeof raw.endpoint === 'string' ? normalizeEndpoint(raw.endpoint) : ''
  if (!endpoint) throw new CatalogLibraryError('An official fal.ai link or endpoint ID is required')
  if (!Array.isArray(raw.params) || raw.params.length > 30) throw new CatalogLibraryError('Model parameter descriptions are required')
  const forbidden = new Set(['constructor', 'prototype', '__proto__', 'prompt', 'image_url', 'image_urls', 'video_url', 'video_urls', 'audio_url', 'audio_urls', 'authorization', 'api_key', 'headers', 'webhook_url', 'callback_url', 'sync_mode'])
  const names = new Set<string>()
  for (const spec of raw.params) {
    if (!spec || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(spec.name) || forbidden.has(spec.name) || names.has(spec.name)) throw new CatalogLibraryError('Invalid parameter name')
    names.add(spec.name)
    if (typeof spec.label !== 'string' || !['number', 'slider', 'select', 'boolean', 'textarea', 'seed'].includes(spec.widget)) throw new CatalogLibraryError('Invalid parameter description')
    if (spec.options && (!Array.isArray(spec.options) || !spec.options.length || spec.options.length > 100 || spec.options.some(o => typeof o.value !== 'string' || typeof o.label !== 'string'))) throw new CatalogLibraryError('Invalid parameter values')
    if (spec.widget === 'select' && !spec.options?.length) throw new CatalogLibraryError('Provide selection options')
    if ([spec.min, spec.max, spec.step].some(v => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))) throw new CatalogLibraryError('Invalid parameter bounds')
    if (spec.default !== undefined && !paramValueAllowed(spec, spec.default)) throw new CatalogLibraryError(`Invalid default: ${spec.name}`)
  }
  if (raw.imageInputField !== undefined && !['image_url', 'image_urls'].includes(raw.imageInputField)) throw new CatalogLibraryError('Provide image fields: image_url or image_urls')
  if (raw.videoInputField !== undefined && !['video_url', 'video_urls'].includes(raw.videoInputField)) throw new CatalogLibraryError('Provide video fields: video_url or video_urls')
  if (raw.audioInputField !== undefined && !['audio_url', 'audio_urls'].includes(raw.audioInputField)) throw new CatalogLibraryError('Provide audio fields: audio_url or audio_urls')
  if (raw.videoRefs && !raw.videoInputField) throw new CatalogLibraryError('Provide video fields: video_url or video_urls')
  if (raw.videoInputField && !raw.videoRefs) throw new CatalogLibraryError('Enable video references for video fields')
  if ((raw.imageInputField || raw.videoInputField || raw.audioInputField) && !raw.refs) throw new CatalogLibraryError('Enable references for the input field')
  if (raw.refs && !raw.imageInputField && !raw.videoInputField && !raw.audioInputField) throw new CatalogLibraryError('Provide an image, video, or audio reference field')
  const referenceLimits: Partial<CatalogModel> = {}
  for (const media of ['Image','Video','Audio'] as const) {
    const field = raw[`${media.toLowerCase()}InputField` as 'imageInputField' | 'videoInputField' | 'audioInputField']
    const minName = `min${media}Refs` as const, maxName = `max${media}Refs` as const
    const capacity = field ? field.endsWith('_urls') ? 16 : 1 : 0
    const min = raw[minName] ?? 0, max = raw[maxName] ?? capacity
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min || max > capacity) throw new CatalogLibraryError('Invalid reference count for input fields')
    referenceLimits[minName] = min; referenceLimits[maxName] = max
  }
  for (const [key, value] of Object.entries(raw.defaults ?? {})) {
    if (forbidden.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) throw new CatalogLibraryError('Invalid hidden parameter')
  }
  if (JSON.stringify(raw).length > 64_000) throw new CatalogLibraryError('Model description is too large')
  return { ...structuredClone(raw), ...referenceLimits, endpoint, lifecycle: 'active', contractRevision: `user:${randomUUID()}`, adapterVersion: 2, minExecutorVersion: 2,
    pricingNote: raw.pricingNote ?? 'Local fal estimate. The provider determines the final cost.' }
}

/** User overlays stay outside the replaceable release. Mutations serialize with a revision check. */
export class CatalogLibrary {
  private state = empty()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly bundled: CatalogModel[]
  constructor(private readonly file: string, bundled: readonly CatalogModel[]) { this.bundled = structuredClone([...bundled]) }
  private selectableBase(models: readonly CatalogModel[], slot: CatalogDefaultSlot): CatalogModel[] {
    const pairedIds = new Set(models.flatMap(model => [model.pairId, model.videoPairId].filter((id): id is string => Boolean(id))))
    return models.filter(model => (
      model.kind === SLOT_KIND[slot]
      && model.lifecycle !== 'archived'
      && model.lifecycle !== 'disabled'
      && !pairedIds.has(model.id)
    ))
  }
  private initialDefaults(models: readonly CatalogModel[], legacyAssistantModelId?: string): CatalogDefaults {
    const available = (slot: CatalogDefaultSlot) => this.selectableBase(models, slot)
    const image = available('image')
    const video = available('video')
    const audio = available('audio')
    const assistant = available('assistant')
    return {
      image: image.find(model => model.id === 'chatgpt-image-2')?.id ?? image[0]?.id ?? null,
      video: video.find(model => model.id === DEFAULT_MODEL.video.id)?.id ?? video[0]?.id ?? null,
      audio: audio.find(model => model.id === DEFAULT_MODEL.audio.id)?.id ?? audio[0]?.id ?? null,
      assistant: assistant.find(model => model.id === legacyAssistantModelId)?.id
        ?? assistant.find(model => model.id === DEFAULT_MODEL.text.id)?.id
        ?? assistant[0]?.id
        ?? null,
    }
  }
  private defaultsFor(state = this.state): CatalogDefaults {
    return state.defaults ?? this.initialDefaults(this.modelsFor(state))
  }
  private modelsFor(state: State): CatalogModel[] {
    // Подключённым моделям с оплатой по токенам — официальная таблица fal
    // вместо оценки «за вызов» (см. officialFalPricing.ts); файл не трогаем.
    return [...this.bundled, ...state.extensions.map(withOfficialPricing)].map(model => ({
      ...model,
      lifecycle: state.lifecycle[model.id] ?? model.lifecycle ?? 'active',
    }))
  }
  private async writeState(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2))
      await fs.rename(tmp, this.file)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }
  async load(legacyAssistantModelId?: string): Promise<void> {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8')) as State
      if (!Number.isSafeInteger(state.revision) || !Array.isArray(state.extensions) || !Array.isArray(state.drafts) || !state.lifecycle) throw new Error('Invalid model library')
      if (state.schemaVersion !== undefined && state.schemaVersion !== 2) throw new Error('Invalid model-library version')
      this.state = state
      if (state.schemaVersion !== 2 || !state.defaults || !state.draftMeta) {
        const migrated: State = {
          ...state,
          schemaVersion: 2,
          revision: state.revision + 1,
          defaults: state.defaults ?? this.initialDefaults(this.modelsFor(state), legacyAssistantModelId),
          draftMeta: state.draftMeta ?? {},
        }
        await this.writeState(migrated)
        this.state = migrated
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = empty()
      this.state.defaults = this.initialDefaults(this.modelsFor(this.state), legacyAssistantModelId)
    }
  }
  models(): CatalogModel[] { return this.modelsFor(this.state) }
  view() {
    return {
      revision: this.state.revision,
      release: CATALOG_REVISION,
      models: this.models(),
      drafts: structuredClone(this.state.drafts),
      defaults: structuredClone(this.defaultsFor()),
      draftMeta: structuredClone(this.state.draftMeta ?? {}),
      defaultIssues: this.defaultIssues(),
    }
  }
  private assertDefault(slot: CatalogDefaultSlot, id: string | null, state: State): void {
    if (id === null) return
    if (!this.selectableBase(this.modelsFor(state), slot).some(model => model.id === id)) {
      throw new CatalogLibraryError(`Select the active model for ${SLOT_LABEL[slot]}`)
    }
  }
  private defaultIssues(): string[] {
    const defaults = this.defaultsFor()
    return DEFAULT_SLOTS.flatMap(slot => {
      try {
        this.assertDefault(slot, defaults[slot], this.state)
        return []
      } catch (error) {
        return [error instanceof Error ? error.message : `Invalid model for ${SLOT_LABEL[slot]}`]
      }
    })
  }
  defaultModelId(slot: CatalogDefaultSlot): string | null {
    const saved = this.defaultsFor()[slot]
    if (saved && this.selectableBase(this.models(), slot).some(model => model.id === saved)) return saved
    return this.initialDefaults(this.models())[slot]
  }
  private mutate(expected: number | undefined, change: (next: State) => void | false): Promise<void> {
    const run = this.queue.then(async () => {
      if (expected !== undefined && expected !== this.state.revision) throw new CatalogLibraryError('Catalog changed in other window. Refresh list.', 409)
      const next = structuredClone(this.state)
      if (change(next) === false) return
      next.revision++
      await this.writeState(next)
      this.state = next
    })
    this.queue = run.catch(() => {})
    return run
  }
  setLifecycle(id: string, lifecycle: Lifecycle, expected: number): Promise<void> {
    return this.mutate(expected, next => {
      if (!['active', 'archived', 'disabled'].includes(lifecycle)) throw new CatalogLibraryError('Unknown model state')
      const models = this.modelsFor(next)
      if (!models.some(model => model.id === id)) throw new CatalogLibraryError('Model not found', 404)
      for (const familyId of catalogFamilyIds(models, id)) next.lifecycle[familyId] = lifecycle
    })
  }
  applyLifecycleChange(
    id: string,
    lifecycle: Lifecycle,
    defaultReplacements: Partial<CatalogDefaults>,
    expected: number,
  ): Promise<void> {
    return this.mutate(expected, next => {
      if (!['active', 'archived', 'disabled'].includes(lifecycle)) throw new CatalogLibraryError('Unknown model state')
      const models = this.modelsFor(next)
      if (!models.some(model => model.id === id)) throw new CatalogLibraryError('Model not found', 404)
      for (const familyId of catalogFamilyIds(models, id)) next.lifecycle[familyId] = lifecycle
      const defaults = { ...this.defaultsFor(next), ...defaultReplacements }
      for (const slot of DEFAULT_SLOTS) this.assertDefault(slot, defaults[slot], next)
      next.defaults = defaults
    })
  }
  setDefaults(patch: Partial<CatalogDefaults>, expected: number): Promise<void> {
    return this.mutate(expected, next => {
      const defaults = { ...this.defaultsFor(next), ...patch }
      for (const slot of DEFAULT_SLOTS) this.assertDefault(slot, defaults[slot], next)
      next.defaults = defaults
    })
  }
  saveDraft(model: CatalogModel, expected: number): Promise<void> {
    return this.mutate(expected, next => {
      const checked = checkedExtension(model)
      if (next.extensions.some(item => item.id === checked.id)) throw new CatalogLibraryError('This ID is already published. Use a new ID for a new version; existing macros keep the previous model.', 409)
      const endpointTaken = this.bundled.some(item => normalizeEndpoint(item.endpoint) === checked.endpoint)
        || next.extensions.some(item => normalizeEndpoint(item.endpoint) === checked.endpoint)
        || next.drafts.some(item => item.id !== checked.id && normalizeEndpoint(item.endpoint) === checked.endpoint)
      if (endpointTaken) throw new CatalogLibraryError('A model with this endpoint is already in the library. Use another endpoint for a new version.', 409)
      next.drafts = [...next.drafts.filter(m => m.id !== checked.id), checked]
      const previous = next.draftMeta?.[checked.id]
      const definitionHash = catalogDefinitionHash(checked)
      const testMatches = previous?.test?.definitionHash === definitionHash
      next.draftMeta ??= {}
      next.draftMeta[checked.id] = {
        ...previous,
        definitionHash,
        test: testMatches ? previous?.test : undefined,
        testInvalidatedAt: previous?.test && !testMatches ? Date.now() : previous?.testInvalidatedAt,
      }
    })
  }
  updateDraftTariff(
    id: string,
    input: {
      pricing?: MediaPricing
      textPricing?: TextTokenPricing
      tariffSourceUrl: string
      pricingNote?: string
    },
    expected: number,
  ): Promise<void> {
    return this.mutate(expected, next => {
      const index = next.drafts.findIndex(model => model.id === id)
      if (index < 0) throw new CatalogLibraryError('Model draft not found', 404)
      const current = next.drafts[index]
      const updated: CatalogModel = current.kind === 'text' && input.pricing?.unit !== 'call'
        ? { ...current, pricing: undefined, textPricing: checkedTextPricing(input.textPricing) }
        : { ...current, pricing: checkedMediaPricing(input.pricing), textPricing: undefined }
      next.drafts[index] = updated
      const definitionHash = catalogDefinitionHash(updated)
      const tariffHash = catalogTariffHash(updated)
      const previous = next.draftMeta?.[id]
      const testMatches = previous?.test?.definitionHash === definitionHash && previous.test.tariffHash === tariffHash
      next.draftMeta ??= {}
      next.draftMeta[id] = {
        ...previous,
        tariffSourceUrl: officialFalUrl(input.tariffSourceUrl),
        tariffConfirmedAt: Date.now(),
        definitionHash,
        tariffHash,
        test: testMatches ? previous?.test : undefined,
        testInvalidatedAt: previous?.test && !testMatches ? Date.now() : previous?.testInvalidatedAt,
      }
      if (input.pricingNote !== undefined) next.drafts[index].pricingNote = input.pricingNote
    })
  }
  recordDraftTest(id: string, receipt: NonNullable<CatalogDraftMeta['test']>, expected?: number): Promise<void> {
    return this.mutate(expected, next => {
      if (!next.drafts.some(model => model.id === id)) throw new CatalogLibraryError('Model draft not found', 404)
      if (!receipt || typeof receipt.jobId !== 'string' || !receipt.jobId
        || !Number.isFinite(receipt.completedAt)
        || !['image', 'video', 'audio', 'text'].includes(receipt.resultKind)
        || receipt.actualCostUsd !== null && (!Number.isFinite(receipt.actualCostUsd) || receipt.actualCostUsd < 0)
        || !/^[a-f0-9]{64}$/.test(receipt.definitionHash)
        || !/^[a-f0-9]{64}$/.test(receipt.tariffHash)) {
        throw new CatalogLibraryError('Invalid model test result')
      }
      next.draftMeta ??= {}
      const previous = next.draftMeta[id]
      if (previous?.test && stableJson(previous.test) === stableJson(receipt)) return false
      next.draftMeta[id] = { ...previous, test: structuredClone(receipt), testInvalidatedAt: undefined }
    })
  }
  publish(id: string, expected: number): Promise<void> {
    return this.mutate(expected, next => {
      const draft = next.drafts.find(m => m.id === id)
      if (!draft) throw new CatalogLibraryError('Verified draft not found', 404)
      if (next.extensions.some(item => item.id === id)) throw new CatalogLibraryError('This ID already published', 409)
      const endpointTaken = this.bundled.some(item => normalizeEndpoint(item.endpoint) === draft.endpoint)
        || next.extensions.some(item => normalizeEndpoint(item.endpoint) === draft.endpoint)
      if (endpointTaken) throw new CatalogLibraryError('This model with such endpoint already has in library.', 409)
      const meta = next.draftMeta?.[id]
      if (!meta?.tariffConfirmedAt || !meta.tariffHash) throw new CatalogLibraryError('Confirm model pricing')
      if (!meta.test && meta.testInvalidatedAt) {
        throw new CatalogLibraryError('The test schema or pricing changed. Run the test from scratch.', 409)
      }
      if (!meta.test) throw new CatalogLibraryError('Run the paid model test first')
      if (meta.test.definitionHash !== catalogDefinitionHash(draft) || meta.test.tariffHash !== catalogTariffHash(draft)) {
        throw new CatalogLibraryError('The test schema or pricing changed. Run the test from scratch.', 409)
      }
      next.extensions = [...next.extensions.filter(m => m.id !== id), draft]
      next.drafts = next.drafts.filter(m => m.id !== id)
      if (next.draftMeta) delete next.draftMeta[id]
    })
  }
}

/** All catalog variants linked by either direction of pair/videoPair relations. */
export function catalogFamilyIds(models: readonly CatalogModel[], id: string): string[] {
  const known = new Map(models.map(model => [model.id, model]))
  if (!known.has(id)) return [id]
  const family = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const model of models) {
      const links = [model.pairId, model.videoPairId].filter((value): value is string => Boolean(value))
      if (family.has(model.id) || links.some(link => family.has(link))) {
        if (!family.has(model.id)) { family.add(model.id); changed = true }
        for (const link of links) {
          if (known.has(link) && !family.has(link)) { family.add(link); changed = true }
        }
      }
    }
  }
  return [...family]
}

export const catalogLibrary = new CatalogLibrary(path.join(path.dirname(config.projectFile), 'catalog-library.json'), CATALOG)
export function applyCatalogLibrary(): void { replaceRuntimeCatalog(catalogLibrary.models()) }
