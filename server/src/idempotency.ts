import type { Job } from './jobs.js'

/**
 * Пункт плана аудита 4 — серверная идемпотентность POST /api/generate.
 *
 * Если ответ сервера потерялся (сетевой обрыв постановки) и клиент повторил
 * запрос с тем же idempotencyKey, мы обязаны вернуть УЖЕ созданную задачу, а
 * не поставить вторую — иначе локальная (и legacy-cloud) генерация заплатит
 * за один запуск дважды. Ключ присылает честный клиент (useGeneration/prepare),
 * у account-cloud повтор-ловля уже стоит в самом обработчике.
 *
 * Функция чистая, чтобы её легко было покрыть юнит-тестом: для сети/планшета
 * (локальный маршрут) полноценный HTTP-прогон требует ключа fal.ai, поэтому
 * решение о повторе вынесено сюда и проверено напрямую.
 */
export function findIdempotentReplay(
  candidates: readonly Job[],
  input: {
    idempotencyKey: string
    generationRoute: Job['generationRoute']
    /** Доска, на которую встанет результат (может отсутствовать — без доски). */
    projectId?: string
  },
): Job | undefined {
  const { idempotencyKey, generationRoute } = input
  // Один и тот же ключ на РАЗНЫХ досках — разные запуски, а не повтор:
  // дедуп ограничиваем доской, чтобы повтор не вернул чужой результат.
  return candidates.find((candidate) => {
    if (candidate.idempotencyKey !== idempotencyKey) return false
    if (candidate.generationRoute !== generationRoute) return false
    if (!input.projectId) return true
    return canvasTargetProjectId(candidate) === input.projectId
  })
}

function canvasTargetProjectId(job: Job): string | null {
  return job.target?.kind === 'canvas' ? job.target.projectId : null
}

/** TRUE, если маршрут покрывается повтором-ловлей на стороне сервера. */
export function idempotencyAppliesTo(route: Job['generationRoute']): boolean {
  return route === 'local'
}