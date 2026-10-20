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
    setMessage(current.target === 'active' ? 'Model returned to catalog.' : current.target === 'archived' ? 'Model moved to archive.' : 'Model disabled; dependencies moved.')
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
      setError(cause instanceof Error ? cause.message : 'Could not change model state')
    } finally { setBusy(false) }
  }

  async function submitPlan(): Promise<void> {
    if (!plan) return
    setBusy(true); setError(''); setMessage('')
    try { await applyPlan(plan) }
    catch (cause) {
      if (cause instanceof CatalogConflictError) {
        try { await refreshAfterConflict(plan.modelId, plan.target) }
        catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh plan') }
        setError('The catalog changed in another window. The plan was refreshed; check replacements.')
      } else setError(cause instanceof Error ? cause.message : 'Could not apply plan')
    } finally { setBusy(false) }
  }

  const planComplete = plan
    ? plan.affectedDefaults.every(slot => Boolean(defaultReplacements[slot]))
      && plan.macros.every(macro => Boolean(macroReplacements[macro.id]))
    : false

  return <section className="settings-section catalog-library" aria-labelledby="catalog-library-title">
    <div className="settings-section-heading catalog-panel-heading"><div>
      <h3 id="catalog-library-title">Local model library</h3>
      <p>Archive hides a model from new choices while saved boards keep working. Disabling blocks new runs.</p>
    </div><button type="button" className="generate" disabled={disabled || busy} onClick={onAdd}>Add model</button></div>
    {error && <InlineNotice tone="error" title={error} />}
    {message && <InlineNotice tone="success" title={message} />}
    <div className="catalog-filters">
      <label className="settings-label catalog-search">Search<input type="search" value={filters.query} placeholder="Name or endpoint" onChange={event => patchFilters({ query: event.target.value })} /></label>
      <label className="settings-label">Type<select value={filters.kind} onChange={event => patchFilters({ kind: event.target.value as CatalogKindFilter })}>
        <option value="all">All types</option><option value="image">Image</option><option value="video">Video</option><option value="audio">Audio</option><option value="text">Assistant</option>
      </select></label>
      <label className="settings-label">Status<select value={filters.lifecycle} onChange={event => patchFilters({ lifecycle: event.target.value as CatalogLifecycleFilter })}>
        <option value="all">All statuses</option><option value="active">Active</option><option value="archived">Archived</option><option value="disabled">Disabled</option>
      </select></label>
    </div>
    <div className="catalog-model-list" aria-live="polite">
      {rows.map(row => <article key={row.id} className="catalog-model-card" data-selected={selectedId === row.id || undefined}>
        <div className="catalog-model-main">
          <div className="catalog-model-title"><h4>{row.name}</h4><span className="catalog-badge" data-lifecycle={row.lifecycle}>{lifecycleLabels[row.lifecycle]}</span></div>
          <code>{row.endpoint ?? row.id}</code>
          <div className="catalog-model-meta">
            <span>{kindLabels[row.kind]}</span><span>{row.priceSummary}</span><span>{row.refs ? 'With references' : 'No references'}</span><span>{row.origin === 'local' ? 'Added locally' : 'Built-in'}</span>
          </div>
          {!!row.defaultSlots.length && <div className="catalog-default-badges">{row.defaultSlots.map(slot => <span key={slot}>Default: {slotLabels[slot]}</span>)}</div>}
        </div>
        <div className="catalog-model-actions">
          {row.lifecycle === 'active' ? <>
            <button type="button" className="editor-close" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'archived') }}>Archive</button>
            <button type="button" className="editor-close danger-text" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'disabled') }}>Disable</button>
          </> : <button type="button" className="editor-close" disabled={disabled || busy} onClick={() => { onSelect?.(row.id); void requestLifecycle(row.id, 'active') }}>Restore</button>}
        </div>
      </article>)}
      {!rows.length && <p className="settings-note">No models match these filters.</p>}
    </div>
    {plan && <div className="catalog-impact" role="region" aria-label="Model replacement plan">
      <h4>{plan.target === 'disabled' ? 'Move dependencies before disabling' : 'Change default models before archiving'}</h4>
      {plan.affectedDefaults.map(slot => <label className="settings-label" key={slot}>Default · {slotLabels[slot]}
        <select value={defaultReplacements[slot] ?? ''} onChange={event => setDefaultReplacements(current => ({ ...current, [slot]: event.target.value }))}>
          <option value="">Choose replacement</option>{plan.replacementModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>)}
      {plan.macros.map(macro => <label className="settings-label" key={macro.id}>Macro “{macro.name}” · {macro.nodeIds.length} nodes
        <select value={macroReplacements[macro.id] ?? ''} onChange={event => setMacroReplacements(current => ({ ...current, [macro.id]: event.target.value }))}>
          <option value="">Choose replacement</option>{plan.replacementModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>)}
      <div className="catalog-library-row">
        <button type="button" className="generate" disabled={busy || !planComplete} onClick={() => void submitPlan()}>Apply plan</button>
        <button type="button" className="editor-close" disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
      </div>
    </div>}
  </section>
}
