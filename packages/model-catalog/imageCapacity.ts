// Вариант семьи под ЧИСЛО картинок-референсов. Одно правило на приложение
// (`effectiveModel` в client/src/spaces/canvas/genOptions.ts — цена, ручки,
// согласие) и на свой сервер (`resolveModel` в catalog.ts — проверка и запуск):
// разойдись они — человек увидел бы одну модель, а запустилась бы другая.
//
// ⚠️ У Seedance 2.0 картинки берут ДВА варианта: «первый и последний кадр»
// (`seedance-2-i2v`, до двух) и «по референсам» (`seedance-2-refs`, до девяти).
// С картинкой всегда включался первый, второй — только роликом или звуком, и
// три картинки получали отказ «не больше двух», хотя модель их берёт (аудит
// моделей 19.10.2026, находка 4). Сервер команды такой запуск давно уводит «по
// референсам» (`frameCapacity` там).
//
// ⚠️ Переходим, только если другой вариант семьи ОБЪЯВИЛ, что возьмёт столько
// картинок (`maxImageRefs`, `maxTotalRefs`). У Grok и Gemini Omni Flash
// «видео-вариант» — правка ролика, картинок он не берёт, и две картинки туда
// уйти не должны: там лучше честный отказ, чем запуск без них.

export interface ImageCapacityModel {
  id: string
  pairId?: string
  videoPairId?: string
  maxImageRefs?: number
  maxTotalRefs?: number
}

/** Сколько картинок вариант берёт за запуск; без пределов — сколько угодно. */
function capacity(model: ImageCapacityModel): number {
  return Math.min(model.maxImageRefs ?? Infinity, model.maxTotalRefs ?? Infinity)
}

/**
 * `variant` — вариант, который выбран для запуска с картинками (обычно
 * `pairId` базы). Не берёт столько картинок — вариант «по референсам» той же
 * семьи (`videoPairId` базы), если он объявил, что берёт их БОЛЬШЕ. Не возьмёт
 * и он (у Seedance десять картинок) — отказ «слишком много картинок» остаётся
 * за проверкой, но называет настоящий предел модели (девять), а не два.
 */
export function variantForImageCount<T extends ImageCapacityModel>(
  models: readonly T[],
  variant: T,
  images: number,
): T {
  if (images <= capacity(variant)) return variant
  const base = models.find((model) => model.pairId === variant.id) ?? variant
  const wide = base.videoPairId ? models.find((model) => model.id === base.videoPairId) : undefined
  return wide && wide.maxImageRefs != null && capacity(wide) > capacity(variant) ? wide : variant
}
