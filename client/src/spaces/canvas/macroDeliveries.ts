import type { JobResult } from '../../types'

// Доставка результатов макроса НА СВОЮ доску — даже если доска сейчас закрыта.
//
// Жалоба 19.08.2026: «запустил макрос, зашёл в него, потом случайно вышел с
// доски — генерации не появляются, хз выполнились они или нет».
//
// Причина, воспроизведённая вживую: у каждой открытой доски СВОЙ экземпляр
// CanvasStore (`new CanvasStore()` в CanvasSpace, и App пересобирает его через
// `key={project.id}`). Прогон макроса живёт в промисе и уход с доски его не
// останавливает — он продолжает опрашивать задачи и честно доводит генерации
// до конца. А вот КЛАДЁТ он их в тот стор, который захватил при запуске: после
// ухода это уже мёртвый объект без автосейва. Замер: результат лёг в мёртвый
// стор (1 объект), в project.json на сервере осталось 0, возврат на доску
// создал новый стор — и на холсте пусто. Деньги списаны, файл на диске лежит
// без ссылок, и ближайшая сборка мусора его удалит.
//
// Поэтому результат больше не отдаётся стору напрямую. Он отдаётся СЮДА, а
// модуль живёт над React: доска открыта — доставляем сразу, закрыта — держим
// у себя и отдаём, когда её откроют. Тот же приём, что у generationRegistry с
// его parked-доставками, только для нодового движка макросов.
//
// Чего этот модуль НЕ умеет и не притворяется: пережить перезагрузку страницы.
// Задачи макроса нигде не записаны (их болванки помечены transient и в
// project.json не попадают), так что при F5 прогон теряется целиком — это
// отдельная задача, а не побочный эффект этой.

export interface MacroDelivery {
  result: JobResult
  /** Имя макроса — станет подписью объекта на холсте. */
  label: string
  /** Болванка, на место которой встаёт результат, если доска открыта. */
  jobId?: string
}

export type MacroDeliverySink = (delivery: MacroDelivery) => void

const sinks = new Map<string, MacroDeliverySink>()
const parked = new Map<string, MacroDelivery[]>()

export function deliverMacroResult(projectId: string, delivery: MacroDelivery): void {
  const sink = sinks.get(projectId)
  if (sink) {
    sink(delivery)
    return
  }
  const waiting = parked.get(projectId) ?? []
  waiting.push(delivery)
  parked.set(projectId, waiting)
}

/**
 * Доска открылась и готова принимать. Всё, что накопилось, отдаём сразу же —
 * порядком поступления, чтобы объекты встали так же, как встали бы вживую.
 */
export function registerMacroDeliverySink(
  projectId: string,
  sink: MacroDeliverySink,
): () => void {
  sinks.set(projectId, sink)
  const waiting = parked.get(projectId)
  if (waiting?.length) {
    parked.delete(projectId)
    for (const delivery of waiting) sink(delivery)
  }
  return () => {
    if (sinks.get(projectId) === sink) sinks.delete(projectId)
  }
}

/** Сколько результатов ждёт эту доску — для сообщения пользователю. */
export function parkedMacroResults(projectId: string): number {
  return parked.get(projectId)?.length ?? 0
}

/** Только для тестов: модуль общий на всё приложение. */
export function resetMacroDeliveries(): void {
  sinks.clear()
  parked.clear()
}
