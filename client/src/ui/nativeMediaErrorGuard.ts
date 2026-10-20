const NATIVE_MEDIA_ERROR_ATTRIBUTE = 'data-canai-native-media-error'

type MediaErrorDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'querySelectorAll'>

const installedDocuments = new WeakMap<MediaErrorDocument, () => void>()

function isMediaElement(target: EventTarget | null): target is HTMLMediaElement {
  if (!target || typeof target !== 'object') return false
  if (typeof HTMLMediaElement !== 'undefined' && target instanceof HTMLMediaElement) return true
  const tagName = (target as { tagName?: unknown }).tagName
  return tagName === 'VIDEO' || tagName === 'AUDIO'
}

function hideNativeError(media: HTMLMediaElement, guarded: WeakSet<HTMLMediaElement>): void {
  if (media.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE)) return
  media.setAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE, '')
  guarded.add(media)
}

function restoreNativeError(media: HTMLMediaElement, guarded: WeakSet<HTMLMediaElement>): void {
  if (!guarded.has(media)) return
  media.removeAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE)
  guarded.delete(media)
}

/**
 * Hide browser-owned, localized media error fallback panels at the document
 * boundary. The media element remains mounted with its original source,
 * layout, refs, error state, and event propagation intact; custom CanAI
 * status UI remains responsible for the English explanation.
 *
 * The listener is capture-phase because media `error` does not bubble. A
 * document-level listener also covers media added after startup without a
 * MutationObserver. Calling this more than once for one document is safe.
 */
export function installNativeMediaErrorGuard(doc: MediaErrorDocument = document): () => void {
  const existing = installedDocuments.get(doc)
  if (existing) return existing

  // Failed previews from closed boards must remain collectable.
  const guarded = new WeakSet<HTMLMediaElement>()
  const onError = (event: Event): void => {
    const target = event.target
    if (!isMediaElement(target) || !target.error) return
    const media = target
    hideNativeError(media, guarded)
  }
  const onLoadStart = (event: Event): void => {
    const target = event.target
    if (!isMediaElement(target)) return
    restoreNativeError(target, guarded)
  }

  doc.addEventListener('error', onError, true)
  doc.addEventListener('loadstart', onLoadStart, true)
  for (const media of doc.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (media.error) hideNativeError(media, guarded)
  }

  const cleanup = (): void => {
    doc.removeEventListener('error', onError, true)
    doc.removeEventListener('loadstart', onLoadStart, true)
    for (const media of doc.querySelectorAll<HTMLMediaElement>('video, audio')) {
      restoreNativeError(media, guarded)
    }
    installedDocuments.delete(doc)
  }
  installedDocuments.set(doc, cleanup)
  return cleanup
}

export { NATIVE_MEDIA_ERROR_ATTRIBUTE }
