import { useEffect, useState } from 'react'
import { apiRequest } from '../api.js'
import type { CatalogDefaults, CatalogLibraryView } from '../types.js'
import { askConfirm } from '../ui/confirmBus.js'
import { InlineNotice } from '../ui/InlineNotice.js'
import { notifyCatalogChanged } from '../spaces/canvas/genOptions.js'
import { catalogLibraryClient } from './catalogLibraryClient.js'
import { FalModelWizard } from './FalModelWizard.js'
import { ModelCatalogList } from './ModelCatalogList.js'
import { falConnectionPresentation, type FalConnectionState } from './settingsPresentation.js'
import { ModelDefaultsCard } from './ModelDefaultsCard.js'
import { systemErrorMessage } from '../ui/systemMessage.js'
import { useT } from '../i18n/context.js'


type CatalogDefaultSlot = keyof CatalogDefaults

export function FalModelsSettingsSection({
  falKey,
  falKeySet,
  connectionState,
  statusDetail,
  disabled,
  onFalKeyChange,
  onSaveFalConnection,
}: {
  falKey: string
  falKeySet: boolean
  connectionState: FalConnectionState
  statusDetail: string | null
  disabled: boolean
  onFalKeyChange(value: string): void
  onSaveFalConnection(removeKey?: boolean): Promise<void>
}) {
  const t = useT()
  const [library, setLibrary] = useState<CatalogLibraryView | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState('')
  const connection = falConnectionPresentation(connectionState)

  useEffect(() => {
    let active = true
    setCatalogBusy(true)
    void catalogLibraryClient.load(apiRequest)
      .then(next => { if (active) setLibrary(next) })
      .catch(error => { if (active) setCatalogError(error instanceof Error ? error.message : t('Could not load catalog')) })
      .finally(() => { if (active) setCatalogBusy(false) })
    return () => { active = false }
  }, [])

  async function changeDefault(slot: CatalogDefaultSlot, modelId: string): Promise<void> {
    if (!library) return
    setCatalogBusy(true)
    setCatalogError('')
    try {
      const next = await catalogLibraryClient.setDefaults(apiRequest, { [slot]: modelId }, library.revision)
      setLibrary(next)
      notifyCatalogChanged()
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : t('Could not change model'))
    } finally {
      setCatalogBusy(false)
    }
  }

  function acceptLibrary(next: CatalogLibraryView): void {
    setLibrary(next)
    notifyCatalogChanged()
  }

  return <>
    {!wizardOpen && <section className="settings-section fal-models-connection" aria-labelledby="fal-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="fal-settings-title">{t('fal.ai connection')}</h3>
          <p>{t('Key for generation, the assistant, and macros on all local boards.')}</p>
        </div>
        <span className="settings-connection" data-tone={connection.tone} role="status">{connection.label}</span>
      </div>
      <label className="settings-label" htmlFor="fal-key">{t('Access key')}</label>
      <div className="settings-key-row fal-models-key-row">
        <input
          id="fal-key"
          type="password"
          value={falKey}
          placeholder={falKeySet ? t('Paste a new key to replace the saved one') : t('Paste your fal.ai key')}
          autoComplete="off"
          disabled={disabled}
          onChange={event => onFalKeyChange(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void onSaveFalConnection(false) }}
        />
        <button type="button" className="generate" disabled={disabled || !falKey.trim()} onClick={() => void onSaveFalConnection(false)}>{t('Save key')}</button>
        <button
          type="button"
          className="editor-close"
          disabled={disabled || !falKeySet}
          onClick={() => { void askConfirm({
            title: t('Remove fal.ai key?'),
            detail: t('Generation, the assistant, and macros will stop working until a new key is set.'),
            confirmLabel: t('Remove key'), cancelLabel: t('Keep'), danger: true,
          }).then(ok => { if (ok) void onSaveFalConnection(true) }) }}
        >{falKeySet ? t('Remove') : t('No key')}</button>
      </div>
      <p className="settings-note">{t('Get a key from the')} <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">{t('fal.ai dashboard')}</a>. {t('It is stored only on this computer.')}</p>
      {statusDetail && <p className="settings-note" role="status">{systemErrorMessage(statusDetail, 'The key was saved, but fal.ai did not respond.')}</p>}
    </section>}
    {!wizardOpen && <details className="settings-technical">
      <summary aria-expanded="false">{t('Technical details')}</summary>
      <p className="settings-note">{t('The key lives in portable')} <code>server/.env</code> {t('and is never returned to the browser.')}</p>
    </details>}
    {catalogError && <InlineNotice tone="error" title={catalogError} />}
    {!wizardOpen && library?.defaultIssues.map(issue => <InlineNotice key={issue} tone="warning" system title={issue} />)}
    {!wizardOpen && library && <ModelDefaultsCard library={library} disabled={disabled || catalogBusy} onChange={changeDefault} />}
    {wizardOpen && !falKeySet && <InlineNotice
      tone="warning"
      title={t('fal.ai key is not set')}
      detail={t('Close the wizard and save a key in Settings to run the paid test.')}
      action={{ label: t('Close wizard'), onClick: () => setWizardOpen(false) }}
    />}
    {library && (wizardOpen
      ? <FalModelWizard
          library={library}
          onLibrary={acceptLibrary}
          onClose={() => setWizardOpen(false)}
          onSelect={setSelectedModelId}
        />
      : <ModelCatalogList
          library={library}
          disabled={disabled || catalogBusy}
          selectedId={selectedModelId}
          onSelect={setSelectedModelId}
          onLibrary={acceptLibrary}
          onAdd={() => setWizardOpen(true)}
        />)}
  </>
}
