import { CATALOG, resolveCatalogPreset, resolveModel, type CatalogModel, type ModelKind, type ResolvedModel } from './catalog.js'
import type { IncomingRef } from './refs.js'

/**
 * Модель под набор референсов — одна на проверку перед запуском и на сам
 * запуск (runner). Число картинок обязано доехать: от него зависит вариант
 * семьи (у Seedance три картинки и больше — «по референсам», imageCapacity.ts),
 * и проверка, посчитавшая одно, при запуске, посчитавшем другое, пропустила бы
 * запрос, который провайдер отвергнет.
 */
export function resolveForRefs(
  modelId: string | undefined,
  fallbackKind: ModelKind,
  refs: readonly IncomingRef[],
): ResolvedModel {
  const images = refs.filter((ref) => ref.kind === 'image').length
  return resolveModel(
    modelId,
    fallbackKind,
    images > 0,
    refs.some((ref) => ref.kind === 'video'),
    refs.some((ref) => ref.kind === 'audio'),
    images,
  )
}

export function effectiveCatalogPreset(
  modelId: string | undefined,
  fallbackKind: ModelKind,
  refs: IncomingRef[],
): CatalogModel | undefined {
  const resolved = resolveForRefs(modelId, fallbackKind, refs)
  const resolvedModelId = resolved.defaults.model
  return CATALOG.find(
    (model) =>
      model.kind === resolved.kind &&
      model.endpoint === resolved.endpoint &&
      // Imported variants (e.g. Krea berry/jam) keep their default in the
      // parameter spec. Compare the same resolved defaults on both sides.
      (resolvedModelId == null || resolveCatalogPreset(model).defaults.model === resolvedModelId),
  )
}

export function validateModelRefs(
  modelId: string | undefined,
  fallbackKind: ModelKind,
  refs: IncomingRef[],
): string | null {
  // Historical resolveModel retains its old fallback for recovery of paid jobs.
  // New launches must not silently replace an explicitly selected family.
  const selected = CATALOG.find(model => model.id === modelId)
  if (selected && refs.some(ref => ref.kind === 'video' || ref.kind === 'audio')) {
    const family = CATALOG.find(model => model.pairId === selected.id || model.videoPairId === selected.id) ?? selected
    const operation = CATALOG.find(model => model.id === (selected.videoPairId ?? family.videoPairId)) ?? selected
    if (refs.some(ref => ref.kind === 'video') && !operation.videoRefs && !operation.inputModalities?.includes('video')) return `Model “${selected.name}” does not accept video. Select another model.`
    if (refs.some(ref => ref.kind === 'audio') && !operation.audioInputField && !operation.inputModalities?.includes('audio')) return `Model “${selected.name}” does not accept audio. Select another model.`
  }
  const preset = effectiveCatalogPreset(modelId, fallbackKind, refs)
  if (!preset) return refs.length > 16 ? 'References must be 16 or fewer' : null

  const images = refs.filter((ref) => ref.kind === 'image').length
  const videos = refs.filter((ref) => ref.kind === 'video').length
  const audios = refs.filter((ref) => ref.kind === 'audio').length
  const mediaRefs = images + videos + audios
  if (videos < (preset.minVideoRefs ?? 0)) return `Model “${preset.name}” requires a video reference`
  if (images < (preset.minImageRefs ?? 0)) {
    return `Model “${preset.name}” requires an image`
  }
  // Разделение дорожки без самой дорожки бессмысленно: говорим об этом ДО
  // запроса, а не после того, как деньги списаны.
  if (audios < (preset.minAudioRefs ?? 0)) {
    return `Model “${preset.name}” requires an audio reference`
  }
  const supported = new Set(preset.inputModalities ?? [])
  if (images > 0 && supported.size > 0 && !supported.has('image')) {
    return `Model “${preset.name}” does not accept images`
  }
  if (videos > 0 && supported.size > 0 && !supported.has('video')) {
    return `Model “${preset.name}” does not accept video`
  }
  if (audios > 0 && supported.size > 0 && !supported.has('audio')) {
    return `Model “${preset.name}” does not accept audio`
  }
  const mediaKinds = Number(images > 0) + Number(videos > 0) + Number(audios > 0)
  if (preset.mediaInputMode === 'single' && mediaKinds > 1) {
    return `Model “${preset.name}” accepts only one media type per launch`
  }
  const hasDeclaredLimits =
    preset.maxImageRefs != null ||
    preset.maxVideoRefs != null ||
    preset.maxAudioRefs != null ||
    preset.maxTotalRefs != null

  if (!hasDeclaredLimits) {
    return refs.length > 16 ? 'References must be 16 or fewer' : null
  }
  if (images > (preset.maxImageRefs ?? 0)) {
    if ((preset.maxImageRefs ?? 0) === 0) {
      return `Model “${preset.name}” does not accept images`
    }
    return `Model “${preset.name}” accepts no more than ${preset.maxImageRefs} image references`
  }
  if (videos > (preset.maxVideoRefs ?? 0)) {
    if ((preset.maxVideoRefs ?? 0) === 0) {
      return `Model “${preset.name}” does not accept video`
    }
    return `Model “${preset.name}” accepts no more than ${preset.maxVideoRefs} video references`
  }
  if (audios > (preset.maxAudioRefs ?? 0)) {
    if ((preset.maxAudioRefs ?? 0) === 0) {
      return `Model “${preset.name}” does not accept audio`
    }
    return `Model “${preset.name}” accepts no more than ${preset.maxAudioRefs}`
  }
  if (audios > 0 && preset.audioRequiresVisualRef && images + videos === 0) {
    return `Model “${preset.name}” requires at least one image or video with audio`
  }
  if (audios > 0 && preset.audioFormats?.length) {
    const unsupported = refs.some((ref) => {
      if (ref.kind !== 'audio' || !ref.src) return false
      const path = ref.src.split(/[?#]/, 1)[0]
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
      return !preset.audioFormats?.includes(extension)
    })
    if (unsupported) {
      return `Model “${preset.name}” accepts audio only in MP3 and WAV formats`
    }
  }
  if (mediaRefs > (preset.maxTotalRefs ?? 16)) {
    return `Model “${preset.name}” accepts no more than ${preset.maxTotalRefs} references`
  }
  return null
}
