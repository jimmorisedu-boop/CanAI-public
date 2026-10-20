import { Router } from 'express'
import { LoginBrowserError, type LoginBrowser } from './loginBrowser.js'
import type { LoginBrowserInstallState } from './loginBrowserInstall.js'
import { loadSettings, saveSettings } from './settings.js'
import type { MediaProvider } from './mediaImportTypes.js'

interface LoginBrowserInstallLike {
  getState(): LoginBrowserInstallState
  prepare(): Promise<string>
}

const PROVIDERS: MediaProvider[] = ['vimeo', 'youtube', 'instagram', 'tiktok']

function parseProvider(value: unknown): MediaProvider {
  if (typeof value === 'string' && (PROVIDERS as string[]).includes(value)) return value as MediaProvider
  throw new LoginBrowserError('Unknown platform', 'LOGIN_BROWSER_NO_PROVIDER')
}

/**
 * Вход на площадку прямо с карточки ссылки: открыть окно, забыть вход,
 * посмотреть состояние. Ручки отдельные от настроек намеренно — это рабочее
 * действие, а не настройка, и делать его надо не уходя с холста.
 */
export function createLoginBrowserRouter(browser: LoginBrowser, install: LoginBrowserInstallLike): Router {
  const router = Router()

  router.get('/extractor-login', async (_request, response) => {
    const state = await browser.state()
    // Состояние спрашиваем ПОСЛЕ browser.state(): тот зовёт install.locate(),
    // который и обновляет состояние компонента (ready/missing/unsupported).
    const settings = await loadSettings().catch(() => null)
    response.json({
      ...state,
      mode: settings?.extractorCookiesMode ?? 'none',
      browser: install.getState(),
    })
  })

  /** Скачать браузер для входа. Сам файл едет с серверов Mozilla. */
  router.post('/extractor-login/prepare', async (_request, response) => {
    try {
      await install.prepare()
      response.json({ browser: install.getState() })
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Could not download browser',
        browser: install.getState(),
      })
    }
  })

  router.post('/extractor-login/open', async (request, response) => {
    try {
      await browser.open(parseProvider(request.body?.provider))
      // Вход включается САМ: человек нажал «Войти» — значит он хочет, чтобы
      // скачивание шло от его имени. Заставлять его после этого идти в
      // настройки и там что-то выбирать значило бы вернуть ту самую сложность.
      const settings = await loadSettings()
      if (settings.extractorCookiesMode !== 'app') {
        await saveSettings({ ...settings, extractorCookiesMode: 'app' })
      }
      response.json({ ok: true })
    } catch (error) {
      const code = error instanceof LoginBrowserError ? error.code : 'LOGIN_BROWSER_FAILED'
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Could not open the sign-in window',
        code,
      })
    }
  })

  router.post('/extractor-login/forget', async (_request, response) => {
    await browser.forget()
    const settings = await loadSettings().catch(() => null)
    if (settings && settings.extractorCookiesMode === 'app') {
      await saveSettings({ ...settings, extractorCookiesMode: 'none' })
    }
    response.json({ ok: true })
  })

  return router
}
