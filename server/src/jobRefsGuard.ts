import type { Job } from './jobs.js'
import { validateModelRefs } from './modelRefLimits.js'
import type { IncomingRef } from './refs.js'

/** Отказ до оплаты: текст идёт человеку как есть, без перевода «на язык fal». */
export class JobRefsRefusedError extends Error {}

/**
 * Последняя проверка референсов перед оплатой — для НОВОЙ задачи.
 *
 * ⚠️ resolveModel, получив ролик или звук для модели, которая их не берёт
 * (MiniMax H3), молча переключает запуск на первую модель, которая берёт, —
 * Seedance «по референсам»: другая модель и другая цена. Маршрут /generate и
 * макросы отказывают раньше, но любая новая дорога запуска попала бы сюда
 * молча. Поэтому правило проверки (validateModelRefs) стоит и у самого
 * запуска: та же проверка, те же слова.
 *
 * Не трогаем то, что уже ушло провайдеру (requestId, оплаченный результат,
 * задача сервера команды): прежнее переключение остаётся ради восстановления
 * оплаченных задач. Не трогаем и сетевую доску — там модели и пределы задаёт
 * сервер команды, — и закреплённую агентом модель (свой снимок, свои
 * проверки). Текстовые задачи моделей не переключают.
 */
export function newJobRefsRefusal(job: Job, refs: readonly IncomingRef[]): string | null {
  if (job.modelSnapshot || job.kind === 'text') return null
  if (job.falRequestId || job.paidResult?.url) return null
  return validateModelRefs(job.model, job.kind, [...refs])
}
