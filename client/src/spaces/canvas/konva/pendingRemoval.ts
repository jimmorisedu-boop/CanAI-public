import { isOrphanedLaunch } from '../pendingLaunchState'
import type { Placeholder } from './types'

/**
 * Что делает Delete с карточкой на холсте.
 *
 * ⚠️ Жалобы 01.10.2026: «пытаюсь удалить картинку, а он пишет предупреждение —
 * причём эта картинка появляется после кропа» и «генерация зависла, и её никак
 * не убрать». Прежнее правило было одно: карточка «идёт» — значит, не убирается
 * вовсе, а человеку показывают «Генерация ещё идёт» с кнопкой «Остановить».
 * Оно верно ровно для одного случая — живой платной генерации, — а применялось
 * ко всему, что крутится:
 *
 * - карточка СВОЕЙ работы (обрезка, скетч, кадр, перенос файла вставки) — не
 *   генерация: её называли генерацией и предлагали «Остановить» то, что
 *   остановить нечем (номер `local:` серверу неизвестен);
 * - карточка, чья задача уже ЗАКОНЧИЛАСЬ (готова, упала, отменена), а сама она
 *   по какой-то причине осталась крутиться, не убиралась ничем: ждать ей
 *   нечего, а «Остановить» шло в задачу, которой больше нет.
 *
 * Карточку человек обязан уметь убрать всегда, кроме случая, когда за ней
 * стоит живая работа, которую можно потерять: идущая генерация (своя или
 * коллеги) и идущее скачивание по ссылке.
 */
export type PendingRemoval =
  /** Убрать сразу: за карточкой ничего не стоит. */
  | 'remove'
  /** Идёт платная генерация — сперва её надо остановить. */
  | 'running-generation'
  /** Идёт скачивание по ссылке. */
  | 'running-import'
  /** Запуск ещё не получил номер задачи: остановить пока нечего. */
  | 'launching'

type TaskState = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'error'

const FINISHED: ReadonlySet<TaskState> = new Set(['done', 'error', 'cancelled'])

export function pendingRemoval(
  card: Pick<Placeholder, 'status' | 'transient' | 'jobId' | 'taskType' | 'startedAt'>,
  now: number,
  /** Что реестр задач этой вкладки знает о задаче; `undefined` — не знает ничего. */
  taskState: (jobId: string) => TaskState | undefined,
): PendingRemoval {
  if (card.status !== 'loading') return 'remove'
  // Своя работа живёт в этой вкладке: убрали карточку — отказались от работы.
  if (card.transient) return 'remove'
  // «Запуск прервался»: номер задачи так и не пришёл (pendingLaunchState).
  if (isOrphanedLaunch(card, now)) return 'remove'
  if (!card.jobId) return 'launching'
  if (card.taskType === 'media-import') return 'running-import'
  // Пометка «задачи на сервере нет» — ждать такой карточке нечего.
  if (card.jobId.startsWith('local:')) return 'remove'
  const state = taskState(card.jobId)
  // ⚠️ Задачу, о которой эта вкладка не знает, считаем ЖИВОЙ: на сетевой доске
  // так выглядит генерация коллеги, и убрать её карточку значит оставить его
  // оплаченный результат без места.
  if (state && FINISHED.has(state)) return 'remove'
  return 'running-generation'
}
