import type { PublicEditSession } from '../../api'
import type { CanvasStore } from './konva/canvasStore'
import type { ProjectSyncHandle } from './projectSync'
import type { ExternalEditDelivery } from './externalEditRegistry'

const LOCAL_MEDIA = /^\/media\/[A-Za-z0-9._-]+$/

export interface ExternalEditApplyResult {
  placedItemId: string
  outcome: 'created' | 'updated' | 'recreated' | 'source-missing'
}

export function externalEditOutcomeMessage(outcome: ExternalEditApplyResult['outcome']): string {
  if (outcome === 'created') return "External edit added next to source"
  if (outcome === 'updated') return "External edit updated"
  if (outcome === 'recreated') return "Deleted external edit result recreated"
  return "Source deleted — external edit added to the center of the canvas"
}

type ImageProbe = (url: string) => Promise<{ width: number; height: number }>

function browserProbe(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({
      width: image.naturalWidth || 1024,
      height: image.naturalHeight || 768,
    })
    image.onerror = () => reject(new Error("Failed to read external edit"))
    image.src = url
  })
}

function mimeFromPath(url: string): string {
  const extension = url.split('.').pop()?.toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'svg') return 'image/svg+xml'
  return 'image/png'
}

export async function applyExternalEditSession(
  store: CanvasStore,
  session: PublicEditSession,
  probe: ImageProbe = browserProbe,
): Promise<ExternalEditApplyResult> {
  const localPath = session.url.split('?')[0]
  if (!LOCAL_MEDIA.test(localPath)) {
    throw new Error("External edit must reference local media file")
  }
  if (!Number.isFinite(session.lastMtime)) {
    throw new Error("External edit has the wrong file version")
  }
  const url = `${localPath}?v=${session.lastMtime}`
  const tagged = store.getItems().find((item) => item.externalEditSessionId === session.id)
  const acknowledged = session.placedItemId
    ? store.getItem(session.placedItemId)
    : undefined
  const existing = tagged ?? (
    acknowledged?.externalEditSessionId === session.id ? acknowledged : undefined
  )
  // Проект мог успеть сохраниться, а ACK — оборваться рестартом сервера.
  // Тот же tagged URL уже является durable receipt: повторно декодировать и
  // мутировать изображение не нужно, остаётся только повторить ACK.
  if (existing?.src === url) {
    return { placedItemId: existing.id, outcome: 'updated' }
  }

  const dimensions = await probe(url)
  if (!(dimensions.width > 0) || !(dimensions.height > 0)) {
    throw new Error("Outer edit has incorrect image size")
  }
  if (existing) {
    store.updateImageItem(existing.id, { url, ...dimensions })
    return { placedItemId: existing.id, outcome: 'updated' }
  }

  const sourceExists = Boolean(store.getItem(session.sourceItemId))
  const placedItemId = store.placeExternalEditImage(
    session.sourceItemId,
    { url, mime: mimeFromPath(localPath), ...dimensions },
    `edit: ${session.sourceName}`,
    session.id,
  )
  return {
    placedItemId,
    outcome: sourceExists
      ? session.placedItemId ? 'recreated' : 'created'
      : 'source-missing',
  }
}

export async function deliverExternalEditSession(
  store: CanvasStore,
  session: PublicEditSession,
  syncHandle: ProjectSyncHandle,
  probe?: ImageProbe,
): Promise<ExternalEditDelivery> {
  const applied = await applyExternalEditSession(store, session, probe)
  await syncHandle.flushAndWait()
  return {
    placedItemId: applied.placedItemId,
    message: externalEditOutcomeMessage(applied.outcome),
  }
}
