import { useCallback, useRef } from 'react'
import {
  createPromptHistory,
  pushPromptValue,
  redoPromptValue,
  undoPromptValue,
  type PromptTextHistory,
} from './promptTextHistory'

// Тонкая обвязка над чистой историей: держит её в ref (перерисовка на каждый
// символ здесь не нужна) и отдаёт три действия.
export function usePromptTextHistory(setPrompt: (value: string) => void) {
  const history = useRef<PromptTextHistory>(createPromptHistory())

  const push = useCallback((value: string, force = false) => {
    history.current = pushPromptValue(history.current, value, { force, now: Date.now() })
  }, [])

  const undo = useCallback(() => {
    const step = undoPromptValue(history.current)
    if (!step) return
    history.current = step.history
    setPrompt(step.value)
  }, [setPrompt])

  const redo = useCallback(() => {
    const step = redoPromptValue(history.current)
    if (!step) return
    history.current = step.history
    setPrompt(step.value)
  }, [setPrompt])

  return { push, undo, redo }
}
