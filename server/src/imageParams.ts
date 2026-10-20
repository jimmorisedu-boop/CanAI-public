import type { CatalogModel } from './catalog.js'
import type { IncomingRef } from './refs.js'
import { probeLocalMediaDimensions } from './storage.js'
import { prepareImageParams as prepare } from '../../packages/model-catalog/imageParams.js'
export { findEffectiveCatalogPreset, usesImageParamAdapter } from '../../packages/model-catalog/imageParams.js'

export function prepareImageParams(preset: CatalogModel, input: Record<string, unknown>, refs: IncomingRef[]): Record<string, unknown> {
  return prepare(preset, input, refs.map((ref) => {
    const size = ref.src ? probeLocalMediaDimensions(ref.src) : null
    return size ? { ...ref, width: size.width, height: size.height } : ref
  }))
}
