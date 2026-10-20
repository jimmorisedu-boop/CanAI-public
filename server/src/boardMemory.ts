import { CATALOG, type CatalogModel } from './catalog.js'
import { loadProjectSnapshot } from './projects.js'

export interface BoardModelUsage {
  modelId: string
  modelName: string
  count: number
  kind: 'image' | 'video' | 'text' | 'audio'
  percentage: number
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
  audioCount: number

  preferredImageModel?: {
    modelId: string
    modelName: string
    count: number
    percentage: number
  }

  preferredVideoModel?: {
    modelId: string
    modelName: string
    count: number
    percentage: number
  }

  modelsUsage: BoardModelUsage[]
  aspectRatios: Array<{ ratio: string; count: number }>
  recentPrompts: BoardPromptHistoryItem[]
  textNotes: string[]
}

function resolveModelName(modelId?: string, fallbackName?: string): string {
  if (fallbackName && fallbackName.trim()) return fallbackName.trim()
  if (!modelId) return 'Unknown model'
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  if (inCatalog) return inCatalog.name
  // Без догадок по подстроке (gpt/banana/flux/kling): id вне каталога показываем как есть.
  return modelId
}

function resolveModelKind(modelId?: string, itemKind?: string): 'image' | 'video' | 'text' | 'audio' {
  if (itemKind === 'video') return 'video'
  if (itemKind === 'audio') return 'audio'
  if (itemKind === 'text') return 'text'
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  if (inCatalog && inCatalog.kind !== 'other') return inCatalog.kind
  return 'image'
}

export function extractBoardMemory(items: unknown[]): BoardMemory {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      totalItems: 0,
      imageCount: 0,
      videoCount: 0,
      textCount: 0,
      audioCount: 0,
      modelsUsage: [],
      aspectRatios: [],
      recentPrompts: [],
      textNotes: [],
    }
  }

  let imageCount = 0
  let videoCount = 0
  let textCount = 0
  let audioCount = 0

  const modelCounts = new Map<string, { count: number; name: string; kind: 'image' | 'video' | 'text' | 'audio' }>()
  const aspectCounts = new Map<string, number>()
  const rawPrompts: BoardPromptHistoryItem[] = []
  const textNotes: string[] = []
  // Дедупликация через Set — линейная вместо квадратичного some/includes
  const seenPrompts = new Set<string>()
  const seenNotes = new Set<string>()

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const kind = String(item.kind ?? 'image')

    if (kind === 'image') imageCount += 1
    else if (kind === 'video') videoCount += 1
    else if (kind === 'text') textCount += 1
    else if (kind === 'audio') audioCount += 1

    const modelId = typeof item.modelId === 'string' && item.modelId.trim()
      ? item.modelId.trim()
      : (item.sourceLaunch && typeof (item.sourceLaunch as Record<string, unknown>).modelId === 'string')
        ? String((item.sourceLaunch as Record<string, unknown>).modelId).trim()
        : undefined

    const modelName = item.sourceLaunch && typeof (item.sourceLaunch as Record<string, unknown>).modelName === 'string'
      ? String((item.sourceLaunch as Record<string, unknown>).modelName).trim()
      : resolveModelName(modelId)

    if (modelId) {
      const modelKind = resolveModelKind(modelId, kind)
      const current = modelCounts.get(modelId) ?? { count: 0, name: modelName, kind: modelKind }
      current.count += 1
      modelCounts.set(modelId, current)
    }

    if (typeof item.prompt === 'string' && item.prompt.trim()) {
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

    if (kind === 'text' && typeof item.text === 'string' && item.text.trim()) {
      const t = item.text.trim()
      if (!seenNotes.has(t)) {
        seenNotes.add(t)
        textNotes.push(t.slice(0, 150))
      }
    }

    const w = typeof item.w === 'number' ? item.w : 0
    const h = typeof item.h === 'number' ? item.h : 0
    if (w > 0 && h > 0) {
      const ratioVal = w / h
      let ratioLabel = '1:1'
      if (Math.abs(ratioVal - 1) < 0.08) ratioLabel = '1:1'
      else if (Math.abs(ratioVal - 3 / 4) < 0.08) ratioLabel = '3:4 (portrait)'
      else if (Math.abs(ratioVal - 4 / 3) < 0.08) ratioLabel = '4:3 (landscape)'
      else if (Math.abs(ratioVal - 9 / 16) < 0.08) ratioLabel = '9:16 (vertical video/story)'
      else if (Math.abs(ratioVal - 16 / 9) < 0.08) ratioLabel = '16:9 (widescreen)'
      else if (ratioVal < 0.9) ratioLabel = 'portrait'
      else if (ratioVal > 1.1) ratioLabel = 'landscape'

      aspectCounts.set(ratioLabel, (aspectCounts.get(ratioLabel) ?? 0) + 1)
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

  const preferredImageModel = imageModels.length > 0
    ? {
        modelId: imageModels[0].modelId,
        modelName: imageModels[0].modelName,
        count: imageModels[0].count,
        percentage: imageModels[0].percentage,
      }
    : undefined

  const preferredVideoModel = videoModels.length > 0
    ? {
        modelId: videoModels[0].modelId,
        modelName: videoModels[0].modelName,
        count: videoModels[0].count,
        percentage: videoModels[0].percentage,
      }
    : undefined

  const aspectRatios = Array.from(aspectCounts.entries())
    .map(([ratio, count]) => ({ ratio, count }))
    .sort((a, b) => b.count - a.count)

  const recentPrompts = rawPrompts.slice(-8)

  return {
    totalItems: items.length,
    imageCount,
    videoCount,
    textCount,
    audioCount,
    preferredImageModel,
    preferredVideoModel,
    modelsUsage,
    aspectRatios,
    recentPrompts,
    textNotes: textNotes.slice(0, 5),
  }
}

export function formatBoardMemoryForContext(memory: BoardMemory): string {
  if (memory.totalItems === 0) {
    return 'The canvas is empty. There are no previous generations on this board.'
  }

  const lines: string[] = []
  lines.push(`Board objects: ${memory.totalItems} (images: ${memory.imageCount}, ; videos: ${memory.videoCount},; notes/text: ${memory.textCount}).`)

  if (memory.preferredImageModel) {
    lines.push(`User’s main image model: ${memory.preferredImageModel.modelName} (used ${memory.preferredImageModel.count} times, ${memory.preferredImageModel.percentage}% of generations).`)
    
    // Специальные рекомендации по промптингу для известных семейств моделей
    const idLower = memory.preferredImageModel.modelId.toLowerCase()
    if (idLower.includes('gpt') || memory.preferredImageModel.modelName.includes('GPT')) {
      lines.push('MODEL DETAILS (GPT Image): write prompts in rich natural language, describing the scene, lighting, textures, and mood. Do not use Midjourney tags (--ar, --v), comma-separated keyword lists, or negative prompts.')
    } else if (idLower.includes('flux')) {
      lines.push('MODEL DETAILS (Flux): concise, precise composition descriptions with clear transfer details and lighting; avoid unnecessary fluff.')
    }
  }

  if (memory.preferredVideoModel) {
    lines.push(`Main video model: ${memory.preferredVideoModel.modelName} (used ${memory.preferredVideoModel.count} times).`)
  }

  if (memory.aspectRatios.length > 0) {
    const topAspect = memory.aspectRatios[0]
    lines.push(`Most common frame format: ${topAspect.ratio} (${topAspect.count} items).`)
  }

  if (memory.recentPrompts.length > 0) {
    lines.push('Recent canvas topics and prompts (keep the style consistent):')
    for (let i = 0; i < memory.recentPrompts.length; i++) {
      const p = memory.recentPrompts[i]
      const modelTag = p.modelName ? ` [model: ${p.modelName}]` : ''
      lines.push(`  ${i + 1}. "${p.prompt.slice(0, 140)}"${modelTag}`)
    }
  }

  if (memory.textNotes.length > 0) {
    lines.push('Board notes and concepts:')
    for (const note of memory.textNotes) {
      lines.push(`  - "${note}"`)
    }
  }

  return lines.join('\n')
}

export async function loadBoardMemoryForProject(projectId: string): Promise<BoardMemory | null> {
  try {
    const loaded = await loadProjectSnapshot(projectId)
    if (!loaded || !loaded.snapshot || typeof loaded.snapshot !== 'object') return null
    const snapshotObj = loaded.snapshot as { items?: unknown[] }
    return extractBoardMemory(snapshotObj.items ?? [])
  } catch {
    return null
  }
}
