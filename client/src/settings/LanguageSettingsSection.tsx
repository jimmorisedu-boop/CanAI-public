import { useLanguageStore, useLocale, useT } from '../i18n/context.js'

export function LanguageSettingsSection({ disabled = false }: { disabled?: boolean }) {
  const locale = useLocale()
  const store = useLanguageStore()
  const t = useT()

  return (
    <section className="settings-section settings-language" aria-labelledby="language-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="language-settings-title">{t('Language')}</h3>
          <p>{t('Choose the language for this device.')}</p>
        </div>
      </div>
      <fieldset className="settings-segmented" disabled={disabled}>
        <legend className="settings-visually-hidden">{t('Interface language')}</legend>
        <label>
          <input
            type="radio"
            name="canai-ui-language"
            value="en"
            checked={locale === 'en'}
            onChange={() => store.set('en')}
          />
          <span>English</span>
        </label>
        <label>
          <input
            type="radio"
            name="canai-ui-language"
            value="ru"
            checked={locale === 'ru'}
            onChange={() => store.set('ru')}
          />
          <span>Русский</span>
        </label>
      </fieldset>
    </section>
  )
}
