import { variantForImageCount } from '../../../../packages/model-catalog/imageCapacity'
import type { CatalogModel, JobKind } from '../../types'

// Какая модель реально отработает (та же логика, что и в серверном resolveModel):
// видео-референс переключает только на videoPairId выбранной семьи; иначе явная база +
// есть картинка-референс → её ref-вариант (pairId); Авто + референс — первая
// ref-модель типа; иначе — сама выбранная / первая базовая. Картинок больше,
// чем берёт вариант, — вариант семьи, который возьмёт (Seedance: «кадры» до
// двух, «по референсам» до девяти; правило общее с сервером, imageCapacity.ts).
//
// ⚠️ Отдельный модуль без React и сети НАМЕРЕННО: его сверяет со своим
// сервером server/src/imageRefVariant.test.ts, а genOptions.ts тянет за собой
// api.ts, который серверная проверка типов не собирает.
export function effectiveModel(
  models: CatalogModel[],
  kind: JobKind,
  modelId: string | null,
  hasImageRefs: boolean,
  hasVideoRefs = false,
  hasAudioRefs = false,
  imageRefCount = hasImageRefs ? 1 : 0,
): CatalogModel | null {
  const list = models.filter((m) => m.kind === kind)
  if (modelId) {
    const chosen = models.find((m) => m.id === modelId)
    if (!chosen) return null
    if (hasVideoRefs || hasAudioRefs) {
      if (chosen.videoPairId) {
        const pair = models.find((m) => m.id === chosen.videoPairId)
        if (pair && (!hasAudioRefs || (pair.maxAudioRefs ?? 0) > 0)) return pair
      }
      return chosen
    }
    if (!hasImageRefs) return chosen
    const pair = !chosen.refs && chosen.pairId ? models.find((m) => m.id === chosen.pairId) : undefined
    return variantForImageCount(models, pair ?? chosen, imageRefCount)
  }
  if (hasVideoRefs || hasAudioRefs) {
    const videoModel = list.find(
      (m) => m.videoRefs && (!hasAudioRefs || (m.maxAudioRefs ?? 0) > 0),
    )
    if (videoModel) return videoModel
  }
  if (hasImageRefs) {
    const refModel = list.find((m) => m.refs)
    if (refModel) return variantForImageCount(models, refModel, imageRefCount)
  }
  return list.find((m) => !m.refs) ?? list[0] ?? null
}
