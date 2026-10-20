import type { GenerationLaunchGroup } from './generationLaunches'
import { generationConnectionLabel, type GenerationTaskState } from './generationRegistry'
import { systemErrorMessage } from '../../ui/systemMessage'

/**
 * Что и как показывает строка центра задач.
 *
 * ⚠️ Список задач — служебное окно: в него заглядывают, чтобы понять, идёт ли
 * работа и не упало ли что-то. Он разросся до четырёх строк и полосы прогресса
 * на КАЖДЫЙ запуск, и десяток одиночных генераций читался как стена одинаковых
 * карточек «Запуск генерации · Модель не указана · эта доска · 1 из 1 готово»
 * (жалоба 07.09.2026 — «очень тяжело для понимания»).
 *
 * Правило: строка говорит ровно то, чего нет рядом. Один вариант — «1 из 1
 * готово» не сообщает ничего сверх слова «Готово»; заглушки вместо
 * отсутствующих промпта и модели не сообщают ничего вовсе; полная полоса
 * прогресса у законченного запуска — тоже.
 */

const ACTIVE_STATES: GenerationTaskState[] = ['queued', 'running']
const TERMINAL_STATES: GenerationTaskState[] = ['done', 'error', 'cancelled']

const SINGLE_LABELS: Record<GenerationTaskState, string> = {
  queued: "Queued",
  running: "Creating",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  done: "Done",
  error: "Error",
}

export interface LaunchGroupView {
  /** Заголовок строки: промпт, а без него — имя модели. */
  title: string
  /** Подпись под заголовком; пустая строка означает «не показывать». */
  meta: string
  /** Состояние словами. */
  summary: string
  /** Полоса прогресса нужна, только пока есть чего ждать. */
  showProgress: boolean
  /** Разворачивать по вариантам есть смысл, когда их больше одного. */
  expandable: boolean
}

function counts(group: GenerationLaunchGroup): Record<string, number> {
  const done = group.variants.filter((variant) => variant.state === 'done').length
  const active = group.variants.filter((variant) => ACTIVE_STATES.includes(variant.state)).length
  const cancelling = group.variants.filter((variant) => variant.state === 'cancelling').length
  const errors = group.variants.filter((variant) => variant.state === 'error').length
  const cancelled = group.variants.filter((variant) => variant.state === 'cancelled').length
  const reconnecting = group.variants.filter((variant) => variant.connection === 'reconnecting').length
  const deliveryErrors = group.variants.filter((variant) => variant.connection === 'delivery-error').length
  return { done, active, cancelling, errors, cancelled, reconnecting, deliveryErrors }
}

export function launchGroupSummary(group: GenerationLaunchGroup): string {
  const single = group.variantCount === 1 ? group.variants[0] : null
  if (single) {
    // Одна задача — говорим её состояние, а не арифметику «1 из 1». Причина
    // ошибки полезнее любого счётчика, поэтому она идёт прямо здесь.
    const connection = generationConnectionLabel(single.connection)
    if (connection) return single.connection === 'delivery-error' && single.error
      ? `${connection}: ${systemErrorMessage(single.error)}`
      : connection
    const label = SINGLE_LABELS[single.state]
    return single.state === 'error' && single.error ? `${label}: ${systemErrorMessage(single.error)}` : label
  }
  const { done, active, cancelling, errors, cancelled, reconnecting, deliveryErrors } = counts(group)
  const parts = [`${done} of ${group.variantCount} ready`]
  if (active > 0) parts.push(`${active} creating`)
  if (reconnecting > 0) parts.push(`${reconnecting} reconnecting`)
  if (cancelling > 0) parts.push(`${cancelling} stopping`)
  if (errors > 0) parts.push(`${errors} with errors`)
  if (deliveryErrors > 0) parts.push(`${deliveryErrors} with delivery errors`)
  if (cancelled > 0) parts.push(`${cancelled} cancelled`)
  return parts.join(' · ')
}

export function launchGroupView(
  group: GenerationLaunchGroup,
  options: { currentProjectId?: string } = {},
): LaunchGroupView {
  const prompt = group.launch?.promptPreview?.trim() ?? ''
  const model = group.launch?.modelName?.trim() ?? ''
  const cost = group.launch?.estimatedTotalCostUsd
  const projectId = group.launch?.projectId ?? group.variants[0]?.target.projectId
  const ownBoard = Boolean(projectId && projectId === options.currentProjectId)
  const boardName = group.launch?.projectName?.trim() ?? ''

  const meta: string[] = []
  // Модель уходит в подпись, только если заголовок занят промптом: иначе она
  // же и есть заголовок, и повторять её вторым рядом незачем.
  if (prompt && model) meta.push(model)
  // Про свою доску молчим — человек и так на ней. Называем только чужую.
  if (!ownBoard) meta.push(boardName || "another board")
  // ⚠️ Списанное перебивает оценку. У моделей с тарифом «по факту» (GPT Image
  // 2.5) оценка — это резерв-потолок ($2), а не цена: fal объявляет расход
  // после генерации. Пока считалась оценка, человек видел только потолок и
  // не мог узнать, во что обошлась работа (09.09.2026).
  const charged = group.variants.reduce<number | null>((sum, variant) => (
    typeof variant.chargedUsd === 'number' && Number.isFinite(variant.chargedUsd)
      ? (sum ?? 0) + variant.chargedUsd
      : sum
  ), null)
  // Сумму показываем, только когда посчитана ВСЯ серия: пока хоть один вариант
  // считается или его расход не сверен, частичная сумма врала бы в меньшую
  // сторону — а это хуже честной оценки.
  const settledAll = charged != null && group.variants.every((variant) => (
    TERMINAL_STATES.includes(variant.state)
    && (variant.state !== 'done' || typeof variant.chargedUsd === 'number')
  ))
  if (settledAll) meta.push(`$${charged.toFixed(charged < 0.1 ? 3 : 2)}`)
  else if (cost != null && Number.isFinite(cost)) meta.push(`≈ $${cost.toFixed(cost < 0.1 ? 3 : 2)}`)

  const settled = group.variants.every((variant) => TERMINAL_STATES.includes(variant.state))
  return {
    title: prompt || model || "Generation",
    meta: meta.join(' · '),
    summary: launchGroupSummary(group),
    showProgress: group.variantCount > 1 && !settled,
    expandable: group.variantCount > 1,
  }
}
