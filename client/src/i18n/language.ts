import { useSyncExternalStore } from 'react'

export type Locale = 'en' | 'ru'

export const DEFAULT_LOCALE: Locale = 'en'
export const LANGUAGE_STORAGE_KEY = 'canai-ui-language'

export interface LanguageStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface LanguageBrowser {
  readonly localStorage?: LanguageStorage
}

export interface LanguageStore {
  getSnapshot(): Locale
  subscribe(listener: () => void): () => void
  set(locale: Locale): void
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'ru'
}

/** Locale tag for browser-facing dates and other Intl presentation helpers. */
export function getIntlLocale(locale: Locale = languageStore.getSnapshot()): 'en-US' | 'ru-RU' {
  return locale === 'ru' ? 'ru-RU' : 'en-US'
}

export function resolveLanguageStorage(browser: LanguageBrowser | undefined): LanguageStorage | null {
  try {
    return browser?.localStorage ?? null
  } catch {
    // Browsers can throw while reading localStorage (private mode, blocked
    // storage, or a document with an opaque origin). Language still works in
    // memory in that case.
    return null
  }
}

export function readStoredLocale(storage: LanguageStorage | null | undefined): Locale {
  try {
    const value = storage?.getItem(LANGUAGE_STORAGE_KEY)
    return isLocale(value) ? value : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function createLanguageStore(storage: LanguageStorage | null | undefined): LanguageStore {
  let current = readStoredLocale(storage)
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(locale) {
      // Keep the runtime boundary strict even when JavaScript callers bypass
      // the TypeScript type. Unknown values never enter storage or snapshots.
      if (!isLocale(locale)) return
      if (locale === current) {
        // Also repair a stale/invalid value that was present before the store
        // was created, without needlessly notifying React subscribers.
        try {
          storage?.setItem(LANGUAGE_STORAGE_KEY, locale)
        } catch {
          // A blocked store must not prevent the current tab from switching.
        }
        return
      }
      current = locale
      try {
        storage?.setItem(LANGUAGE_STORAGE_KEY, locale)
      } catch {
        // A blocked store must not prevent the current tab from switching.
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

const browserStorage = resolveLanguageStorage(
  typeof window === 'undefined' ? undefined : window,
)

/** The per-device language for the current app tab. */
export const languageStore = createLanguageStore(browserStorage)

export function useLanguage(): Locale {
  return useSyncExternalStore(
    languageStore.subscribe,
    languageStore.getSnapshot,
    languageStore.getSnapshot,
  )
}
