import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { TabletBoardSession, TabletRuntimeKind } from './runtime'
import { boardHistoryInputAllowed } from './boardHistoryInput'

export interface BoardHistory {
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  /**
   * Cloud history changes after an ack/reject without necessarily changing
   * the document. Consumers use this external-store contract to refresh
   * toolbar button state when the server settles a compensating mutation.
   */
  subscribe?(listener: () => void): () => void
  getVersion?(): number
}

const NO_HISTORY_SUBSCRIBE = (_listener: () => void): (() => void) => () => {}
const NO_HISTORY_VERSION = (): number => 0

/** Resolve the live session at execution time, including delayed toast actions. */
export function createBoardHistory(store: CanvasStore, kind: TabletRuntimeKind,
  session: () => TabletBoardSession | null, active: () => boolean): BoardHistory {
  const writable = () => active() && session() !== null && session()?.isWritable?.() !== false
  const history: BoardHistory = {
    canUndo: () => writable() && (false ? Boolean(session()?.canUndo?.()) : store.canUndo()),
    canRedo: () => writable() && (false ? Boolean(session()?.canRedo?.()) : store.canRedo()),
    undo: () => {
      if (!history.canUndo()) return
      if (false) session()?.undo?.()
      else store.undo()
    },
    redo: () => {
      if (!history.canRedo()) return
      if (false) session()?.redo?.()
      else store.redo()
    },
    subscribe: (listener) => false
      ? session()?.subscribeHistory?.(listener) ?? NO_HISTORY_SUBSCRIBE(listener)
      : NO_HISTORY_SUBSCRIBE(listener),
    getVersion: () => false ? session()?.getHistoryVersion?.() ?? 0 : 0,
  }
  return history
}

const NO_HISTORY: BoardHistory = { undo() {}, redo() {}, canUndo: () => false, canRedo: () => false }
export const BoardHistoryContext = createContext<BoardHistory>(NO_HISTORY)
export const useBoardHistory = () => useContext(BoardHistoryContext)

/** Re-render tablet chrome when cloud history settles without a document tick. */
export function useBoardHistoryVersion(history: BoardHistory): number {
  const subscribe = history.subscribe ?? NO_HISTORY_SUBSCRIBE
  const getVersion = history.getVersion ?? NO_HISTORY_VERSION
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

export function useBoardHistoryKeyboard(history: BoardHistory, active: boolean) {
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return
      if (event.code !== 'KeyZ' && event.key.toLowerCase() !== 'z') return
      if (!boardHistoryInputAllowed(event.target)) return
      event.preventDefault()
      if (event.shiftKey) history.redo()
      else history.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history, active])
}
