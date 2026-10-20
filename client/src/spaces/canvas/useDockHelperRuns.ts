import { useCallback, useEffect, useRef, useState } from 'react'

export interface DockHelperRunScope {
  projectId: string
  projectSource?: string
  mode: string
}

export interface UseDockHelperRunsResult {
  isPreparing: boolean
  activeRunsCount: number
  activeAssistantName: string | null
  registerRun(id: string, controller: AbortController, assistantName?: string): void
  unregisterRun(id: string): void
  stopAll(): void
}

/**
 * Manages parallel active helper preparation runs in the Action Dock.
 * Tracks concurrent runs with their AbortControllers, enables stopAll,
 * and resets automatically on unmount or when the board / mode scope changes.
 */
export function useDockHelperRuns(scope: DockHelperRunScope): UseDockHelperRunsResult {
  const runsRef = useRef<Map<string, { controller: AbortController; assistantName?: string }>>(new Map())
  const [activeRunsCount, setActiveRunsCount] = useState(0)
  const [activeAssistantName, setActiveAssistantName] = useState<string | null>(null)

  const stopAll = useCallback(() => {
    const controllers = Array.from(runsRef.current.values())
    runsRef.current.clear()
    for (const { controller } of controllers) {
      try {
        controller.abort()
      } catch {
        // Ignore errors during abort
      }
    }
    setActiveRunsCount(0)
    setActiveAssistantName(null)
  }, [])

  // Automatically abort and reset when switching boards or dock modes
  useEffect(() => {
    return () => {
      stopAll()
    }
  }, [scope.projectId, scope.projectSource, scope.mode, stopAll])

  const registerRun = useCallback((id: string, controller: AbortController, assistantName?: string) => {
    runsRef.current.set(id, { controller, assistantName })
    setActiveRunsCount(runsRef.current.size)
    if (assistantName) {
      setActiveAssistantName(assistantName)
    }
  }, [])

  const unregisterRun = useCallback((id: string) => {
    runsRef.current.delete(id)
    const nextSize = runsRef.current.size
    setActiveRunsCount(nextSize)
    if (nextSize === 0) {
      setActiveAssistantName(null)
    } else {
      const remaining = Array.from(runsRef.current.values()).find((r) => r.assistantName)
      setActiveAssistantName(remaining?.assistantName ?? null)
    }
  }, [])

  return {
    isPreparing: activeRunsCount > 0,
    activeRunsCount,
    activeAssistantName,
    registerRun,
    unregisterRun,
    stopAll,
  }
}
