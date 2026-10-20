import type { GenRef, Job } from '../../types'
import type { CanvasStore } from './konva/canvasStore'
import type { SelectionRef } from './konva/selection'
import type { Placeholder } from './konva/types'
import { shortText } from './RefChip'
import { reportOnboardingSuccess } from './onboardingEvents'

// Что делать с задачей, которая доработала: положить результат на холст или
// покрасить заглушку ошибкой.
//
// Живёт отдельным модулем, а не в промпт-баре: этим же путём результаты
// доезжают на ПЛАНШЕТЕ, а тянуть туда промпт-бар значит тянуть весь холст на
// Konva. Логика при этом ровно одна на оба устройства — так и должно быть,
// иначе результат вставал бы по-разному в зависимости от того, откуда его
// запустили.

/** Что известно о запуске сверх самой задачи. */
export interface CanvasSettleContext {
  /**
   * Карточка, в которую запущена задача. ⚠️ Номер задачи карточка может
   * потерять (на сетевой доске он не едет на сервер команды и стирается
   * свежим снимком), а свой номер — нет: по нему её и находим.
   */
  placeholderId?: string
  /** Промпт запуска: у задачи сервера команды его в ответе нет (`cloudJobView`). */
  prompt?: string
  modelId?: string
}

export async function settleCanvasGeneration(
  job: Job,
  store: Pick<CanvasStore, 'getPending' | 'resolveJob'> & {
    failPendingByJob?: (jobId: string, error: string, placeholderId?: string) => boolean
  },
  context: CanvasSettleContext = {},
): Promise<void> {
  if (job.status !== 'done' || !job.result || (!job.result.url && !job.result.text?.trim())) return
  const pending = store.getPending().find((item) => item.jobId === job.id)
  const prompt = job.prompt || context.prompt || ''
  try {
    // Номер сервера команды — чтобы узнать объект, который он уже поставил сам.
    await store.resolveJob(job.id, job.result, shortText(prompt), {
      cloudJobId: job.cloudJobId,
      prompt: prompt || undefined,
      modelId: context.modelId,
    })
    if (store.getPending().some(item => item.jobId === job.id && item.status === 'error')) return
    reportOnboardingSuccess('first-generation')
    if (pendingUsedReferences(pending)) reportOnboardingSuccess('reference-generation')
  } catch (error) {
    // Ошибку размещения показывает существующая обратная связь; обучение не отмечаем.
    // Если resolveJob не пометил заглушку сам, красим её ошибкой сразу — иначе
    // спиннер крутился бы вечно (реестр не делает клиентского повторного повтора).
    if ((pending || context.placeholderId) && store.failPendingByJob) {
      store.failPendingByJob(
        job.id,
        error instanceof Error ? error.message : "Failed to post result on board",
        context.placeholderId,
      )
    }
  }
}

const CANCELLED_ERROR = 'Cancelled'

function isCancelledError(error: unknown): boolean {
  return error === CANCELLED_ERROR || error === 'отменено'
}

export function hasUsedGenerationReferences(refs: readonly GenRef[]): boolean {
  return refs.length > 0
}

export function buildPendingGenerationMetadata(
  refs: readonly SelectionRef[],
  genRefs: readonly GenRef[],
): Pick<Placeholder, 'referenceIds' | 'usedReferences'> {
  return {
    referenceIds: refs.map((ref) => ref.shapeId),
    usedReferences: hasUsedGenerationReferences(genRefs),
  }
}

function pendingUsedReferences(pending: Pick<Placeholder, 'usedReferences' | 'retry'> | undefined): boolean {
  return pending?.usedReferences ?? Boolean(pending?.retry?.refs.length)
}

export function handleSettledCanvasGeneration(
  job: Job,
  store: Pick<CanvasStore, 'failPendingByJob' | 'getPending' | 'resolveJob'>,
  setLocalError: (message: string) => void,
  context: CanvasSettleContext = {},
): void {
  const { placeholderId } = context
  // ⚠️ «Отменена» — финал сервера команды, и в нашем словаре статусов его нет.
  // Центр задач его понимал, а карточка на доске — нет: она крутилась дальше у
  // всех, кто открывал доску (так застряли две отменённые генерации 23.09).
  if (String(job.status) === 'cancelled') {
    store.failPendingByJob(job.id, CANCELLED_ERROR, placeholderId)
    return
  }
  if (job.status === 'error') {
    if (isCancelledError(job.error)) {
      store.failPendingByJob(job.id, CANCELLED_ERROR, placeholderId)
      return
    }
    if (!store.failPendingByJob(job.id, job.error ?? "failed", placeholderId)) {
      setLocalError(`Failed: ${job.error ?? "unknown error"}`)
    }
    return
  }
  void settleCanvasGeneration(job, store, context)
}
