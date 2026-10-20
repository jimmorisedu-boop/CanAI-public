import type { CatalogModel } from '../../types'
import {
  inspectNodeMediaRefs,
  resolveNodeModel,
} from '../nodes/nodeModel'
import { NAMED_IMAGE_HANDLES } from '../nodes/ports'
import type { CanaiNode, GraphSnapshot } from '../nodes/types'
import { estimateGenerationCost, largestImage, type CostInputs } from './generationEstimate'

// ⚠️ Звук тоже платный. Без 'audio' здесь ноды музыки, озвучки и эффектов
// считались бесплатными и даже не попадали в «цена неизвестна».
const GENERATIVE_KINDS = new Set(['text', 'image', 'video', 'other', 'audio'])

/** Что известно о выделении на доске в момент запуска макроса. */
export interface MacroCostContext {
  /** Самая крупная выделенная картинка: её размер получат ноды, которых питает «Вход». */
  inputImage?: { width: number; height: number }
  /** Сколько знаков выделенного текста придёт через «Вход». */
  selectionTextChars?: number
}

/**
 * Контекст цены из выделения доски. Картинка — самая крупная из выделенных
 * (прогонов бывает несколько, и цену честнее взять по верхней границе), текст —
 * все выделенные тексты так, как их склеит движок: через «\n\n».
 */
export function macroCostContext(
  refs: ReadonlyArray<{ kind: string; w?: number; h?: number; text?: string }>,
): MacroCostContext {
  const inputImage = largestImage(refs)
  const texts = refs
    .filter((ref) => ref.kind === 'text')
    .map((ref) => ref.text?.trim().length ?? 0)
    .filter((length) => length > 0)
  const selectionTextChars = texts.reduce((sum, length) => sum + length, 0) + Math.max(0, texts.length - 1) * 2
  return { ...(inputImage ? { inputImage } : {}), selectionTextChars }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Модель звуковой ноды: у неё нет вариантов «по референсам», только выбранный пресет. */
function audioNodeModel(models: CatalogModel[], modelId: string | undefined): CatalogModel | null {
  return models.find((model) => model.id === modelId && model.kind === 'audio') ?? null
}

const isImageHandle = (handle: string): boolean => (
  handle.startsWith('ref') || handle.startsWith('frame') || NAMED_IMAGE_HANDLES.has(handle)
)

/**
 * Сколько знаков уйдёт модели. Правило склейки — `buildPrompt` движка
 * макросов на сервере: тексты входов, затем свой промпт, через «\n\n».
 * Текст, которого до прогона не узнать (ответ LLM), — undefined.
 */
function promptChars(
  node: CanaiNode,
  graph: GraphSnapshot,
  byId: Map<string, CanaiNode>,
  context: MacroCostContext | undefined,
  legacyRoot: boolean,
): number | undefined {
  const parts: number[] = []
  if (legacyRoot) {
    if (context?.selectionTextChars == null) return undefined
    parts.push(context.selectionTextChars)
  }
  for (const edge of graph.edges) {
    if (edge.target !== node.id || isImageHandle(edge.targetHandle ?? '')) continue
    const source = byId.get(edge.source)
    if (!source) continue
    const kind = source.data.kind
    if (kind === 'note') parts.push(source.data.prompt?.trim().length ?? 0)
    else if (kind === 'input' && edge.sourceHandle === 'text') {
      if (context?.selectionTextChars == null) return undefined
      parts.push(context.selectionTextChars)
    } else if (kind === 'text' || kind === 'combine' || edge.sourceHandle === 'seed') {
      return undefined
    }
  }
  parts.push(node.data.prompt?.trim().length ?? 0)
  const filled = parts.filter((length) => length > 0)
  return filled.reduce((sum, length) => sum + length, 0) + Math.max(0, filled.length - 1) * 2
}

/** Размер входной картинки; хоть один источник неизвестен — undefined. */
function inputImage(
  node: CanaiNode,
  graph: GraphSnapshot,
  byId: Map<string, CanaiNode>,
  context: MacroCostContext | undefined,
  legacyRoot: boolean,
): CostInputs['inputImage'] {
  const sizes: Array<{ width: number; height: number } | undefined> = []
  if (legacyRoot) sizes.push(context?.inputImage)
  for (const edge of graph.edges) {
    if (edge.target !== node.id || !isImageHandle(edge.targetHandle ?? '')) continue
    const source = byId.get(edge.source)
    if (!source) continue
    if (source.data.kind === 'input' && source.data.assetSlot == null) {
      sizes.push(context?.inputImage)
    } else {
      const { width, height } = source.data.result ?? {}
      sizes.push(width && height ? { width, height } : undefined)
    }
  }
  if (!sizes.length || sizes.some((size) => !size)) return undefined
  return (sizes as Array<{ width: number; height: number }>)
    .reduce((largest, size) => (size.width * size.height > largest.width * largest.height ? size : largest))
}

export function estimateMacroCost(
  graph: GraphSnapshot,
  models: CatalogModel[],
  runCount: number,
  context?: MacroCostContext,
): { perRun: number; total: number; unknownCount: number } {
  let perRun = 0
  let unknownCount = 0
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const hasInputNode = graph.nodes.some((node) => node.data.kind === 'input')
  const hasIncoming = new Set(graph.edges.map((edge) => edge.target))

  for (const node of graph.nodes) {
    if (!GENERATIVE_KINDS.has(node.data.kind)) continue
    const refs = inspectNodeMediaRefs(node.id, graph.edges, graph.nodes)
    const model = node.data.kind === 'audio'
      ? audioNodeModel(models, node.data.model)
      : resolveNodeModel(
        models,
        node.data.kind,
        node.data.model,
        refs.hasImage,
        refs.hasVideo,
        refs.hasAudio,
      )
    // Корень легаси-графа без «Входа» получает выделение доски целиком.
    const legacyRoot = !hasInputNode && !hasIncoming.has(node.id)
    const cost = estimateGenerationCost(model, node.data.params ?? {}, 1, refs.imageCount, {
      promptChars: promptChars(node, graph, byId, context, legacyRoot),
      inputImage: inputImage(node, graph, byId, context, legacyRoot),
    })
    if (cost == null) unknownCount++
    else perRun += cost
  }

  const roundedPerRun = roundUsd(perRun)
  return {
    perRun: roundedPerRun,
    total: roundUsd(roundedPerRun * Math.max(1, runCount)),
    unknownCount,
  }
}
