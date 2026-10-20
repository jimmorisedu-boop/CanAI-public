// Идущие прогоны макросов — общий read-model для центра задач в шапке.
//
// Живёт над React (как generationRegistry): прогон переживает перерисовку
// промпт-бара, а шапка читает его, ничего не зная про внутренности
// PromptMacros. Единица здесь — ОДИН КЛИК по слоту (launch token), а не
// отдельная нода и не отдельный батч: серия кликов = несколько строк в списке,
// и остановить можно ровно ту, которую надо.
//
// Сама отмена остаётся в macroLaunches (флаг на запуск, движок читает его на
// каждом тике опроса) — сюда кладётся только замыкание-стоппер.

export interface MacroRun {
  // токен запуска из MacroLaunchRegistry
  token: number
  macroId: string
  macroName: string
  startedAt: number
  progress?: string
  // «Стоп» нажат, движок ещё доигрывает текущий тик
  stopping: boolean
}

const runs = new Map<number, MacroRun>()
const stoppers = new Map<number, () => void>()
const listeners = new Set<() => void>()
let snapshot: MacroRun[] = []

function notify(): void {
  snapshot = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  for (const listener of listeners) listener()
}

export function beginMacroRun(input: {
  token: number
  macroId: string
  macroName: string
  stop: () => void
}): void {
  runs.set(input.token, {
    token: input.token,
    macroId: input.macroId,
    macroName: input.macroName,
    startedAt: Date.now(),
    stopping: false,
  })
  stoppers.set(input.token, input.stop)
  notify()
}

export function updateMacroRun(token: number, patch: { progress?: string }): void {
  const run = runs.get(token)
  if (!run || run.progress === patch.progress) return
  runs.set(token, { ...run, ...patch })
  notify()
}

export function endMacroRun(token: number): void {
  stoppers.delete(token)
  if (!runs.delete(token)) return
  notify()
}

// Помечаем прогон отменённым. Строка не исчезает сразу: движок узнает об отмене
// на ближайшем тике (до ~1 с) и сам вызовет endMacroRun — до этого честно
// показываем «останавливаю…», а не делаем вид, что уже всё.
export function stopMacroRun(token: number): void {
  const run = runs.get(token)
  if (!run || run.stopping) return
  runs.set(token, { ...run, stopping: true })
  notify()
  stoppers.get(token)?.()
}

export function stopAllMacroRuns(): number {
  const tokens = [...runs.keys()]
  for (const token of tokens) stopMacroRun(token)
  return tokens.length
}

export function subscribeMacroRuns(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getMacroRuns(): MacroRun[] {
  return snapshot
}
