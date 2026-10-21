import type { CatalogDefaults, CatalogLibraryView, CatalogModel, JobKind, ModelLifecycle } from '../types.js'
import { t } from '../i18n/translate.js'
import { getIntlLocale } from '../i18n/language.js'

export type CatalogKindFilter = 'all' | JobKind
export type CatalogLifecycleFilter = 'all' | ModelLifecycle

export interface CatalogFilters {
  query: string
  kind: CatalogKindFilter
  lifecycle: CatalogLifecycleFilter
}

export interface CatalogRow extends CatalogModel {
  lifecycle: ModelLifecycle
  availableForNewChoice: boolean
  executable: boolean
  priceSummary: string
  defaultSlots: Array<keyof CatalogDefaults>
  origin: 'built-in' | 'local'
  draft: boolean
}

function usd(value: number): string {
  return `$${value.toLocaleString(getIntlLocale(), { maximumFractionDigits: 6 })}`
}

export function modelPriceSummary(model: CatalogModel): string {
  if (model.kind === 'text' && model.textPricing) {
    return `${usd(model.textPricing.inputPerMillion)} ${t('input')} · ${usd(model.textPricing.outputPerMillion)} ${t('output')} / 1M`
  }
  const pricing = model.pricing
  if (!pricing) return model.pricingNote || t('Price not set')
  const unit = pricing.unit === 'second' ? t('second') : t('result')
  return `${usd(pricing.usd)} / ${unit}`
}

export function catalogRows(
  models: CatalogModel[],
  filters: CatalogFilters,
  context?: Pick<CatalogLibraryView, 'defaults' | 'drafts'>,
): CatalogRow[] {
  const query = filters.query.trim().toLocaleLowerCase('en-US')
  const draftIds = new Set(context?.drafts.map(model => model.id) ?? [])
  const defaults = context?.defaults
  return models.map(model => {
    const lifecycle = model.lifecycle ?? 'active'
    const draft = draftIds.has(model.id)
    return {
      ...model,
      lifecycle,
      draft,
      availableForNewChoice: lifecycle === 'active' && !draft,
      executable: lifecycle !== 'disabled' && !draft,
      priceSummary: modelPriceSummary(model),
      defaultSlots: defaults
        ? (Object.entries(defaults) as Array<[keyof CatalogDefaults, string | null]>)
          .filter(([, id]) => id === model.id).map(([slot]) => slot)
        : [],
      origin: model.id.startsWith('user-') ? 'local' as const : 'built-in' as const,
    }
  }).filter(row => (
    (!query || `${row.name}\n${row.endpoint ?? row.id}`.toLocaleLowerCase('en-US').includes(query))
    && (filters.kind === 'all' || row.kind === filters.kind)
    && (filters.lifecycle === 'all' || row.lifecycle === filters.lifecycle)
  ))
}
