import type { CatalogModel } from '../../types'
import type { CanvasItem } from './konva/types'

export interface BoardModelUsage {
  modelId: string
  modelName: string
  count: number
  kind: 'image' | 'video' | 'text' | 'audio'
  percentage: number
}

/**
 * Реальные запуски генерации на доске (plan §Этап 1, «Отделить статистику
 * объектов от статистики реальных job usages»). В отличие от `modelsUsage`
 * (объектная статистика — каждая картинка считается), `usages` считается по
 * УНИКАЛЬНЫМ `sourceJobId`: копия результата (Alt+drag или «дублировать») — это
 * тот же самый запуск, и он не должен завышать статистику и предпочтение модели.
 * Записи без достоверного job/source ID в этот список не попадают вовсе.
 */
export interface BoardUsageEntry {
  modelId: string
  modelName: string
  usages: number
  kind: 'image' | 'video' | 'text' | 'audio'
}

export interface BoardPromptHistoryItem {
  prompt: string
  modelId?: string
  modelName?: string
  kind: 'image' | 'video'
}

export interface BoardMemory {
  totalItems: number
  imageCount: number
  videoCount: number
  textCount: number

  preferredImageModel?: {
    modelId: string
    modelName: string
    count: number
    percentage: number
    /** По каким данным посчитано предпочтение: 'usages' — реальные запуски,
     *  'objects' — объектная статистика legacy-доски без sourceJobId. */
    basis: 'usages' | 'objects'
  }

  preferredVideoModel?: {
    modelId: string
    modelName: string
    count: number
    percentage: number
    basis: 'usages' | 'objects'
  }

  modelsUsage: BoardModelUsage[]
  realUsages: BoardUsageEntry[]
  hasRealUsages: boolean
  recentPrompts: BoardPromptHistoryItem[]
  textNotes: string[]
}

export function extractBoardMemory(items: readonly CanvasItem[]): BoardMemory {
  if (!items || items.length === 0) {
    return {
      totalItems: 0,
      imageCount: 0,
      videoCount: 0,
      textCount: 0,
      modelsUsage: [],
      realUsages: [],
      hasRealUsages: false,
      recentPrompts: [],
      textNotes: [],
    }
  }

  let imageCount = 0
  let videoCount = 0
  let textCount = 0

  const modelCounts = new Map<string, { count: number; name: string; kind: 'image' | 'video' | 'text' | 'audio' }>()
  const rawPrompts: BoardPromptHistoryItem[] = []
  const textNotes: string[] = []

  // Реальные запуски (usage) — по уникальному sourceJobId. Дубликат результата
  // (Alt+drag, «дублировать») несёт ТОТ ЖЕ job id: это один платный запуск и
  // статистика «реал» должна считать его один раз, а не по числу копий.
  const usageCounts = new Map<string, { usages: number; name: string; kind: 'image' | 'video' | 'text' | 'audio' }>()
  const seenSourceJobs = new Set<string>()
  let hasRealUsages = false

  // Линейная дедупликация: Set вместо includes()/some() внутри цикла — на
  // большой доске квадратичный обход (rawPrompts.some / textNotes.includes)
  // превращал каждый вызов extractBoardMemory в O(N²) и задерживал рендер.
  const seenPrompts = new Set<string>()
  const seenNotes = new Set<string>()

  for (const item of items) {
    const kind = item.kind ?? 'image'

    if (kind === 'image') imageCount += 1
    else if (kind === 'video') videoCount += 1
    else if (kind === 'text') textCount += 1

    const modelId = item.modelId || item.sourceLaunch?.modelId
    const modelName = item.sourceLaunch?.modelName || modelId || "Generation"

    if (modelId) {
      const modelKind = (kind === 'video' ? 'video' : 'image') as 'image' | 'video'
      const current = modelCounts.get(modelId) ?? { count: 0, name: modelName, kind: modelKind }
      current.count += 1
      modelCounts.set(modelId, current)

      // Реальные usages — только при достоверном sourceJobId и строго один раз
      // на запуск. Линейная дедупликация через Set (план строка 222: «Не
      // придумывай историю запуска из дубликатов»). Копия результата несёт тот
      // же job id — один запуск, а не «ещё одна генерация» этой моделью.
      if (item.sourceJobId) {
        hasRealUsages = true
        if (!seenSourceJobs.has(item.sourceJobId)) {
          seenSourceJobs.add(item.sourceJobId)
          const usage = usageCounts.get(modelId) ?? { usages: 0, name: modelName, kind: modelKind }
          usage.usages += 1
          usageCounts.set(modelId, usage)
        }
      }
    }

    if (item.prompt && item.prompt.trim()) {
      const p = item.prompt.trim()
      if (!seenPrompts.has(p)) {
        seenPrompts.add(p)
        rawPrompts.push({
          prompt: p,
          modelId,
          modelName,
          kind: kind === 'video' ? 'video' : 'image',
        })
      }
    }

    if (kind === 'text' && item.text && item.text.trim()) {
      const t = item.text.trim()
      if (!seenNotes.has(t)) {
        seenNotes.add(t)
        textNotes.push(t.slice(0, 150))
      }
    }
  }

  const totalGenerations = Array.from(modelCounts.values()).reduce((sum, v) => sum + v.count, 0)

  const modelsUsage: BoardModelUsage[] = Array.from(modelCounts.entries())
    .map(([id, info]) => ({
      modelId: id,
      modelName: info.name,
      count: info.count,
      kind: info.kind,
      percentage: totalGenerations > 0 ? Math.round((info.count / totalGenerations) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  const imageModels = modelsUsage.filter((m) => m.kind === 'image')
  const videoModels = modelsUsage.filter((m) => m.kind === 'video')

  const realUsages: BoardUsageEntry[] = Array.from(usageCounts.entries())
    .map(([id, info]) => ({
      modelId: id,
      modelName: info.name,
      usages: info.usages,
      kind: info.kind,
    }))
    .sort((a, b) => b.usages - a.usages)

  const imageUsages = realUsages.filter((m) => m.kind === 'image')
  const videoUsages = realUsages.filter((m) => m.kind === 'video')

  // Предпочтение модели. Основа счёта:
  // - если на доске есть хоть один достоверный sourceJobId — считаем ПО
  //   РЕАЛЬНЫМ ЗАПУСКАМ (realUsages), legacy-объекты без job id не участвуют;
  // - если доска целиком legacy (ни одного sourceJobId) — остаёмся на
  //   объектной статистике, чтобы старые доски не потеряли автовыбор.
  const preferredImageModel =
    imageUsages.length > 0
      ? pickPreferredUsage(imageUsages)
      : imageModels.length > 0
        ? pickPreferredObjects(imageModels)
        : undefined

  const preferredVideoModel =
    videoUsages.length > 0
      ? pickPreferredUsage(videoUsages)
      : videoModels.length > 0
        ? pickPreferredObjects(videoModels)
        : undefined

  return {
    totalItems: items.length,
    imageCount,
    videoCount,
    textCount,
    preferredImageModel,
    preferredVideoModel,
    modelsUsage,
    realUsages,
    hasRealUsages,
    recentPrompts: rawPrompts.slice(-8),
    textNotes: textNotes.slice(0, 5),
  }
}

function pickPreferredUsage(
  entries: BoardUsageEntry[],
): NonNullable<BoardMemory['preferredImageModel']> {
  const top = entries[0]
  const total = entries.reduce((sum, e) => sum + e.usages, 0)
  return {
    modelId: top.modelId,
    modelName: top.modelName,
    count: top.usages,
    percentage: total > 0 ? Math.round((top.usages / total) * 100) : 0,
    basis: 'usages',
  }
}

function pickPreferredObjects(
  entries: BoardModelUsage[],
): NonNullable<BoardMemory['preferredImageModel']> {
  const top = entries[0]
  return {
    modelId: top.modelId,
    modelName: top.modelName,
    count: top.count,
    percentage: top.percentage,
    basis: 'objects',
  }
}

/**
 * Подбирает наиболее подходящую модель для запуска из помощника, исходя
 * ТОЛЬКО из реального использования на доске (память доски).
 *
 * Раньше здесь был поиск модели по подстроке в тексте запроса («банан на
 * столе» включал nano-banana, «не используй GPT» — GPT Image): случайное
 * слово в тексте переключало модель. Текст запроса больше не участвует в
 * выборе — модель определяет статистика доски, а не фраза в обсуждении.
 */
export function resolveModelForAssistantGeneration(
  items: readonly CanvasItem[],
  models: readonly CatalogModel[],
  effKind: 'image' | 'video',
  // textContext намеренно не используется (см. JSDoc).
  _textContext?: string,
): CatalogModel | undefined {
  // Использование предпочитаемой модели из памяти доски
  const memory = extractBoardMemory(items)
  if (effKind === 'image' && memory.preferredImageModel) {
    const prefId = memory.preferredImageModel.modelId
    const match = models.find((m) => m.id === prefId && m.kind === 'image')
    if (match) return match
  } else if (effKind === 'video' && memory.preferredVideoModel) {
    const prefId = memory.preferredVideoModel.modelId
    const match = models.find((m) => m.id === prefId && m.kind === 'video')
    if (match) return match
  }

  return undefined
}
