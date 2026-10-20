import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from './config.js'
import type { MediaProvider } from './mediaImportTypes.js'
import { LoginBrowserInstall } from './loginBrowserInstall.js'
import { firefoxProxyPrefs } from './loginBrowserProxy.js'

/**
 * Окно входа на площадку.
 *
 * Зачем: Vimeo отдаёт видео только вошедшим (см. `extractorLogin.ts`), и
 * человеку нужен способ войти НЕ отходя от карточки — нажал на ссылке «Войти»,
 * вошёл в открывшемся окне, скачал. Настройки для этого открывать не надо.
 *
 * ⚠️ Окно — ОТДЕЛЬНЫЙ Firefox со своим профилем внутри папки приложения, а не
 * браузер человека, и на это две причины.
 *   • Chrome, Edge и прочие Chromium на Windows с 127-й версии шифруют cookies
 *     ключом самого браузера: замерено вживую 18.09.2026 — yt-dlp отвечает
 *     «Failed to decrypt with DPAPI» и не получает НИ ОДНОЙ записи. То есть
 *     «войдите в своём браузере» для большинства людей не работает в принципе.
 *     Firefox в том же замере отдал 914 cookies, а из нашего пустого профиля —
 *     ровно те 12, что поставила открытая страница.
 *   • Свой профиль не трогает вкладки и историю человека, а вход уезжает вместе
 *     с папкой приложения, как и всё остальное состояние (портативность).
 *
 * ⚠️ Если Firefox у человека не стоит, его можно ДОКАЧАТЬ кнопкой в настройках
 * (`loginBrowserInstall.ts`) — в поставку он не кладётся. Порядок поиска:
 * сначала своя скачанная копия, потом системная. Нет ни той, ни другой —
 * честно говорим об этом и оставляем запасной путь (файл cookies), а не делаем
 * вид, что кнопка сработала.
 */
export const LOGIN_URLS: Record<Exclude<MediaProvider, 'direct'>, string> = {
  vimeo: 'https://vimeo.com/log_in',
  // ⚠️ Не страница входа Google, а сам YouTube. Причин две: cookies нужны
  // ИМЕННО youtube.com, а вход через accounts.google.com оставляет их у
  // google.com, пока не вернёшься на сайт; и та страница переадресуется на
  // страновой домен (`accounts.google.ru`), который у человека может висеть
  // вечно — он видит «Время ожидания истекло» и думает, что сломались мы.
  youtube: 'https://www.youtube.com/',
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok: 'https://www.tiktok.com/login',
}

export function loginUrlFor(provider: MediaProvider): string | null {
  return provider === 'direct' ? null : LOGIN_URLS[provider]
}

/** Где искать Firefox. Список явный: гадать по PATH бессмысленно — на Windows
 *  его там обычно нет вовсе. */
export function firefoxCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter(Boolean) as string[]
    return roots.map((root) => path.join(root, 'Mozilla Firefox', 'firefox.exe'))
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      path.join(env['HOME'] ?? '', 'Applications/Firefox.app/Contents/MacOS/firefox'),
    ]
  }
  return ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox']
}

/** Аргументы запуска. Отдельной чистой функцией — её проверяет тест.
 *  `-no-remote` обязателен: без него Firefox отдаёт ссылку УЖЕ ОТКРЫТОМУ окну
 *  человека, и вход уходит в чужой профиль, откуда мы его не возьмём. */
export function firefoxArgs(profileDir: string, url: string): string[] {
  return ['-no-remote', '-profile', profileDir, '-new-window', url]
}

export interface LoginBrowserDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => Promise<boolean>
  launch?: (executable: string, args: string[]) => void
  profileDir?: string
  /** Скачанная нами копия. Её спрашиваем ПЕРВОЙ: она заведомо та, что нужна,
   *  и переезжает вместе с папкой приложения. */
  portable?: { locate(): Promise<string | null> }
  /** Дорога, которой ходит само приложение (см. loginBrowserProxy.ts). */
  proxy?: () => string | null
}

async function fileExists(file: string): Promise<boolean> {
  return await fs.access(file).then(() => true, () => false)
}

function detachedLaunch(executable: string, args: string[]): void {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  // Окно живёт своей жизнью: человек закроет его сам, а падение запуска не
  // должно ронять сервер (тот же обязательный обработчик, что у Photoshop).
  child.once('error', () => undefined)
  child.unref()
}

export class LoginBrowserError extends Error {
  readonly code: string

  constructor(message: string, code = 'LOGIN_BROWSER_UNAVAILABLE') {
    super(message)
    this.name = 'LoginBrowserError'
    this.code = code
  }
}

export class LoginBrowser {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly exists: (file: string) => Promise<boolean>
  private readonly launch: (executable: string, args: string[]) => void
  readonly profileDir: string
  private readonly portable: LoginBrowserDeps['portable']
  private readonly proxy: LoginBrowserDeps['proxy']

  constructor(deps: LoginBrowserDeps = {}) {
    this.platform = deps.platform ?? os.platform()
    this.env = deps.env ?? process.env
    this.exists = deps.exists ?? fileExists
    this.launch = deps.launch ?? detachedLaunch
    this.portable = deps.portable
    this.proxy = deps.proxy
    // Отдельного поля с папкой данных в config нет — берём её у соседа по
    // папке, чтобы не заводить второй источник правды о том, где лежит data.
    this.profileDir = deps.profileDir ?? path.join(path.dirname(config.settingsFile), 'login-profile')
  }

  /** Только системный Firefox. Своя копия спрашивается отдельно — см. locate. */
  async locateSystem(): Promise<string | null> {
    for (const candidate of firefoxCandidates(this.platform, this.env)) {
      if (await this.exists(candidate)) return candidate
    }
    return null
  }

  async locate(): Promise<string | null> {
    const portable = await this.portable?.locate().catch(() => null)
    return portable ?? await this.locateSystem()
  }

  /** Есть ли чем открыть окно входа и остался ли в профиле прошлый вход. */
  async state(): Promise<{ available: boolean; signedIn: boolean }> {
    const executable = await this.locate()
    return {
      available: Boolean(executable),
      signedIn: await this.exists(path.join(this.profileDir, 'cookies.sqlite')),
    }
  }

  async open(provider: MediaProvider): Promise<void> {
    const url = loginUrlFor(provider)
    if (!url) throw new LoginBrowserError('These links do not require sign-in', 'LOGIN_BROWSER_NO_PROVIDER')
    const executable = await this.locate()
    if (!executable) {
      throw new LoginBrowserError(
        'The sign-in window uses Firefox, but it is not installed. Download it in Settings → Components or provide a cookie file there.',
      )
    }
    await fs.mkdir(this.profileDir, { recursive: true })
    await this.applyProxy()
    this.launch(executable, firefoxArgs(this.profileDir, url))
  }

  /**
   * Прописать в профиль дорогу приложения. Пишется при КАЖДОМ открытии окна:
   * дорога у приложения может смениться (другой VPN, другой прокси), и профиль
   * обязан следовать за ней, а не хранить прошлогоднюю.
   */
  private async applyProxy(): Promise<void> {
    const file = path.join(this.profileDir, 'user.js')
    const prefs = firefoxProxyPrefs(this.proxy?.())
    // ⚠️ Нет прокси — файл УДАЛЯЕМ, а не пишем «ходить напрямую»: у человека
    // может быть системный прокси или VPN, который Firefox уважает сам, и
    // отнимать его мы не вправе.
    if (!prefs) {
      await fs.rm(file, { force: true }).catch(() => undefined)
      return
    }
    // Не смогли записать — это не повод не открывать окно: без прокси оно
    // хотя бы откроется, а площадка вроде Vimeo и напрямую доступна.
    await fs.writeFile(file, prefs).catch(() => undefined)
  }

  /** Забыть вход — просто выбросить профиль: cookies живут только в нём. */
  async forget(): Promise<void> {
    await fs.rm(this.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

/** Скачанная копия Firefox живёт в runtime/, рядом с ffmpeg и yt-dlp. */
export const loginBrowserInstall = new LoginBrowserInstall({
  runtimeDir: path.join(config.runtimeDir, 'login-browser'),
  systemExecutable: () => loginBrowser.locateSystem(),
})

/** Один на приложение: профиль общий для всех площадок и всех досок. */
export const loginBrowser: LoginBrowser = new LoginBrowser({
  portable: { locate: () => loginBrowserInstall.locate() },
  // Та же дорога, что у самого приложения — одна на всё, см. loginBrowserProxy.ts.
  // ⚠️ Выбранный маршрут бывает ещё не посчитан (его считают при обращении к
  // серверу команды), поэтому запасным идёт HTTPS_PROXY из окружения — ровно
  // то, чем пользуется fetch самого сервера (proxyDispatcher.ts).
  proxy: () => process.env.HTTPS_PROXY?.trim() ?? null,
})
