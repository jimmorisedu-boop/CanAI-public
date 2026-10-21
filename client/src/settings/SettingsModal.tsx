import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { notifySettingsSaved } from './settingsBus'
import { InlineNotice } from '../ui/InlineNotice'
import { useDialogFocus } from '../ui/dialogFocus'
import { editorPathHint } from './editorPathHint'
import { FaceModelsSection } from './FaceModelsSection'
import { FalModelsSettingsSection } from './FalModelsSettingsSection'
import { MediaToolsSection } from './MediaToolsSection'
import { ExtractorLoginSection } from './ExtractorLoginSection'
import type { CookieMode } from './extractorLoginState'
import { NavigationSettingsSection } from './NavigationSettingsSection'
import { RemoteAccessSection } from './RemoteAccessSection'
import { DiagnosticsSection } from './DiagnosticsSection'
import { navigationModeStore, type NavigationMode } from './navigationMode'
import { BehaviorSettingsSection } from './BehaviorSettingsSection'
import { AgentsSettingsSection } from './AgentsSettingsSection'
import { LanguageSettingsSection } from './LanguageSettingsSection'
import { useT } from '../i18n/context.js'
import type { CanAIIcon } from '../ui/icons'
import {
  IconClose,
  IconDownload,
  IconList,
  IconEdit,
  IconGenerate,
  IconLLM,
  IconOpenExternal,
  IconSettings,
} from '../ui/icons'
import {
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  type SettingsSectionId,
} from './settingsSections'
import {
  editorDisplayName,
  type FalConnectionState,
} from './settingsPresentation'
import { systemErrorMessage } from '../ui/systemMessage'

// Иконки живут здесь, а список разделов — в settingsSections.ts: там он
// проверяется тестом, а сюда картинке и место.
//
// ⚠️ Храним КОМПОНЕНТЫ, а не готовые элементы: JSX на уровне модуля
// вычисляется при импорте, и прогон падает с «React is not defined». Тот же
// приём у NODE_META.icon в нодах.
const SECTION_ICONS: Record<SettingsSectionId, CanAIIcon> = {
  general: IconSettings,
  generation: IconGenerate,
  agents: IconLLM,
  editor: IconEdit,
  components: IconDownload,
  remote: IconOpenExternal,
  diagnostics: IconList,
}

export function shouldCloseSettingsAfterSave(removeKey: boolean): boolean {
  return !removeKey
}

export function SettingsModal({ hint, section: requestedSection, onClose }: {
  hint: string | null
  section?: SettingsSectionId
  onClose: () => void
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [editorPath, setEditorPath] = useState('')
  const [falKey, setFalKey] = useState('')
  const [falKeySet, setFalKeySet] = useState(false)
  const [falConnectionState, setFalConnectionState] = useState<FalConnectionState>('loading')
  const [falStatusDetail, setFalStatusDetail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [optimiseLargeImages, setOptimiseLargeImages] = useState(false)
  const [editorStatus, setEditorStatus] = useState<string | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [confirmCostAboveUsd, setConfirmCostAboveUsd] = useState(1)
  const [tabletDailyGenerationLimit, setTabletDailyGenerationLimit] = useState(0)
  const [tabletApproveDailyLimit, setTabletApproveDailyLimit] = useState(0)
  const [shareLanAccess, setShareLanAccess] = useState(false)
  const [cookiesMode, setCookiesMode] = useState<CookieMode>('none')
  const [cookiesFile, setCookiesFile] = useState<string | null>(null)
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(navigationModeStore.getSnapshot())
  const [platform, setPlatform] = useState<string | undefined>(undefined)
  // Подсказки путей у Windows и macOS разные, а формулировки живут отдельно —
  // чтобы их проверял тест, а не глаз в модалке.
  const pathHint = editorPathHint(platform)
  // Раздел выбирается один раз при открытии: перещёлкивать его под руками у
  // человека, который уже начал что-то править, нельзя.
  const [section, setSection] = useState<SettingsSectionId>(() => resolveSettingsSection(requestedSection))

  useEffect(() => {
    api.getSettings()
      .then((s) => {
        setEditorPath(s.externalEditorPath ?? '')
        setPlatform(s.platform)
        setFalKeySet(s.falKeySet)
        setFalConnectionState(s.falKeySet ? 'connected' : 'disconnected')
        setOptimiseLargeImages(s.optimiseLargeImages)
        setConfirmCostAboveUsd(s.confirmCostAboveUsd)
        setTabletDailyGenerationLimit(s.tabletDailyGenerationLimit ?? 0)
        setTabletApproveDailyLimit(s.tabletApproveDailyLimit ?? 0)
        setShareLanAccess(s.shareLanAccess === true)
        setCookiesMode(s.extractorCookiesMode ?? 'none')
        setCookiesFile(s.extractorCookiesFile ?? null)
        setLoaded(true)
      })
      .catch(() => setError('Could not load settings'))
  }, [])

  async function save(): Promise<void> {
    if (!loaded || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.saveSettings(editorPath.trim() || null, undefined, optimiseLargeImages, confirmCostAboveUsd, undefined, undefined, shareLanAccess, undefined, { mode: cookiesMode, file: cookiesFile }, tabletDailyGenerationLimit, tabletApproveDailyLimit)
      navigationModeStore.set(navigationMode)
      notifySettingsSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function refreshFalConnectionState(removeKey: boolean): Promise<void> {
    if (removeKey) {
      setFalKeySet(false)
      setFalKey('')
      setFalConnectionState('disconnected')
      setFalStatusDetail(null)
      return
    }
    const check = await api.getFalBalance().catch(() => null)
    const noBillingScope = Boolean(check?.error?.toLowerCase().includes('not permitted'))
    setFalKeySet(true)
    setFalKey('')
    if (check?.balance == null && !noBillingScope) {
      setFalConnectionState('unverified')
      setFalStatusDetail(
        `Key saved${check?.error ? `: ${check.error}` : ', but fal.ai is not reachable right now'}. ` +
        'You can keep working and check again later.',
      )
      return
    }
    setFalConnectionState('connected')
    setFalStatusDetail(null)
  }

  async function saveFalConnection(removeKey = false): Promise<void> {
    if (!loaded || saving || (!removeKey && !falKey.trim())) return
    setSaving(true)
    setError(null)
    setFalStatusDetail(null)
    try {
      const keyPayload = removeKey ? null : falKey.trim()
      await api.saveSettings(editorPath.trim() || null, keyPayload, optimiseLargeImages, confirmCostAboveUsd, undefined, undefined, shareLanAccess, undefined, { mode: cookiesMode, file: cookiesFile }, tabletDailyGenerationLimit, tabletApproveDailyLimit)
      await refreshFalConnectionState(removeKey)
      notifySettingsSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save key')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="settings-title">{t('Settings')}</h2>
          <button type="button" className="settings-close" aria-label={t('Close settings')} onClick={onClose}>
            <IconClose aria-hidden="true" />
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('Settings sections')}>
            {SETTINGS_SECTIONS.map((entry) => {
              const Icon = SECTION_ICONS[entry.id]
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`settings-nav-item ${section === entry.id ? 'on' : ''}`}
                  aria-current={section === entry.id ? 'true' : undefined}
                  title={t(entry.summary)}
                  onClick={() => setSection(entry.id)}
                >
                  <Icon size={18} />
                  <span>{t(entry.label)}</span>
                </button>
              )
            })}
          </nav>

        <div className="settings-body">
          {/* подсказка приходит от того, кто сюда отправил («нужен ключ», «укажи
              редактор») — это продолжение уже показанной плашки, и выглядеть оно
              обязано так же, а не заливкой во всю ширину */}
          {hint && <InlineNotice className="settings-hint" tone="info" title={hint} />}

          <div className="settings-primary">
            {section === 'general' && (
              <>
            <LanguageSettingsSection />
            <NavigationSettingsSection
              mode={navigationMode}
              disabled={!loaded || saving}
              onChange={setNavigationMode}
            />
            <BehaviorSettingsSection
              optimiseLargeImages={optimiseLargeImages}
              shareLanAccess={shareLanAccess}
              confirmCostAboveUsd={confirmCostAboveUsd}
              tabletDailyGenerationLimit={tabletDailyGenerationLimit}
              tabletApproveDailyLimit={tabletApproveDailyLimit}
              disabled={!loaded || saving}
              onOptimiseLargeImagesChange={setOptimiseLargeImages}
              onShareLanAccessChange={setShareLanAccess}
              onConfirmCostChange={setConfirmCostAboveUsd}
              onTabletDailyLimitChange={setTabletDailyGenerationLimit}
              onTabletApproveLimitChange={setTabletApproveDailyLimit}
            />
              </>
            )}

            {section === 'generation' && (
              <FalModelsSettingsSection
                falKey={falKey}
                falKeySet={falKeySet}
                connectionState={falConnectionState}
                statusDetail={falStatusDetail}
                disabled={!loaded || saving}
                onFalKeyChange={setFalKey}
                onSaveFalConnection={saveFalConnection}
              />
            )}


            {section === 'agents' && <AgentsSettingsSection />}

            {section === 'editor' && (
              <>
          <section className="settings-section" aria-labelledby="editor-settings-title">
            <div className="settings-section-heading">
              <div>
                <h3 id="editor-settings-title">{t('Image editor')}</h3>
                <p>{t('Open images in Photoshop, Krita, GIMP, or another program.')}</p>
              </div>
            </div>
            <div className="settings-editor-summary">
              <strong>{editorDisplayName(editorPath)}</strong>
              <div className="settings-editor-actions">
                {pathHint.browse && (
                  <button type="button" className="editor-close" disabled={!loaded || saving} onClick={() => {
                    setEditorStatus(null)
                    void api.browseEditor().then(({ path }) => setEditorPath(path)).catch((cause) => setEditorStatus(cause instanceof Error ? cause.message : 'Could not choose program'))
                  }}>{t(pathHint.browse)}</button>
                )}
                <button type="button" className="editor-close" disabled={!loaded || !editorPath.trim() || saving} onClick={() => {
                  setEditorStatus('Checking…')
                  void api.testEditor(editorPath).then(({ message }) => setEditorStatus(message)).catch((cause) => setEditorStatus(cause instanceof Error ? cause.message : 'Could not open program'))
                }}>{t('Check')}</button>
              </div>
            </div>
            {editorStatus && <p className="settings-note" role="status">{systemErrorMessage(editorStatus)}</p>}
            <p className="settings-note">
              {t('Select an image and press {0}. A new version appears on the canvas after saving.', { 0: 'F2' })}
            </p>
          </section>
        <details
          className="settings-technical"
          open={technicalOpen}
          onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
        >
          <summary
            aria-expanded={technicalOpen}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setTechnicalOpen((open) => !open)
            }}
          >
            {t('Technical details')}
          </summary>
          <label className="settings-label" htmlFor="editor-path">{t('Full path to program')}</label>
          <input
            id="editor-path"
            type="text"
            value={editorPath}
            disabled={!loaded || saving}
            placeholder={pathHint.placeholder}
            onChange={(e) => { setEditorPath(e.target.value); setEditorStatus(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
          {pathHint.note && <p className="settings-note">{t(pathHint.note)}</p>}
        </details>
              </>
            )}

            {section === 'components' && (
              <>
                <MediaToolsSection />
                <ExtractorLoginSection
                  mode={cookiesMode}
                  file={cookiesFile}
                  disabled={!loaded || saving}
                  onModeChange={setCookiesMode}
                  onFileChange={setCookiesFile}
                />
                <FaceModelsSection />
              </>
            )}

            {section === 'remote' && <RemoteAccessSection />}

            {section === 'diagnostics' && <DiagnosticsSection />}
          </div>

        {/* состояние формы, а не уведомление: строка живёт у кнопки «Сохранить»
            и плашкой быть не должна. Но провал обязан быть слышен. */}
          {error && <div className="settings-error" role="alert">{systemErrorMessage(error, 'Could not save settings')}</div>}
        </div>
        </div>

        <footer className="settings-actions">
          {section === 'generation' || section === 'agents' ? (
            <button type="button" className="generate" onClick={onClose}>{t('Done')}</button>
          ) : (
            <>
              <button type="button" className="editor-close" onClick={onClose}>{t('Cancel')}</button>
              <button type="button" className="generate" disabled={!loaded || saving} onClick={() => void save()}>
                {!loaded ? t('Loading…') : saving ? t('Saving…') : t('Save')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
