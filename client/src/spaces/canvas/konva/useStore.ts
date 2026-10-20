import { useSyncExternalStore } from 'react'
import type { CanvasStore } from './canvasStore'
import { itemToRef, type SelectionRef } from './selection'

// Реактивное чтение стора. Контент и камера — разные подписки, чтобы пан/зум
// не перерисовывал промпт-бар и панель макросов.

export function useContentVersion(store: CanvasStore): number {
  // Третий аргумент — снимок для серверного рендера (SSR в тестах) —
  // чтобы useSyncExternalStore не требовал getServerSnapshot.
  return useSyncExternalStore(store.subscribeContent, store.getContentVersion, store.getContentVersion)
}

export function useCameraVersion(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeCamera, store.getCameraVersion)
}

export function useGuidesVersion(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeGuides, store.getGuidesVersion)
}

export function useGenerationFocusVersion(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeGenerationFocus, store.getGenerationFocusVersion)
}

export function useOnboardingFocusVersion(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeOnboardingFocus, store.getOnboardingFocusVersion)
}

export function useCollaborationVersion(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeCollaboration, store.getCollaborationVersion)
}

/** Cursor/presence frames must not re-render the full Konva tree. */
export function editableSelectionSnapshot(store: CanvasStore): boolean {
  const ids = store.getSelection()
  return ids.length === 0 || store.looksEditable(ids)
}

export function useEditableSelection(store: CanvasStore): boolean {
  return useSyncExternalStore(
    store.subscribeCollaboration,
    () => editableSelectionSnapshot(store),
  )
}

export function useSelectionRefs(store: CanvasStore | null): SelectionRef[] {
  const version = useSyncExternalStore(
    store ? store.subscribeContent : () => () => {},
    store ? store.getContentVersion : () => 0,
  )
  void version
  if (!store) return []
  const refs: SelectionRef[] = []
  for (const item of store.getSelectedItems()) {
    const ref = itemToRef(item)
    if (ref) refs.push(ref)
  }
  return refs
}
