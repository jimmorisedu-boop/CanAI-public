import { useMemo, useState } from 'react'
import { apiRequest } from '../api.js'
import type { CatalogDefaults, CatalogLibraryView, LifecyclePlan, ModelLifecycle } from '../types.js'
import { InlineNotice } from '../ui/InlineNotice.js'
import { catalogLibraryClient, CatalogConflictError } from './catalogLibraryClient.js'
import {
  catalogRows,
  type CatalogFilters,
  type CatalogKindFilter,
  type CatalogLifecycleFilter,
} from './modelCatalogViewModel.js'
import { useT } from '../i18n/context.js'


const kindLabels = { image: 'Image', video: 'Video', audio: 'Audio', text: 'Assistant', other: 'Other' }
const lifecycleLabels = { active: 'Active', archived: 'Archived', disabled: 'Disabled' }
const slotLabels: Record<keyof CatalogDefaults, string> = {
  image: 'Image', video: 'Video', audio: 'Audio', assistant: 'Assistant',
}

export function ModelCatalogList({
  library,
  disabled,
  selectedId,
  onSelect,
  onLibrary,
  onAdd,
}: {
  library: CatalogLibraryView
  disabled: boolean
  selectedId?: string
  onSelect?(id: string): void
  onLibrary(next: CatalogLibraryView): void
  onAdd(): void
}) {
  const t = useT()
  const [filters, setFilters] = useState<CatalogFilters>({ query: '', kind: 'all', lifecycle: 'all' })
  const [plan, setPlan] = useState<LifecyclePlan | null>(null)
  const [defaultReplacements, setDefaultReplacements] = useState<Partial<CatalogDefaults>>({})
  const [macroReplacements, setMacroReplacements] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const rows = useMemo(() => catalogRows(library.models, filters, library), [library, filters])

  function patchFilters(patch: Partial<CatalogFilters>): void {
    setFilters(current => ({ ...current, ...patch }))
  }

  async function refreshAfterConflict(modelId: string, target: ModelLifecycle): Promise<void> {
    const next = await catalogLibraryClient.load(apiRequest)
    onLibrary(next)
    const freshPlan = await catalogLibraryClient.planLifecycle(apiRequest, modelId, target)
    const valid = new Set(freshPlan.replacementModels.map(model => model.id))
    setDefaultReplacements(current => Object.fromEntries(Object.entries(current).filter(([, id]) => id && valid.has(id))) as Partial<CatalogDefaults>)
    setMacroReplacements(current => Object.fromEntries(Object.entries(current).filter(([, id]) => valid.has(id))))
    setPlan(freshPlan)
  }

  async function applyPlan(current: LifecyclePlan, defaults = defaultReplacements, macros = macroReplacements): Promise<void> {
    const next = await catalogLibraryClient.applyLifecycle(apiRequest, current.modelId, {
      operationId: current.operationId,
      defaultReplacements: defaults,
      macroReplacements: macros,
    })
    onLibrary(next); setPlan(null); setDefaultReplacements({}); setMacroReplacements({})
    setMessage(current.target === 'active' ? t('Model returned to catalog.') : current.target === 'archived' ? t('Model moved to archive.') : t('Model disabled; dependencies moved.'))
  }

  async function requestLifecycle(modelId: string, target: ModelLifecycle): Promise<void> {
    setBusy(true); setError(''); setMessage('')
    try {
      const nextPlan = await catalogLibraryClient.planLifecycle(apiRequest, modelId, target)
      if (target === 'active' || (nextPlan.affectedDefaults.length === 0 && nextPlan.macros.length === 0)) {
        await applyPlan(nextPlan, {}, {})
      } else {
        setPlan(nextPlan); setDefaultReplacements({}); setMacroReplacements({})
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not change model state'))
    } finally { setBusy(false) }
  }

  async function submitPlan(): Promise<void> {
    if (!plan) return
    setBusy(true); setError(''); setMessage('')
    try { await applyPlan(plan) }
    catch (cause) {
      if (cause instanceof CatalogConflictError) {
        try { await refreshAfterConflict(plan.modelId, plan.target) }
        catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : t('Could not refresh plan')) }
        setError(t('The catalog changed in another window. The plan was refreshed; check replacements.'))
      } else setError(cause instanceof Error ? cause.message : t('Could not apply plan'))
    } finally { setBusy(false) }
  }

  const planComplete = plan
    ? plan.affectedDefaults.every(slot => Boolean(defaultReplacements[slot]))
      && plan.macros.every(macro => Boolean(macroReplacements[macro.id]))
    : false

  return <section className="settings-section catalog-library" aria-labelledby="catalog-library-title">
    <div className="settings-section-heading catalog-panel-heading"><div>
      <h3 id="catalog-library-title">{t('Local model library')}</h3>
      <p>{t('Archive hides a model from new choices while saved boards keep working. Disabling blocks new runs.')}</p>
    </div><button type="button" className="generate" disabled={disabled || busy} onClick={onAdd}>{t('Add model')}</button></div>
    {error && <InlineNotice tone="error" title={error} />}
    {message && <InlineNotice tone="success" title={message} />}
    <div className="catalog-filters">
      <label className="settings-label catalog-search">{t('Search')}<input type="search" value={filters.query} placeholder={t('Name or endpoint')} onChange={event => patchFilters({ query: event.target.value })} /></label>
      <label className="settings-label">{t('Type')}<select value={filters.kind} onChange={event => patchFilters({ kind: event.target.value as CatalogKindFilter })}>
        <option value="all">{t('All types')}</option><option value="image">{t('Image')}</option><option value="video">{t('Video')}</option><option value="audio">{t('Audio')}</option><option value="text">{t('Assistant')}</option>
      </select></label>
      <label className="settings-label">{t('Status')}<select value={filters.lifecycle} onChange={event => patchFilters({ lifecycle: event.target.value as CatalogLifecycleFilter })}>
        <option value="all">{t('All statuses')}</option><option value="active">{t('Active')}</option><option value="archived">{t('Archived')}</option><option value="disabled">{t('Disabled')}</option>
      </select></label>
    </div>
    <div className="catalog-model-list" aria-live="polite">
      {rows.map(row => <article key={row.id} className="catalog-model-card" data-selected={selectedId === row.id || undefined}>
        <div className="catalog-model-main">
          <div className="catalog-model-title"><h4>{row.name}</h4><span className="catalog-badge" data-lifecycle={row.lifecycle}>{t(lifecycleLabels[row.lifecycle])}</span></div>
          <code>{row.endpoint ?? row.id}</code>
          <div className="catalog-model-meta">
            <span>{t(kindLabels[row.kind])}</span><span>{row.priceSummary}</span><span>{row.refs ? t('With references') : t('No references')}</span><span>{row.origin === 'local' ? t('Added locally') : t('Built-in')}</span>
          </div>
      {!!row.defaultSlots.length && <div className="catalog-default-badges">{row.defaultSlots.map(slot => <span key={slot}>{t('Default: {0}', { 0: t(slotLabels[slot]) })}</span>)}</div>}
        </div>
        <div className="catalog-model-actions">
          {row.lifecycle === 'active' ? <>
            <button type="button" className="editor-close" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'archived') }}>{t('Archive')}</button>
            <button type="button" className="editor-close danger-text" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'disabled') }}>{t('Disable')}</button>
          </> : <button type="button" className="editor-close" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'active') }}>{t('Restore')}</button>}
        </div>
      </article>)}
      {!rows.length && <p className="settings-note">{t('No models match these filters.')}</p>}
    </div>
    {plan && <div className="catalog-impact" role="region" aria-label={t('Model replacement plan')}>
      <h4>{plan.target === 'disabled' ? t('Move dependencies before disabling') : t('Change default models before archiving')}</h4>
      {plan.affectedDefaults.map(slot => <label className="settings-label" key={slot}>{t('Default · {0}', { 0: t(slotLabels[slot]) })}
        <select value={defaultReplacements[slot] ?? ''} onChange={event => setDefaultReplacements(current => ({ ...current, [slot]: event.target.value }))}>
          <option value="">{t('Choose replacement')}</option>{plan.replacementModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>)}
      {plan.macros.map(macro => <label className="settings-label" key={macro.id}>{t('Macro “{0}” · {1} {2}', { 0: macro.name, 1: macro.nodeIds.length, 2: t('nodes') })}
        <select value={macroReplacements[macro.id] ?? ''} onChange={event => setMacroReplacements(current => ({ ...current, [macro.id]: event.target.value }))}>
          <option value="">{t('Choose replacement')}</option>{plan.replacementModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>)}
      <div className="catalog-library-row">
        <button type="button" className="generate" disabled={busy || !planComplete} onClick={() => void submitPlan()}>{t('Apply plan')}</button>
        <button type="button" className="editor-close" disabled={busy} onClick={() => setPlan(null)}>{t('Cancel')}</button>
      </div>
    </div>}
  </section>
}
