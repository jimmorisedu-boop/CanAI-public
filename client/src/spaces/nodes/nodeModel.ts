import type { Edge, Node } from '@xyflow/react'
import { baseModels, effectiveModel } from '../canvas/genOptions'
import { executorCompatibilityError } from '../../../../packages/model-catalog/version'
import type { CatalogDefaults, CatalogModel, JobKind } from '../../types'
import { NAMED_IMAGE_HANDLES } from './ports'
import type { GenNodeData, NodeKind } from './types'

// Резолв модели на ноде — как на канвасе: в data.model хранится БАЗА,
// effective — pairId/videoPairId по подключённым медиа.

export function kindUsesBasePicker(kind: NodeKind): boolean {
  return kind === 'image' || kind === 'video'
}

/**
 * Список для дропдауна: image/video — только базовые; иначе все пресеты kind.
 * В отличие от канваса (курированный короткий список), ноды — рабочее
 * пространство для гибкой сборки workflow, поэтому includeHidden=true:
 * модели вроде Ideogram видны здесь, даже если скрыты из бара на канвасе.
 */
export function pickerModels(models: CatalogModel[], kind: NodeKind): CatalogModel[] {
  if (kindUsesBasePicker(kind)) return baseModels(models, kind as JobKind, true)
  return models.filter((m) => m.kind === kind && (!m.lifecycle || m.lifecycle === 'active'))
}

export function defaultNodeModelId(
  models: CatalogModel[],
  kind: NodeKind,
  defaults?: CatalogDefaults,
): string | null {
  const presets = pickerModels(models, kind).filter(model => !executorCompatibilityError(model))
  const slot = kind === 'text'
    ? 'assistant'
    : kind === 'image' || kind === 'video' || kind === 'audio'
      ? kind
      : null
  const preferred = slot ? defaults?.[slot] : null
  if (preferred && presets.some(model => model.id === preferred)) return preferred
  return presets[0]?.id ?? null
}

/** Если в графе лежит ref-вариант — вернуть id базовой (для миграции UI). */
export function toBaseModelId(
  models: CatalogModel[],
  modelId: string | undefined,
  kind: JobKind,
): string | undefined {
  if (!modelId) return undefined
  const m = models.find((x) => x.id === modelId)
  if (!m) return modelId
  if (!m.refs) return m.id
  const base = models.find(
    (x) => x.kind === kind && (x.pairId === m.id || x.videoPairId === m.id),
  )
  return base?.id ?? m.id
}

export function inspectNodeMediaRefs(
  nodeId: string,
  edges: Edge[],
  nodes: Node[],
): { hasImage: boolean; hasVideo: boolean; hasAudio: boolean; imageCount: number } {
  let hasImage = false
  let hasVideo = false
  let hasAudio = false
  let imageCount = 0

  for (const e of edges) {
    if (e.target !== nodeId) continue
    const handle = e.targetHandle ?? ''
    if (
      !handle.startsWith('ref') &&
      !handle.startsWith('frame') &&
      !handle.startsWith('video') &&
      !handle.startsWith('audio') &&
      !NAMED_IMAGE_HANDLES.has(handle)
    ) {
      continue
    }

    const src = nodes.find((n) => n.id === e.source)
    if (!src) continue
    const data = src.data as GenNodeData
    const kind = data.kind
    const sh = e.sourceHandle ?? ''
    const mime = data.result?.mime ?? ''

    if (kind === 'video') {
      hasVideo = true
      continue
    }
    if (kind === 'image' || kind === 'other') {
      hasImage = true
      imageCount++
      continue
    }
    if (kind === 'media') {
      if (sh === 'video' || mime.startsWith('video/')) hasVideo = true
      else if (sh === 'audio' || mime.startsWith('audio/')) hasAudio = true
      else if (sh === 'image' || data.result?.url) {
        hasImage = true
        imageCount++
      }
      continue
    }
    if (kind === 'input') {
      if (sh === 'video') hasVideo = true
      else if (sh === 'audio') hasAudio = true
      else if (sh === 'images' || sh === 'text') {
        if (sh === 'images') {
          hasImage = true
          imageCount++
        }
      } else {
        // неизвестный выход входа — не угадываем
      }
      continue
    }
    // text/note → в media-порт обычно не идут
  }

  return { hasImage, hasVideo, hasAudio, imageCount }
}

export function resolveNodeModel(
  models: CatalogModel[],
  kind: NodeKind,
  modelId: string | undefined,
  hasImage: boolean,
  hasVideo: boolean,
  hasAudio = false,
): CatalogModel | null {
  if (kind !== 'image' && kind !== 'video' && kind !== 'text' && kind !== 'other') return null
  const baseId = toBaseModelId(models, modelId, kind) ?? modelId ?? null
  return effectiveModel(models, kind, baseId, hasImage, hasVideo, hasAudio)
}

/** База умеет videoPair — первый кадр может принять и видео, и картинку. */
export function baseAcceptsVideoPair(
  models: CatalogModel[],
  kind: NodeKind,
  modelId: string | undefined,
): boolean {
  if (kind !== 'video') return false
  const baseId = toBaseModelId(models, modelId, 'video')
  const base = models.find((m) => m.id === baseId)
  return Boolean(base?.videoPairId || base?.videoRefs)
}

export function baseAcceptsAudioPair(
  models: CatalogModel[],
  kind: NodeKind,
  modelId: string | undefined,
): boolean {
  if (kind !== 'video') return false
  const baseId = toBaseModelId(models, modelId, 'video')
  const base = models.find((model) => model.id === baseId)
  const audioModel = base?.videoPairId
    ? models.find((model) => model.id === base.videoPairId)
    : base
  return (audioModel?.maxAudioRefs ?? 0) > 0
}

function ownReferenceCapacity(model: CatalogModel | undefined): number {
  if (!model) return 0
  if (model.maxTotalRefs != null) return model.maxTotalRefs
  return Math.max(
    model.maxImageRefs ?? 0,
    model.maxVideoRefs ?? 0,
    model.maxAudioRefs ?? 0,
  )
}

export function referenceCapacity(
  models: CatalogModel[],
  kind: NodeKind,
  modelId?: string,
): number {
  if (kind === 'text' || kind === 'combine') return 10
  if (kind !== 'image' && kind !== 'video') return 0

  const selected = models.find((model) => model.id === modelId)
  if (!selected) return 1
  if (selected.refs) return Math.max(1, ownReferenceCapacity(selected))

  const paired = [selected.pairId, selected.videoPairId]
    .filter((id): id is string => Boolean(id))
    .map((id) => models.find((model) => model.id === id))
  return Math.max(1, ...paired.map(ownReferenceCapacity))
}

export type ReferenceCounts = {
  image: number
  video: number
  audio: number
}

export function referenceLimitError(
  models: CatalogModel[],
  kind: NodeKind,
  modelId: string | undefined,
  counts: ReferenceCounts,
): string | null {
  const model = resolveNodeModel(
    models,
    kind,
    modelId,
    counts.image > 0,
    counts.video > 0,
    counts.audio > 0,
  )
  if (!model) return null

  const mediaKinds = Number(counts.image > 0) + Number(counts.video > 0) + Number(counts.audio > 0)
  if (model.mediaInputMode === 'single' && mediaKinds > 1) {
    // говорим и что не так, и что делать: иначе пользователь видит запрет и
    // не понимает, что мешает именно УЖЕ подключённый другой тип
    return `“${model.name}” accepts only one media type at a time — disconnect the extra link`
  }

  const hasLimits =
    model.maxImageRefs != null ||
    model.maxVideoRefs != null ||
    model.maxAudioRefs != null ||
    model.maxTotalRefs != null
  if (!hasLimits) return null

  const limits = [
    ['image', 'images', 'images', counts.image, model.maxImageRefs ?? 0],
    ['video', 'video', 'video', counts.video, model.maxVideoRefs ?? 0],
    ['audio', 'audio', 'audio files', counts.audio, model.maxAudioRefs ?? 0],
  ] as const
  for (const [, singular, plural, count, limit] of limits) {
    if (count <= limit) continue
    return limit === 0
      ? `Model “${model.name}” ${singular} does not accept`
      : `Model “${model.name}” accepts ${plural} no more than ${limit}`
  }
  if (
    counts.audio > 0 &&
    model.audioRequiresVisualRef &&
    counts.image + counts.video === 0
  ) {
    return `Model “${model.name}” requires at least one image or video together with audio`
  }

  const total = counts.image + counts.video + counts.audio
  if (model.maxTotalRefs != null && total > model.maxTotalRefs) {
    return `Model “${model.name}” accepts no more than ${model.maxTotalRefs}`
  }
  return null
}
