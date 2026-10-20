// История поля промпта для Ctrl+Z / Ctrl+Y. Своя, а не браузерная: поле
// управляемое React'ом, и штатная отмена в нём работает неверно.
//
// Логика чистая и без React — так её видно целиком и можно проверить тестом,
// а не гадать по поведению поля.

export interface PromptTextHistory {
  values: string[]
  index: number
  lastPushAt: number
}

// Пауза, после которой набор считается новым шагом отмены. Иначе каждый
// символ был бы отдельным шагом и Ctrl+Z стирал бы по букве.
export const COALESCE_MS = 800
const LIMIT = 100

export function createPromptHistory(initial = ''): PromptTextHistory {
  return { values: [initial], index: 0, lastPushAt: 0 }
}

export function pushPromptValue(
  history: PromptTextHistory,
  value: string,
  options: { force?: boolean; now: number },
): PromptTextHistory {
  const current = history.values[history.index]
  if (current === value) return history

  const { force = false, now } = options
  // конец слова или строки — естественная граница шага
  const finishedWord =
    value.length > current.length && (value.endsWith(' ') || value.endsWith('\n'))
  const startsNewStep = force || finishedWord || now - history.lastPushAt > COALESCE_MS

  const head = history.values.slice(0, history.index + 1)
  if (!startsNewStep && history.index === history.values.length - 1) {
    // дописываем текущий шаг, не плодя новый
    head[head.length - 1] = value
    return { values: head, index: head.length - 1, lastPushAt: history.lastPushAt }
  }

  head.push(value)
  const values = head.length > LIMIT ? head.slice(head.length - LIMIT) : head
  return {
    values,
    index: values.length - 1,
    lastPushAt: startsNewStep ? now : history.lastPushAt,
  }
}

export function undoPromptValue(
  history: PromptTextHistory,
): { history: PromptTextHistory; value: string } | null {
  if (history.index <= 0) return null
  const index = history.index - 1
  return { history: { ...history, index }, value: history.values[index] }
}

export function redoPromptValue(
  history: PromptTextHistory,
): { history: PromptTextHistory; value: string } | null {
  if (history.index >= history.values.length - 1) return null
  const index = history.index + 1
  return { history: { ...history, index }, value: history.values[index] }
}
