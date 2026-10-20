import type { CatalogModel, ProjectSource } from '../../types'
import { mediaLaunchUsd, type CostInputs } from '../../../../packages/model-catalog/mediaCost'

/** Локальный порог не должен создавать второе окно поверх cloud-котировки. */
export function shouldAskLocalCostConfirmation(
  projectSource: ProjectSource,
  falConfigured: boolean,
  estimatedCost: number | null,
  confirmCostAboveUsd: number,
): boolean {
  return projectSource === 'local'
    && falConfigured
    && estimatedCost !== null
    && estimatedCost >= confirmCostAboveUsd
}

/**
 * То, что знает только место запуска. Цена некоторых моделей зависит не от
 * ручек, а от входа: озвучка — от длины текста, апскейл — от размера картинки.
 * Не знаем — цены нет (null), и подтверждение честно скажет «неизвестно».
 */
export type { CostInputs }

/** Самая крупная по площади картинка среди референсов (`w`/`h` — натуральный размер). */
export function largestImage(
  refs: ReadonlyArray<{ kind: string; w?: number; h?: number }>,
): CostInputs['inputImage'] {
  let largest: CostInputs['inputImage']
  for (const ref of refs) {
    if (ref.kind !== 'image' || !ref.w || !ref.h) continue
    if (!largest || ref.w * ref.h > largest.width * largest.height) largest = { width: ref.w, height: ref.h }
  }
  return largest
}

/**
 * Цена серии запусков. Правила самой цены — в общем модуле каталога
 * (`packages/model-catalog/mediaCost.ts`): их же читает агентская оценка
 * сервера, и две копии уже однажды разъехались.
 */
export function estimateGenerationCost(
  model: CatalogModel | null | undefined,
  params: Record<string, unknown>,
  count: number,
  referenceCount = 0,
  inputs: CostInputs = {},
): number | null {
  const launchUsd = mediaLaunchUsd(model, params, referenceCount, inputs)
  if (launchUsd == null) return null
  return roundMicros(launchUsd * Math.max(1, count))
}

function roundMicros(total: number): number {
  return Math.round(total * 1_000_000) / 1_000_000
}
