import { adoptForBoard } from './konva/boardUploader'
import type { ProjectRef } from '../../types'
import type { CanvasDoc, CanvasItem, PinnedAsset, Placeholder } from './konva/types'
import { isLocalMediaSrc } from './localSnapshotValidation'

const CLOUD_MEDIA_RE = /^\/(?:api\/cloud-assets|v3)\/assets\/[A-Za-z0-9_-]{1,120}(?:\?[^#]*)?$/u

function isCloudMedia(value: unknown): value is string {
  return typeof value === 'string' && CLOUD_MEDIA_RE.test(value)
}

function mediaName(id: string, mime?: string): string {
  const ext = mime?.split('/')[1]?.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  return `canai-restored-${id}${ext ? `.${ext}` : ''}`
}

export interface LocalSnapshotRepairStats {
  repaired: number
}

type Adopt = typeof adoptForBoard

/**
 * Explicitly copy cloud asset bytes into this installation's /media folder.
 * This is intentionally opt-in (called from the recovery action), never part
 * of board bootstrap. A failed fetch/upload rejects the whole clone and the
 * caller keeps its durable JSON recovery untouched.
 */
export async function repairLocalSnapshotFromCloud(
  snapshot: CanvasDoc,
  project: ProjectRef,
  adopter: Adopt = adoptForBoard,
): Promise<{ snapshot: CanvasDoc; stats: LocalSnapshotRepairStats }> {
  if (project.source !== 'local') {
    throw new Error("Cloud file transfer is only available for local whiteboard")
  }
  const next = structuredClone(snapshot)
  const cache = new Map<string, string>()
  let repaired = 0

  const adopt = async (src: string, mime: string | undefined, id: string): Promise<string> => {
    // Cache-buster query strings are presentation-only. Strip them before
    // calling adoptForBoard: its cloud-route guard intentionally matches the
    // canonical asset path, while the resulting local media URL may carry its
    // own cache policy.
    const canonical = src.split('?')[0] ?? src
    const existing = cache.get(canonical)
    if (existing) return existing
    const outcome = await adopter({ url: canonical, mime: mime || 'application/octet-stream' }, mediaName(id, mime), project)
    if (!outcome.url || !isLocalMediaSrc(outcome.url)) {
      throw new Error("Cloud file transfer did not return local media file")
    }
    cache.set(canonical, outcome.url)
    repaired++
    return outcome.url
  }

  const repairItem = async (item: CanvasItem, id: string): Promise<void> => {
    if (isCloudMedia(item.src)) {
      item.src = await adopt(item.src, item.mime, id)
      // assetId is a cloud identity; it must not leak into a local snapshot.
      delete item.assetId
    }
    if (item.crop && isCloudMedia(item.crop.sourceSrc)) {
      item.crop.sourceSrc = await adopt(item.crop.sourceSrc, item.crop.sourceMime ?? item.mime, `${id}-crop`)
      delete item.crop.sourceAssetId
    }
    if (item.link && isCloudMedia(item.link.previewSrc)) {
      item.link.previewSrc = await adopt(item.link.previewSrc, undefined, `${id}-preview`)
    }
  }

  for (const item of next.items) await repairItem(item, item.id)
  if (next.archive) for (const item of next.archive) await repairItem(item, item.id)
  if (next.assets) {
    for (const asset of next.assets as PinnedAsset[]) {
      if (isCloudMedia(asset.src)) {
        asset.src = await adopt(asset.src, asset.mime, `asset-${asset.slot}`)
        delete asset.assetId
      }
    }
  }
  if (next.pending) {
    for (const pending of next.pending as Placeholder[]) {
      const refs = pending.retry?.refs
      if (!refs) continue
      for (const ref of refs) {
        if (ref.kind === 'text') continue
        if (!isCloudMedia(ref.src)) continue
        ref.src = await adopt(ref.src, undefined, `${pending.id}-ref`)
        delete ref.assetId
      }
    }
  }
  return { snapshot: next, stats: { repaired } }
}
