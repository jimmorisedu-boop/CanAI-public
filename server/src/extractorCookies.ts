import { loadSettings } from './settings.js'
import { loginBrowser } from './loginBrowser.js'

/**
 * Вход на площадки для extractor'ов (yt-dlp и gallery-dl).
 *
 * Зачем это вообще есть — см. `extractorLogin.ts`: Vimeo (а за ним и другие)
 * отдаёт видео только вошедшим, и без учётной записи скачать нечего.
 *
 * Способов ровно два, и главный — первый:
 *   • `app` — вход в окне самого приложения (`loginBrowser.ts`). Человек жмёт
 *     «Войти» на карточке ссылки, входит в открывшемся окне, и скачивание идёт
 *     от его имени. Настройки для этого открывать не надо.
 *   • `file` — файл cookies, выгруженный расширением браузера. Запасной путь
 *     для того, у кого нет Firefox.
 *
 * ⚠️ Выбора «взять cookies из моего браузера» тут НЕТ намеренно. Chrome, Edge и
 * прочие Chromium на Windows с 127-й версии шифруют cookies ключом самого
 * браузера: замерено 18.09.2026 — yt-dlp отвечает «Failed to decrypt with
 * DPAPI» и не получает ни одной записи. То есть такой выбор работал бы у
 * меньшинства, а выглядел бы рабочим у всех — хуже, чем его отсутствие.
 *
 * ⚠️ Пароль в настройках не держим: cookies отзываются выходом из аккаунта в
 * браузере, а пароль, положенный на диск, живёт до смены пароля.
 */
export type ExtractorCookies =
  | { mode: 'none' }
  | { mode: 'app'; profileDir: string }
  | { mode: 'file'; file: string }

/** Способы входа, которые принимает настройка. */
export const COOKIE_MODES = ['none', 'app', 'file'] as const

export type CookieMode = typeof COOKIE_MODES[number]

export function isCookieMode(value: unknown): value is CookieMode {
  return typeof value === 'string' && (COOKIE_MODES as readonly string[]).includes(value)
}

/**
 * Настройки → описание входа. Мусор и полузаполненный выбор («файл», но какой —
 * не сказано) сводятся к `none`: молча остаться без входа честнее, чем
 * подсунуть extractor'у путь в никуда.
 */
export function readExtractorCookies(settings: {
  extractorCookiesMode?: unknown
  extractorCookiesFile?: unknown
}, appProfileDir?: string): ExtractorCookies {
  // Профиль знает только сервер, в настройках лежит один флаг — иначе путь
  // пришлось бы чинить после каждого переезда папки приложения.
  if (settings.extractorCookiesMode === 'app') {
    return appProfileDir ? { mode: 'app', profileDir: appProfileDir } : { mode: 'none' }
  }
  if (settings.extractorCookiesMode === 'file' && typeof settings.extractorCookiesFile === 'string') {
    const file = settings.extractorCookiesFile.trim()
    // Перевод строки в аргументе — это чужая команда следом за нашей.
    if (file && !/[\r\n\0]/.test(file)) return { mode: 'file', file }
  }
  return { mode: 'none' }
}

/**
 * Аргументы запуска. Довода «какой инструмент» тут нет намеренно: ключи у
 * yt-dlp и gallery-dl называются одинаково. Понадобится развести их — довод
 * добавится вместе с настоящей причиной, а не заранее «на всякий».
 */
export function cookieArgsFor(cookies: ExtractorCookies): string[] {
  // Профиль указывается ПУТЁМ: это наш собственный Firefox внутри папки
  // приложения, а не тот, которым человек пользуется.
  if (cookies.mode === 'app') return ['--cookies-from-browser', `firefox:${cookies.profileDir}`]
  if (cookies.mode === 'file') return ['--cookies', cookies.file]
  return []
}

/** Уже переданный вход виден по аргументам — по нему отличается «вход не
 *  указан» от «указанный вход не подошёл». */
export function argsCarryCookies(args: readonly string[]): boolean {
  return args.includes('--cookies') || args.includes('--cookies-from-browser')
}

/** Живое значение из настроек. Читается на каждый запуск extractor'а: их
 *  единицы за импорт, зато кэш не разъезжается с тем, что человек только что
 *  сохранил. */
export async function currentCookieArgs(profileDir = loginBrowser.profileDir): Promise<string[]> {
  const settings = await loadSettings().catch(() => null)
  return settings ? cookieArgsFor(readExtractorCookies(settings, profileDir)) : []
}
