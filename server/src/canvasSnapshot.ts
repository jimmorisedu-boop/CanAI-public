import { MAX_PROMPT_CHARS } from './promptLimits.js'
// Валидация снапшота холста перед записью на диск.
// Инвариант: image/video — только /media/… (без base64 и внешних URL).

const MAX_ITEMS = 20_000
const MAX_TEXT = 50_000
const MAX_PEAKS = 128
const MAX_PENDING = 200
const MAX_ASSETS = 32
const MAX_HANDLED_LAUNCHES = 100
// Имя файла в media. Приложение всегда даёт латинские имена (uuid), но в
// папку попадает и то, что человек положил руками — восстановил из бэкапа,
// вытащил потерянный результат, скопировал фотографию. Список из одной
// латиницы отвергал такую ссылку, а вместе с ней и ВСЮ доску: сохранение
// отвечало «неверные данные», работа переставала записываться (найдено
// прогоном 26.08.2026 на файле «проба-звук.mp3»). Запрещаем ровно то, что
// опасно, — выход из папки и разделители пути; всё остальное имя вправе
// содержать.
const MEDIA_SRC_RE = /^\/media\/[^/\\?#]+$/u

export function isValidMediaSrc(src: string): boolean {
  if (typeof src !== 'string' || src.length > 300) return false
  // query (?v=mtime) для сброса кэша после внешнего редактора
  const pathOnly = src.split('?')[0] ?? src
  if (pathOnly.includes('..') || pathOnly.includes('\\')) return false
  return MEDIA_SRC_RE.test(pathOnly)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function isCanvasLink(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (!isWebUrl(raw.url) || !isWebUrl(raw.normalizedUrl)) return false
  if (!['direct', 'youtube', 'vimeo', 'tiktok', 'instagram'].includes(String(raw.provider))) return false
  if (typeof raw.sourceLabel !== 'string' || raw.sourceLabel.length > 100) return false
  if (typeof raw.title !== 'string' || raw.title.length > 500) return false
  if (!['loading-preview', 'ready', 'error'].includes(String(raw.state))) return false
  if (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length > 1000)) return false
  if (raw.previewSrc !== undefined && (typeof raw.previewSrc !== 'string' || !isValidMediaSrc(raw.previewSrc))) return false
  if (raw.previewKind !== undefined && raw.previewKind !== 'image' && raw.previewKind !== 'video') return false
  if (raw.activeImportId !== undefined && !isSafeId(raw.activeImportId)) return false
  if (!Array.isArray(raw.entries) || raw.entries.length > 100) return false
  for (const valueEntry of raw.entries) {
    if (!valueEntry || typeof valueEntry !== 'object') return false
    const entry = valueEntry as Record<string, unknown>
    if (!isSafeId(entry.id) || (entry.kind !== 'image' && entry.kind !== 'video')) return false
    if (typeof entry.title !== 'string' || entry.title.length > 500) return false
    if (!isFiniteNumber(entry.aspectRatio) || entry.aspectRatio <= 0 || entry.aspectRatio > 100) return false
  }
  if (raw.downloadedItemIds !== undefined) {
    if (!raw.downloadedItemIds || typeof raw.downloadedItemIds !== 'object' || Array.isArray(raw.downloadedItemIds)) return false
    const pairs = Object.entries(raw.downloadedItemIds as Record<string, unknown>)
    if (pairs.length > 100 || pairs.some(([entryId, itemId]) => !isSafeId(entryId) || !isSafeId(itemId))) return false
  }
  return true
}

function isCanvasCrop(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (typeof raw.sourceSrc !== 'string' || !isValidMediaSrc(raw.sourceSrc)) return false
  if (raw.sourceMime !== undefined && (typeof raw.sourceMime !== 'string' || raw.sourceMime.length > 100)) return false
  if (!isFiniteNumber(raw.sourceNaturalWidth) || raw.sourceNaturalWidth <= 0) return false
  if (!isFiniteNumber(raw.sourceNaturalHeight) || raw.sourceNaturalHeight <= 0) return false
  if (!raw.rect || typeof raw.rect !== 'object') return false
  const rect = raw.rect as Record<string, unknown>
  if (![rect.x, rect.y, rect.w, rect.h].every(isFiniteNumber)) return false
  const x = rect.x as number
  const y = rect.y as number
  const w = rect.w as number
  const h = rect.h as number
  const epsilon = 1e-9
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 + epsilon && y + h <= 1 + epsilon
}

function isCanvasItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const raw = item as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length > 100) return false
  const kind = String(raw.kind)
  if (!['image', 'video', 'text', 'link', 'audio'].includes(kind)) return false
  if (![raw.x, raw.y, raw.w, raw.h].every(isFiniteNumber)) return false
  if ((raw.w as number) <= 0 || (raw.h as number) <= 0) return false
  if (raw.rotation !== undefined && !isFiniteNumber(raw.rotation)) return false
  if (raw.fontSize !== undefined && (!isFiniteNumber(raw.fontSize) || (raw.fontSize as number) <= 0)) return false
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 200)) return false
  if (raw.prompt !== undefined && (typeof raw.prompt !== 'string' || raw.prompt.length > MAX_PROMPT_CHARS)) return false
  if (raw.modelId !== undefined && (typeof raw.modelId !== 'string' || raw.modelId.length > 300)) return false
  if (
    raw.externalEditSessionId !== undefined &&
    (typeof raw.externalEditSessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(raw.externalEditSessionId))
  ) return false

  if (kind === 'text') {
    if (raw.crop !== undefined) return false
    if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT)) return false
    // у текста src быть не должно; если есть — только /media/ (на будущее)
    if (raw.src !== undefined && !isValidMediaSrc(raw.src as string)) return false
    return true
  }

  if (kind === 'link') {
    if (raw.src !== undefined || raw.crop !== undefined || raw.text !== undefined) return false
    return isCanvasLink(raw.link)
  }

  if (raw.duration !== undefined && (!isFiniteNumber(raw.duration) || (raw.duration as number) < 0)) return false
  // Волна звука: короткий список маленьких чисел. Длинный массив раздул бы
  // доску, а нечисловой — сломал бы отрисовку плашки.
  if (raw.peaks !== undefined) {
    if (!Array.isArray(raw.peaks) || raw.peaks.length > MAX_PEAKS) return false
    if (!raw.peaks.every((value) => isFiniteNumber(value) && value >= 0 && value <= 100)) return false
  }

  // image | video | audio — обязательная ссылка на локальный media-файл
  if (typeof raw.src !== 'string' || !isValidMediaSrc(raw.src)) return false
  if (raw.mime !== undefined && (typeof raw.mime !== 'string' || raw.mime.length > 100)) return false
  if (raw.crop !== undefined && (kind !== 'image' || !isCanvasCrop(raw.crop))) return false
  return true
}

// Архив — такая же коллекция доски, и инвариант «только /media/…» на неё
// распространяется. Проверка была пропущена: заархивированный объект уходит из
// items (их сторож смотрит) в archive (который не смотрел никто) и так мог
// унести base64 прямо в project.json.
function isArchivedItem(entry: unknown): boolean {
  if (!isCanvasItem(entry)) return false
  const raw = entry as Record<string, unknown>
  return raw.archivedAt === undefined || isFiniteNumber(raw.archivedAt)
}

function isPinnedAsset(asset: unknown): boolean {
  if (!asset || typeof asset !== 'object') return false
  const raw = asset as Record<string, unknown>
  if (!Number.isInteger(raw.slot) || (raw.slot as number) < 0 || (raw.slot as number) > 64) return false
  const kind = String(raw.kind)
  if (!['image', 'video', 'text', 'audio'].includes(kind)) return false
  if (kind === 'text') {
    if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT)) return false
    return true
  }
  if (typeof raw.src !== 'string' || !isValidMediaSrc(raw.src)) return false
  return true
}

function isStoredRetryDescriptor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'image' && raw.kind !== 'video' && raw.kind !== 'audio') return false
  if (typeof raw.prompt !== 'string' || raw.prompt.length > MAX_TEXT) return false
  if (!Array.isArray(raw.refs) || raw.refs.length > 64) return false
  for (const valueRef of raw.refs) {
    if (!valueRef || typeof valueRef !== 'object') return false
    const ref = valueRef as Record<string, unknown>
    if (ref.kind === 'text') {
      if (typeof ref.text !== 'string' || ref.text.length > MAX_TEXT) return false
      continue
    }
    if (ref.kind !== 'image' && ref.kind !== 'video' && ref.kind !== 'audio') return false
    if (typeof ref.src !== 'string' || !isValidMediaSrc(ref.src)) return false
  }
  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length > 300)) return false
  if (raw.params !== undefined && (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params))) {
    return false
  }
  return true
}

function isPlaceholder(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const raw = item as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length > 100) return false
  if (!['image', 'video', 'audio'].includes(String(raw.kind))) return false
  if (![raw.x, raw.y, raw.w, raw.h].every(isFiniteNumber)) return false
  if ((raw.w as number) <= 0 || (raw.h as number) <= 0) return false
  if (raw.jobId !== undefined && (typeof raw.jobId !== 'string' || raw.jobId.length > 100)) return false
  if (raw.status !== undefined && raw.status !== 'loading' && raw.status !== 'error') return false
  if (raw.usedReferences !== undefined && typeof raw.usedReferences !== 'boolean') return false
  if (raw.retry !== undefined && !isStoredRetryDescriptor(raw.retry)) return false
  if (raw.taskType !== undefined && raw.taskType !== 'generation' && raw.taskType !== 'media-import') return false
  if (raw.taskType === 'media-import') {
    if (!isSafeId(raw.jobId) || !isSafeId(raw.importEntryId) || !isSafeId(raw.sourceLinkId)) return false
    if (raw.downloadedBytes !== undefined && (!isFiniteNumber(raw.downloadedBytes) || raw.downloadedBytes < 0)) return false
    if (raw.totalBytes !== undefined && (!isFiniteNumber(raw.totalBytes) || raw.totalBytes < 0)) return false
    if (raw.percent !== undefined && (!isFiniteNumber(raw.percent) || raw.percent < 0 || raw.percent > 100)) return false
    if (raw.stage !== undefined && (typeof raw.stage !== 'string' || raw.stage.length > 200)) return false
  }
  return true
}

function isHandledLaunchIds(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_HANDLED_LAUNCHES) return false
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 100 || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

export function isCanvasSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as {
    version?: unknown
    items?: unknown
    camera?: unknown
    assets?: unknown
    archive?: unknown
    pending?: unknown
    handledGenerationLaunchIds?: unknown
  }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS) return false

  const camera = snapshot.camera as { x?: unknown; y?: unknown; scale?: unknown } | null
  if (!camera || ![camera.x, camera.y, camera.scale].every(isFiniteNumber)) return false
  if ((camera.scale as number) <= 0 || (camera.scale as number) > 100) return false

  if (!snapshot.items.every(isCanvasItem)) return false

  if (snapshot.assets !== undefined) {
    if (!Array.isArray(snapshot.assets) || snapshot.assets.length > MAX_ASSETS) return false
    if (!snapshot.assets.every(isPinnedAsset)) return false
  }

  if (snapshot.archive !== undefined) {
    if (!Array.isArray(snapshot.archive) || snapshot.archive.length > MAX_ITEMS) return false
    if (!snapshot.archive.every(isArchivedItem)) return false
  }

  if (snapshot.pending !== undefined) {
    if (!Array.isArray(snapshot.pending) || snapshot.pending.length > MAX_PENDING) return false
    if (!snapshot.pending.every(isPlaceholder)) return false
  }

  if (
    snapshot.handledGenerationLaunchIds !== undefined &&
    !isHandledLaunchIds(snapshot.handledGenerationLaunchIds)
  ) return false

  return true
}
