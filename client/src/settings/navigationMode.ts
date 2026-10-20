import { useSyncExternalStore } from 'react'

export type NavigationMode = 'mouse' | 'touchpad'

const STORAGE_KEY = 'canai-navigation-mode'

export interface NavigationModeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface NavigationModeStore {
  getSnapshot(): NavigationMode
  subscribe(listener: () => void): () => void
  set(mode: NavigationMode): void
}

export interface NavigationModeBrowser {
  readonly localStorage?: NavigationModeStorage
}

export interface ReactFlowNavigationProps {
  zoomOnScroll: boolean
  zoomOnPinch: boolean
  panOnScroll: boolean
}

export function resolveNavigationModeStorage(browser: NavigationModeBrowser | undefined): NavigationModeStorage | null {
  try {
    return browser?.localStorage ?? null
  } catch {
    return null
  }
}

export function reactFlowNavigationProps(mode: NavigationMode): ReactFlowNavigationProps {
  return {
    zoomOnScroll: mode === 'mouse',
    zoomOnPinch: true,
    panOnScroll: mode === 'touchpad',
  }
}

function readMode(storage: NavigationModeStorage | null): NavigationMode {
  try {
    return storage?.getItem(STORAGE_KEY) === 'touchpad' ? 'touchpad' : 'mouse'
  } catch {
    return 'mouse'
  }
}

export function createNavigationModeStore(storage: NavigationModeStorage | null): NavigationModeStore {
  let current = readMode(storage)
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(mode) {
      if (mode === current) return
      current = mode
      try {
        storage?.setItem(STORAGE_KEY, mode)
      } catch {
        // Настройка всё равно действует до перезагрузки, даже если хранилище недоступно.
      }
      for (const listener of listeners) listener()
    },
  }
}

const browserStorage = resolveNavigationModeStorage(typeof window === 'undefined' ? undefined : window)
export const navigationModeStore = createNavigationModeStore(browserStorage)

export function useNavigationMode(): NavigationMode {
  return useSyncExternalStore(
    navigationModeStore.subscribe,
    navigationModeStore.getSnapshot,
    navigationModeStore.getSnapshot,
  )
}
