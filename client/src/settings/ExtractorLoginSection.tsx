import { useEffect, useState } from 'react'
import { api } from '../api'
import {
  LOGIN_PROVIDERS,
  loginBrowserView,
  loginStatus,
  noBrowserNote,
  shouldPollLoginBrowser,
  type CookieMode,
  type LoginBrowserState,
} from './extractorLoginState'
import { systemErrorMessage } from '../ui/systemMessage'

const POLL_MS = 900

/**
 * Вход на площадки для импорта по ссылке.
 *
 * ⚠️ Главный путь — НЕ здесь: вход предлагает сама карточка ссылки, когда
 * площадка отказала. Этот блок нужен для двух вещей — посмотреть, что сейчас
 * задано, и забыть вход; плюс запасной путь через файл для тех, у кого нет
 * Firefox. Выбора «взять cookies из моего браузера» тут нет намеренно: Chromium
 * на Windows их шифрует, и такой выбор работал бы у меньшинства.
 */
export function ExtractorLoginSection({
  mode,
  file,
  disabled,
  onModeChange,
  onFileChange,
}: {
  mode: CookieMode
  file: string | null
  disabled: boolean
  onModeChange(value: CookieMode): void
  onFileChange(value: string | null): void
}) {
  const [available, setAvailable] = useState(true)
  const [signedIn, setSignedIn] = useState(false)
  const [browser, setBrowser] = useState<LoginBrowserState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.extractorLogin()
      .then((state) => {
        if (!alive) return
        setAvailable(state.available)
        setSignedIn(state.signedIn)
        setBrowser(state.browser ?? null)
      })
      // Состояние входа — не то, из-за чего стоит ронять окно настроек.
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  // Опрос идёт ТОЛЬКО пока качается: постоянный тик ради строчки, которая
  // меняется раз в жизни, приложению не нужен (то же правило, что у ffmpeg).
  useEffect(() => {
    if (!shouldPollLoginBrowser(browser)) return
    let alive = true
    const timer = setTimeout(() => {
      api.extractorLogin()
        .then((state) => {
          if (!alive) return
          setAvailable(state.available)
          setBrowser(state.browser ?? null)
        })
        // Обрыв опроса не гасит саму закачку: она идёт на сервере.
        .catch(() => undefined)
    }, POLL_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [browser])

  const browserView = loginBrowserView(browser)

  function downloadBrowser(): void {
    setNotice(null)
    // Рисуем закачку сразу: иначе между нажатием и первым процентом кнопка
    // выглядит так, будто клик не засчитался.
    setBrowser({ state: 'downloading', percent: 0 })
    api.prepareLoginBrowser()
      .then((result) => {
        setBrowser(result.browser ?? null)
        setAvailable(true)
      })
      .catch((error: unknown) => {
        setBrowser({
          state: 'failed',
          message: error instanceof Error ? error.message : 'Could not download browser',
        })
      })
  }

  const status = loginStatus(mode, { available, signedIn, file })
  const browserNote = noBrowserNote(available)

  async function open(provider: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await api.openExtractorLogin(provider)
      setSignedIn(true)
      onModeChange('app')
      setNotice('The window is open — sign in there, then downloads can start.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open sign-in window')
    } finally {
      setBusy(false)
    }
  }

  async function forget(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await api.forgetExtractorLogin()
      setSignedIn(false)
      onModeChange('none')
      setNotice('Sign-in forgotten: the window profile was removed.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not forget sign-in')
    } finally {
      setBusy(false)
    }
  }

  async function pickFile(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const picked = await api.browseCookiesFile()
      onFileChange(picked.path)
      onModeChange('file')
    } catch (error) {
      // Отмена — тоже ответ, и это не поломка приложения.
      setNotice(error instanceof Error ? error.message : 'Could not choose file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="extractor-login-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="extractor-login-title">Site sign-in</h3>
          <p>Needed when a site only serves video to signed-in users, currently Vimeo.</p>
        </div>
        <span
          className="settings-connection"
          {...(status.tone === 'success' ? { 'data-tone': 'success' } : {})}
          role="status"
        >
          {status.label}
        </span>
      </div>

      <p className="settings-note">{status.note}</p>
      {browserNote && <p className="settings-note">{browserNote}</p>}

      <div className="settings-editor-summary">
        <strong>Sign-in browser</strong>
        <span className="settings-connection" {...(browserView.tone === 'ok' ? { 'data-tone': 'success' } : browserView.tone === 'danger' ? { 'data-tone': 'warning' } : {})} role="status">
          {browserView.label}
        </span>
      </div>
      {browserView.note && <p className="settings-note">{browserView.tone === 'danger'
        ? systemErrorMessage(browserView.note, 'Could not download browser')
        : browserView.note}</p>}
      {browserView.action && (
        <div className="settings-editor-actions">
          <button
            type="button"
            className="editor-close"
            disabled={disabled || busy || browserView.busy}
            onClick={downloadBrowser}
          >
            {browserView.action}
          </button>
        </div>
      )}

      {available && (
        <div className="settings-editor-actions">
          {LOGIN_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="editor-close"
              disabled={disabled || busy}
              onClick={() => { void open(provider.id) }}
            >
              {`Sign in to ${provider.label}`}
            </button>
          ))}
          <button
            type="button"
            className="editor-close"
            disabled={disabled || busy || (mode !== 'app' && !signedIn)}
            onClick={() => { void forget() }}
          >
            Forget sign-in
          </button>
        </div>
      )}

      <details className="settings-technical">
        <summary>Another option: cookies file</summary>
        <label className="settings-label" htmlFor="extractor-cookies-file">
          File exported by a browser extension
        </label>
        <div className="settings-editor-row">
          <input
            id="extractor-cookies-file"
            type="text"
            value={file ?? ''}
            placeholder="Path to cookies file"
            disabled={disabled || busy}
            onChange={(event) => {
              onFileChange(event.target.value)
              onModeChange(event.target.value.trim() ? 'file' : 'none')
            }}
          />
          <button
            type="button"
            className="editor-close"
            disabled={disabled || busy}
            onClick={() => { void pickFile() }}
          >
            Choose file
          </button>
        </div>
      </details>

      {notice && <p className="settings-note" role="status">{systemErrorMessage(notice)}</p>}
    </section>
  )
}
