import { config } from './config.js'
import { CatalogLibraryError } from './catalogLibrary.js'
import { normalizeEndpoint, type CatalogModel, type MediaPricing, type TextTokenPricing } from './catalog.js'
import type { IncomingRef } from './refs.js'
import { hasOfficialFalTable } from './officialFalPricing.js'

type JsonObject = Record<string, unknown>

export interface FalModelTestInput {
  prompt: string
  refs: IncomingRef[]
  params: Record<string, unknown>
}

export interface FalModelTestSample {
  kind: 'image' | 'video' | 'audio'
  name: string
  url: string
}

export interface FalModelTestSamples {
  input: FalModelTestInput
  samples: FalModelTestSample[]
}

export type FalModelTestSamplesBuilder = (model: CatalogModel) => Promise<FalModelTestSamples>

export interface FalModelSetupPricing {
  sourceUrl: string
  note: string
  amountUsd: number
  approximate: boolean
  unit?: string
}

export interface FalModelSetupResult {
  input: FalModelTestInput
  pricing: FalModelSetupPricing | null
  samples: FalModelTestSample[]
  warnings: string[]
  /** Internal tariff to persist through CatalogLibrary.updateDraftTariff. */
  persist?: {
    pricing?: MediaPricing
    textPricing?: TextTokenPricing
    sourceUrl: string
    pricingNote: string
  }
}

export interface FalModelSetupDependencies {
  fetcher?: typeof fetch
  falKey?: string | null
  buildSamples: FalModelTestSamplesBuilder
  now?: () => string
}

export class FalModelSetupError extends CatalogLibraryError {
  constructor(message: string, status = 502) { super(message, status) }
}

const API_ORIGIN = 'https://api.fal.ai'
const PAGE_ORIGIN = 'https://fal.ai'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

const object = (value: unknown): JsonObject => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
)

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function apiPricingUrl(endpoint: string): string {
  return `${API_ORIGIN}/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`
}

function apiEstimateUrl(): string { return `${API_ORIGIN}/v1/models/pricing/estimate` }

function modelPageUrl(endpoint: string): string { return `${PAGE_ORIGIN}/models/${endpoint}` }

async function readBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new FalModelSetupError('The pricing catalog returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new FalModelSetupError('The pricing catalog response is too large', 502)
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

async function fetchBody(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: Buffer }> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { response, body: await readBody(response) }
  } catch (error) {
    if (error instanceof FalModelSetupError) throw error
    // Never echo provider responses or request headers; they can contain account
    // details and the caller only needs an actionable retry message.
    throw new FalModelSetupError('Could not get fal pricing; try again later.', 502)
  }
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: JsonObject }> {
  const result = await fetchBody(fetcher, url, init)
  let parsed: unknown
  try { parsed = JSON.parse(result.body.toString('utf8')) } catch {
    throw new FalModelSetupError('fal.ai returned pricing in an invalid format', 502)
  }
  return { response: result.response, body: object(parsed) }
}

function authHeaders(key: string | null | undefined): HeadersInit {
  return {
    accept: 'application/json',
    ...(key ? { authorization: `Key ${key}` } : {}),
  }
}

function findPrice(body: JsonObject, endpoint: string): JsonObject | null {
  const prices = Array.isArray(body.prices) ? body.prices : []
  const rows = prices.filter((value): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
  // The endpoint filter is part of the request, but keep the response check
  // strict so a malformed/proxied list can never price the wrong model.
  return rows.find(row => row.endpoint_id === endpoint) ?? null
}

function estimateMediaAmount(model: CatalogModel, pricing: MediaPricing, input: FalModelTestInput): number {
  if (pricing.unit === 'call') return pricing.usd
  let rate = pricing.usd
  const params = input.params
  const matrix = pricing.byParams
  const matrixKey = matrix?.names.map(name => {
    const spec = (model.params ?? []).find(item => item.name === name)
    return String(params[name] ?? model.defaults?.[name] ?? spec?.default ?? '')
  }).join('|')
  const matrixRate = matrixKey ? matrix?.usd[matrixKey] : undefined
  if (matrixRate !== undefined) rate = matrixRate
  else if (pricing.byParam) {
    const spec = (model.params ?? []).find(item => item.name === pricing.byParam!.name)
    const selected = params[pricing.byParam.name] ?? model.defaults?.[pricing.byParam.name] ?? spec?.default
    const selectedRate = selected === undefined ? undefined : pricing.byParam.usd[String(selected)]
    if (selectedRate !== undefined) rate = selectedRate
  }
  let units = 1
  if (pricing.unit === 'second') {
    const durationSpec = (model.params ?? []).find(item => item.name === 'duration')
    const duration = Number(params.duration ?? model.defaults?.duration ?? durationSpec?.default ?? pricing.defaultDuration ?? 8)
    if (Number.isFinite(duration) && duration > 0) units = duration
  }
  const references = input.refs.filter(ref => ref.kind !== 'text').length
  const referenceCost = references * (pricing.perReferenceUsd ?? 0)
    + Math.max(0, references - 1) * (pricing.additionalReferenceUsd ?? 0)
  return Math.round((rate * units + referenceCost) * 1_000_000) / 1_000_000
}

function unitPrice(
  model: CatalogModel,
  row: JsonObject,
  sourceUrl: string,
  input: FalModelTestInput,
): { display: FalModelSetupPricing; persist?: FalModelSetupResult['persist']; warning?: string } | null {
  const amount = positiveNumber(row.unit_price)
  const rawUnit = typeof row.unit === 'string' ? row.unit.trim().toLowerCase() : ''
  const unit = rawUnit === 'images' ? 'image' : rawUnit === 'seconds' ? 'second' : rawUnit
  const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : ''
  if (!amount || currency !== 'USD') return null
  if ((unit === 'megapixel' || unit === 'megapixels') && model.kind === 'image'
    && normalizeEndpoint(model.endpoint) === 'krea/v3/edit') {
    // Krea bills output + inputs (each input is capped at output size), with
    // 1 MP = 1024² pixels. Use the documented maximum output area so auto size
    // and replacement references remain covered without inspecting user media.
    // https://fal.ai/models/krea/v3/edit (billing), /api (area + reasoning).
    const outputCost = amount * 4_220_160 / (1024 * 1024)
    const pricing: MediaPricing = {
      unit: 'image',
      usd: outputCost,
      perReferenceUsd: outputCost,
      byParam: { name: 'reasoning_level', usd: { low: outputCost, medium: outputCost, high: outputCost + 5 * amount } },
    }
    const note = `Krea megapixel upper estimate at $${amount}/MP (1 MP = 1024×1024 pixels): up to 4,220,160 output pixels plus the same allowance per reference; high reasoning adds 5 MP. Actual fal usage can be lower.`
    return {
      display: { sourceUrl, note, amountUsd: estimateMediaAmount(model, pricing, input), approximate: true, unit: 'image' },
      persist: { pricing, sourceUrl, pricingNote: note },
    }
  }
  if (unit !== 'image' && unit !== 'second') {
    return {
      display: { sourceUrl, note: `fal.ai returned pricing in units «${rawUnit || 'unknown'}”; these units cannot be safely mapped to CanAI usage.`, amountUsd: amount, approximate: true, unit: rawUnit || undefined },
      warning: 'Unit pricing from fal is not supported for automatic quotes; check the API and try again.',
    }
  }
  if (model.kind === 'text') {
    return {
      display: { sourceUrl, note: `Pricing fal: ${amount} USD for ${unit}; text models require separate input and output token pricing.`, amountUsd: amount, approximate: true, unit },
      warning: 'The fal pricing API returned result pricing, but text models require separate input and output token pricing; check the API.',
    }
  }
  // Unit prices are authoritative for this endpoint. Input/reference and
  // parameter-specific adjustments are still provider-dependent, so the UI
  // receives the base amount while quoteDraftTest applies known local rules.
  const pricing: MediaPricing = { unit, usd: amount }
  return {
    display: { sourceUrl, note: `Base fal pricing: ${amount} USD for ${unit}. The total depends on settings and source files.`, amountUsd: estimateMediaAmount(model, pricing, input), approximate: true, unit },
    persist: { pricing, sourceUrl, pricingNote: `Fal pricing confirmed by the API (${amount} USD for ${unit}); the total depends on request parameters.` },
  }
}

function historicalPrice(
  model: CatalogModel,
  body: JsonObject,
  sourceUrl: string,
): { display: FalModelSetupPricing; persist: NonNullable<FalModelSetupResult['persist']>; warning: string } | null {
  const amount = positiveNumber(body.total_cost)
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
  if (!amount || currency !== 'USD' || body.estimate_type !== 'historical_api_price') return null
  const note = `Fal historical estimate for one call (${amount} USD); usage depends on parameters and tokens.`
  return {
    display: {
      sourceUrl,
      note,
      amountUsd: amount,
      approximate: true,
      unit: 'call',
    },
    persist: { pricing: { unit: 'call', usd: amount }, sourceUrl, pricingNote: note },
    warning: 'An estimated price for one call was saved; the total depends on parameters and tokens.',
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function visibleText(html: string): string {
  return decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\n/g, '\n'))
    .replace(/\s+/g, ' ')
    .trim()
}

interface NanoTable { byResolution: Record<string, number>; referenceIncrement: number }

function parseNanoTable(html: string): NanoTable | null {
  const text = visibleText(html)
  const marker = text.indexOf('Output resolution')
  if (marker < 0) return null
  const section = text.slice(marker, marker + 2_500)
  if (!/Output resolution[\s\S]{0,240}Text-to-image[\s\S]{0,240}Edit with two 1K input images/i.test(section)) return null
  const byResolution: Record<string, number> = {}
  const deltas: number[] = []
  const row = /\b(0\.5K|1K|2K|4K)\b\s+\$([0-9]+(?:\.[0-9]+)?)\s+\$([0-9]+(?:\.[0-9]+)?)/g
  for (const match of section.matchAll(row)) {
    const resolution = match[1]
    const baseline = Number(match[2])
    const edit = Number(match[3])
    if (!Object.prototype.hasOwnProperty.call(byResolution, resolution) && Number.isFinite(baseline) && baseline > 0
      && Number.isFinite(edit) && edit > baseline) {
      byResolution[resolution] = baseline
      deltas.push(edit - baseline)
    }
  }
  if (!byResolution['1K'] || !byResolution['2K'] || !byResolution['4K'] || deltas.length < 3) return null
  const referenceDelta = deltas[0]
  if (!deltas.every(delta => Math.abs(delta - referenceDelta) < 1e-6)) return null
  const referenceIncrement = referenceDelta / 2
  return { byResolution, referenceIncrement: Number.isFinite(referenceIncrement) && referenceIncrement > 0
    ? Math.round(referenceIncrement * 1_000_000) / 1_000_000
    : 0 }
}

function parseNanoPricing(model: CatalogModel, html: string, sourceUrl: string, input: FalModelTestInput): {
  display: FalModelSetupPricing
  persist: NonNullable<FalModelSetupResult['persist']>
} | null {
  const table = parseNanoTable(html)
  if (!table) return null
  const resolutionSpec = (model.params ?? []).find(spec => spec.name === 'resolution')
  const resolution = typeof resolutionSpec?.default === 'string' && table.byResolution[resolutionSpec.default]
    ? resolutionSpec.default
    : '1K'
  const base = table.byResolution[resolution]
  const references = input.refs.filter(ref => ref.kind !== 'text').length
  const amount = base + references * table.referenceIncrement
  const sourcePage = sourceUrl
  const note = `Estimate from the official fal table (${resolution}: $${base.toFixed(3)} without inputs; +$${table.referenceIncrement.toFixed(3)} per input). Price depends on text/thinking tokens, resolution, and video/PDF duration.`
  const pricing: MediaPricing = {
    unit: 'image',
    usd: base,
    byParam: { name: 'resolution', usd: table.byResolution },
    ...(table.referenceIncrement > 0 ? { perReferenceUsd: table.referenceIncrement } : {}),
  }
  return {
    display: { sourceUrl: sourcePage, note, amountUsd: Math.round(amount * 1_000_000) / 1_000_000, approximate: true, unit: 'image' },
    persist: { pricing, sourceUrl: sourcePage, pricingNote: note },
  }
}

async function resolvePricing(
  model: CatalogModel,
  input: FalModelTestInput,
  dependencies: Required<Pick<FalModelSetupDependencies, 'fetcher' | 'falKey'>>,
): Promise<{ pricing: FalModelSetupPricing | null; persist?: FalModelSetupResult['persist']; warnings: string[] }> {
  const endpoint = normalizeEndpoint(model.endpoint)
  if (!endpoint) return { pricing: null, warnings: ['Model endpoint not recognized; pricing was not requested.'] }
  const fetcher = dependencies.fetcher
  const warnings: string[] = []
  // Nano Banana 2.1 (text-to-image and edit) publishes a canonical resolution
  // table on its official page. It goes FIRST, before the pricing API: a flat
  // unit or per-call price has no resolution steps, and one sum for 1K and 4K
  // overstated 1K twice and understated 4K by half. Arbitrary model pages are
  // never fetched or scraped for prices.
  if (hasOfficialFalTable(endpoint)) {
    const sourceUrl = modelPageUrl(endpoint)
    try {
      const result = await fetchBody(fetcher, sourceUrl, { headers: { accept: 'text/html' } })
      if (result.response.ok) {
        const parsed = parseNanoPricing(model, result.body.toString('utf8'), sourceUrl, input)
        if (parsed) return { pricing: parsed.display, persist: parsed.persist, warnings }
      }
    } catch {
      warnings.push('The official Nano Banana 2.1 table is unavailable; prepare again later.')
    }
  }
  const apiUrl = apiPricingUrl(endpoint)
  if (dependencies.falKey) {
    try {
      const result = await fetchJson(fetcher, apiUrl, { headers: authHeaders(dependencies.falKey) })
      if (result.response.ok) {
        const parsed = unitPrice(model, findPrice(result.body, endpoint) ?? {}, apiUrl, input)
        if (parsed) {
          if (parsed.warning) warnings.push(parsed.warning)
          else if (parsed.persist) return { pricing: parsed.display, persist: parsed.persist, warnings }
          else return { pricing: parsed.display, warnings }
        }
        warnings.push('The fal pricing API returned no price in supported units.')
      }
    } catch {
      warnings.push('The fal pricing API is unavailable; checking the official model source.')
    }
  }

  if (dependencies.falKey) {
    try {
      const result = await fetchJson(fetcher, apiEstimateUrl(), {
        method: 'POST',
        headers: { ...authHeaders(dependencies.falKey), 'content-type': 'application/json' },
        body: JSON.stringify({ estimate_type: 'historical_api_price', endpoints: { [endpoint]: { call_quantity: 1 } } }),
      })
      if (result.response.ok) {
        const parsed = historicalPrice(model, result.body, apiEstimateUrl())
        if (parsed) return { pricing: parsed.display, persist: parsed.persist, warnings: [...warnings, parsed.warning] }
      }
      warnings.push('The historical fal estimate is unavailable; try again later.')
    } catch {
      warnings.push('The historical fal estimate is unavailable; try again later.')
    }
  } else {
    warnings.push('For exact fal pricing, add your fal.ai key in Settings.')
  }
  if (!warnings.some(warning => /тариф|оценка|pricing|estimate/i.test(warning))) {
    warnings.push('Confirmed fal pricing was not received. Check the fal.ai key and try again.')
  }
  return { pricing: null, warnings }
}

export async function prepareFalModelSetup(
  model: CatalogModel,
  dependencies: FalModelSetupDependencies,
): Promise<FalModelSetupResult> {
  const samples = await dependencies.buildSamples(model)
  if (!samples || !samples.input || !Array.isArray(samples.samples)) {
    throw new FalModelSetupError('Could not prepare local files for test', 500)
  }
  const pricing = await resolvePricing(model, samples.input, {
    // All pricing fallbacks share a deadline shorter than the client's 30s
    // request timeout, rather than stacking three independent 15s waits.
    fetcher: (() => {
      const underlying = dependencies.fetcher ?? fetch
      const deadline = AbortSignal.timeout(25_000)
      const bounded: typeof fetch = (url, init) => underlying(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
      })
      return bounded
    })(),
    falKey: dependencies.falKey === undefined ? config.falKey : dependencies.falKey,
  })
  return {
    input: structuredClone(samples.input),
    samples: structuredClone(samples.samples),
    pricing: pricing.pricing,
    warnings: pricing.warnings,
    ...(pricing.persist ? { persist: pricing.persist } : {}),
  }
}

export const falModelSetupInternals = {
  parseNanoTable,
  parseNanoPricing,
  unitPrice,
  historicalPrice,
  modelPageUrl,
  apiPricingUrl,
}
