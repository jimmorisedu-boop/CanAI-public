import { languageStore, type Locale } from './language.js'
import { ru } from './ru.js'

export type TranslationParams = Readonly<Record<string | number, unknown>>

function interpolate(message: string, params: TranslationParams | undefined): string {
  if (!params) return message
  return message.replace(/\{(\d+)\}/gu, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return token
    return String(params[key])
  })
}

/**
 * Translate a known system UI message without changing runtime parameters.
 * English source strings are the stable dictionary keys; unknown keys fall
 * back to the source so a partial dictionary never blanks a control.
 */
export function translateForLocale(
  locale: Locale,
  message: string,
  params?: TranslationParams,
): string {
  // The catalogue is a plain object.  Guard the lookup so inherited names
  // such as `constructor` and `__proto__` can never become translations.
  const translated = locale === 'ru' && Object.hasOwn(ru, message)
    ? ru[message]
    : message
  return interpolate(translated, params)
}

/** Use the current device language from non-React code (toasts, Konva, etc.). */
export function t(message: string, params?: TranslationParams): string {
  return translateForLocale(languageStore.getSnapshot(), message, params)
}
