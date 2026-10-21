import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  languageStore,
  isLocale,
  type LanguageStore,
  type Locale,
} from './language.js'
import { translateForLocale, type TranslationParams } from './translate.js'

export type Translate = (message: string, params?: TranslationParams) => string

const LanguageStoreContext = createContext<LanguageStore>(languageStore)

export function useLanguageStore(): LanguageStore {
  return useContext(LanguageStoreContext)
}

export function LanguageProvider({
  children,
  store = languageStore,
}: {
  children: ReactNode
  store?: LanguageStore
}) {
  const locale = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale
    }
  }, [locale])

  // Keep another open app window in sync with this device-local preference.
  // The storage event is browser-only and never changes board or API state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY) return
      store.set(isLocale(event.newValue) ? event.newValue : DEFAULT_LOCALE)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [store])

  return (
    <LanguageStoreContext.Provider value={store}>
      {children}
    </LanguageStoreContext.Provider>
  )
}

export function useLocale(): Locale {
  const store = useLanguageStore()
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
}

/** A reactive translator for React-rendered system UI. */
export function useT(): Translate {
  const locale = useLocale()
  return useMemo(
    () => (message: string, params?: TranslationParams) => translateForLocale(locale, message, params),
    [locale],
  )
}
