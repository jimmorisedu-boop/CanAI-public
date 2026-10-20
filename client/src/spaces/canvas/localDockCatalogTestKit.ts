import { CATALOG } from '../../../../packages/model-catalog/catalog'
import type { CatalogDefaults, CatalogModel } from '../../types'
import type { DockLaunchState } from './actionDockLaunch'
import type { SelectionRef } from './konva/selection'

/**
 * Local-only fixtures shared by the dock and assistant tests.
 *
 * The development fixture also carried a second, team-server catalogue.  The
 * local export has one source of truth: the models installed for this board.
 * Keeping this helper local means the exported tests still cover real model
 * selection, reference conversion, and pricing without importing a Cloud
 * catalogue or transport contract.
 */
export const LOCAL_DOCK_MODELS: CatalogModel[] = CATALOG.map((model) => ({
  contractRevision: model.contractRevision,
  adapterVersion: model.adapterVersion,
  minExecutorVersion: model.minExecutorVersion,
  lifecycle: model.lifecycle,
  pricingNote: model.pricingNote,
  id: model.id,
  name: model.name,
  kind: model.kind,
  refs: Boolean(model.refs),
  pairId: model.pairId,
  videoRefs: Boolean(model.videoRefs),
  videoPairId: model.videoPairId,
  refTagStyle: model.refTagStyle ?? null,
  canvasHidden: Boolean(model.canvasHidden),
  params: model.params ?? [],
  pricing: model.pricing,
  textPricing: model.textPricing,
  contextWindowTokens: model.contextWindowTokens,
  inputModalities: model.inputModalities,
  mediaInputMode: model.mediaInputMode,
  maxImageRefs: model.maxImageRefs,
  minImageRefs: model.minImageRefs,
  minAudioRefs: model.minAudioRefs,
  minVideoRefs: model.minVideoRefs,
  maxVideoRefs: model.maxVideoRefs,
  maxAudioRefs: model.maxAudioRefs,
  maxTotalRefs: model.maxTotalRefs,
  audioRequiresVisualRef: model.audioRequiresVisualRef,
  audioFormats: model.audioFormats,
  promptRequired: model.promptInputField !== null,
  englishPromptOnly: model.englishPromptOnly,
  seedOutput: Boolean(model.seedOutput),
})) as unknown as CatalogModel[]

/** Factory defaults exposed by the local model registry. */
export const LOCAL_DOCK_DEFAULTS: CatalogDefaults = {
  image: 'chatgpt-image-2',
  video: 'seedance-2',
  audio: 'sam-audio-separate',
  assistant: 'gemini',
}

export const imageRef = (id: string, extra: Partial<SelectionRef> = {}): SelectionRef => ({
  shapeId: id,
  kind: 'image',
  label: id,
  src: `/media/${id}.png`,
  w: 1024,
  h: 1536,
  ...extra,
})

export const videoRef = (id: string): SelectionRef => ({
  shapeId: id,
  kind: 'video',
  label: id,
  src: `/media/${id}.mp4`,
  w: 1280,
  h: 720,
})

export const audioRef = (id: string): SelectionRef => ({
  shapeId: id,
  kind: 'audio',
  label: id,
  src: `/media/${id}.mp3`,
})

export const textRef = (id: string, text: string): SelectionRef => ({
  shapeId: id,
  kind: 'text',
  label: text,
  text,
})

/** State for the local board's action dock. */
export function dockState(over: Partial<DockLaunchState> = {}): DockLaunchState {
  return {
    projectRef: { source: 'local', id: 'board' },
    kind: 'image',
    models: LOCAL_DOCK_MODELS,
    defaults: LOCAL_DOCK_DEFAULTS,
    modelId: null,
    batchMode: 'each',
    refs: [],
    prompt: 'make a poster',
    count: 1,
    params: {},
    sketchTarget: null,
    itemById: () => undefined,
    ...over,
  }
}
