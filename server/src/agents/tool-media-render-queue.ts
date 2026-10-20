import { AgentToolError } from './tool-shared.js'

// Очередь рендеров: один ffmpeg за раз на всё приложение. Монтаж загружает
// процессор или видеокарту целиком, а человек в это время работает на доске —
// два параллельных рендера отняли бы у него машину и удвоили бы место на
// диске. Здесь же отмена: задачу сняли — её рендер умирает сразу, а не
// дорабатывает до конца.

const active = new Map<string, Set<AbortController>>()
let tail: Promise<void> = Promise.resolve()

function cancelled(): AgentToolError {
  return new AgentToolError('MEDIA_RENDER_CANCELLED', 'Render stopped with the task')
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

/** Остановить все рендеры задачи: идущий — убить, ждущие в очереди — снять. */
export function cancelMediaRenders(taskId: string): void {
  for (const controller of active.get(taskId) ?? []) controller.abort()
}

/** Сколько рендеров задачи сейчас идёт или ждёт очереди. For проверок. */
export function pendingMediaRenders(taskId: string): number {
  return active.get(taskId)?.size ?? 0
}

export async function runExclusiveRender<T>(taskId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const mine = active.get(taskId) ?? new Set<AbortController>()
  mine.add(controller)
  active.set(taskId, mine)

  const previous = tail
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  // Следующий в очереди ждёт и предыдущего, и нас. Иначе снятый из очереди
  // (он выходит, не дождавшись предыдущего) пропустил бы следующего вперёд,
  // пока предыдущий ещё рендерит.
  tail = previous.then(() => gate)

  const aborted = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
  try {
    await Promise.race([previous, aborted])
    throwIfCancelled(controller.signal)
    return await work(controller.signal)
  } finally {
    release()
    mine.delete(controller)
    if (mine.size === 0 && active.get(taskId) === mine) active.delete(taskId)
  }
}
