import type { JobKind } from '../../types'

// Правила опроса задач — одни на всё приложение.
//
// Опросчиков в CanAI ДВА и останется два, это осознанно: реестр
// (generationRegistry) ведёт пачку задач на общем таймере, переживает смену
// доски и кормит центр задач; api.generateAndWait ждёт ОДНУ задачу и нужен
// движку нод, где шаги идут последовательно и следующий начинается только
// после предыдущего. Слить их в один цикл — значит переписать управление
// платными прогонами ради красоты, а не ради пользы.
//
// А вот расходиться в ПРАВИЛАХ им нельзя: интервал, порог «связи нет» и
// формулировки — это то, что пользователь видит, и в двух местах они уже
// начинали жить своей жизнью. Правила здесь, циклы — у себя.

export const POLL_MS = 900
// как часто опрашиваем, когда вкладка скрыта: результат подождёт, а батарея нет
export const POLL_HIDDEN_MS = 4000
// сорок неудачных опросов подряд (≈36 секунд) — считаем, что связи нет
export const MAX_CONSECUTIVE_ERRORS = 40

// Видео делается минутами, картинка — секундами. Потолок нужен, чтобы висящая
// задача не крутила спиннер вечно; он заведомо больше любого нормального срока.
export function jobDeadlineMs(kind: JobKind): number {
  return kind === 'video' ? 16 * 60_000 : 5 * 60_000
}

export const JOB_LOST = "the task was not found on the server - repeat the generation"
export const JOB_NO_CONNECTION = "no connection to the server"
export const JOB_TIMED_OUT = "generation too long - canceled due to timeout"
export const JOB_FAILED = "generation failed"
