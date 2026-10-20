export type MacroFinalize = () => Promise<void>

export interface MacroLeaveOptions {
  discard?: boolean
}

export interface MacroEditorLeaveController {
  register: (finalize: MacroFinalize) => () => void
  leave: (onLeave: () => void, options?: MacroLeaveOptions) => Promise<boolean>
}

export function createMacroEditorLeaveController(): MacroEditorLeaveController {
  let finalize: MacroFinalize | null = null
  let inFlight: Promise<boolean> | null = null
  let latestIntent: {
    onLeave: () => void
    options: MacroLeaveOptions
  } | null = null

  return {
    register(nextFinalize) {
      finalize = nextFinalize
      return () => {
        if (finalize === nextFinalize) finalize = null
      }
    },
    leave(onLeave, options = {}) {
      latestIntent = { onLeave, options }
      if (inFlight) return inFlight
      const activeFinalize = finalize
      const task = (async () => {
        if (!latestIntent?.options.discard) {
          if (!activeFinalize) {
            latestIntent = null
            return false
          }
          try {
            await activeFinalize()
          } catch {
            if (!latestIntent?.options.discard) {
              latestIntent = null
              return false
            }
          }
        }
        const intent = latestIntent
        latestIntent = null
        if (!intent) return false
        intent.onLeave()
        return true
      })()
      inFlight = task
      void task.finally(() => {
        if (inFlight === task) inFlight = null
      })
      return task
    },
  }
}
