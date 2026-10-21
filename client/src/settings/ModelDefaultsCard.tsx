import type { CatalogDefaults, CatalogLibraryView } from '../types.js'
import { useT } from '../i18n/context.js'


type CatalogDefaultSlot = keyof CatalogDefaults

const SLOT_META: Array<{ slot: CatalogDefaultSlot; label: string }> = [
  { slot: 'image', label: 'Image' },
  { slot: 'video', label: 'Video' },
  { slot: 'audio', label: 'Audio' },
  { slot: 'assistant', label: 'Assistant' },
]

export function ModelDefaultsCard({ library, disabled, onChange }: {
  library: CatalogLibraryView
  disabled: boolean
  onChange(slot: CatalogDefaultSlot, modelId: string): Promise<void>
}) {
  const t = useT()
  const pairedIds = new Set(library.models.flatMap(model => (
    [model.pairId, model.videoPairId].filter((id): id is string => Boolean(id))
  )))
  return (
    <section className="settings-section model-defaults" aria-labelledby="model-defaults-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="model-defaults-title">{t('Default models')}</h3>
          <p>{t('One choice for all local boards. You can still change the model for a specific generation.')}</p>
        </div>
      </div>
      <div className="model-defaults-grid">
        {SLOT_META.map(({ slot, label }) => {
          const kind = slot === 'assistant' ? 'text' : slot
          const current = library.defaults[slot]
          const choices = library.models.filter(model => (
            model.kind === kind
            && (!model.lifecycle || model.lifecycle === 'active')
            && !pairedIds.has(model.id)
          ))
          const currentAvailable = choices.some(model => model.id === current)
          const saved = library.models.find(model => model.id === current)
          return <label key={slot} className="model-default-field">
            <span>{t(label)}</span>
            <select
              aria-label={t('Default model: {0}', { 0: label })}
              value={current ?? ''}
              disabled={disabled}
              onChange={event => { void onChange(slot, event.target.value) }}
            >
              {!currentAvailable && current && (
                <option value={current} disabled>{t('{0} · replacement needed', { 0: saved?.name ?? current })}</option>
              )}
              {!current && <option value="" disabled>{t('Choose a model')}</option>}
              {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
        })}
      </div>
    </section>
  )
}
