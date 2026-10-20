import { isLocalServiceUnavailable } from '../api'

export type GalleryFailure =
  | { kind: 'service-unavailable' }
  | { kind: 'load-error'; message: string }
  | null

export function galleryFailureFrom(error: unknown, fallback: string): Exclude<GalleryFailure, null> {
  if (isLocalServiceUnavailable(error)) return { kind: 'service-unavailable' }
  return {
    kind: 'load-error',
    message: error instanceof Error ? error.message : fallback,
  }
}

export function isGalleryServiceUnavailable(
  failure: GalleryFailure,
): failure is { kind: 'service-unavailable' } {
  return failure?.kind === 'service-unavailable'
}
