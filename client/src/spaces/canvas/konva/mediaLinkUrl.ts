export function standaloneMediaUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? trimmed : null
  } catch {
    return null
  }
}

export function classifyCanvasTextPaste(text: string):
  | { kind: 'link'; url: string }
  | { kind: 'text'; text: string } {
  const url = standaloneMediaUrl(text)
  return url ? { kind: 'link', url } : { kind: 'text', text }
}

export function isSafeCanvasLinkData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const link = value as Record<string, unknown>
  if (typeof link.url !== 'string' || link.url.length > 4_096 || standaloneMediaUrl(link.url) === null) return false
  if (typeof link.normalizedUrl !== 'string' || link.normalizedUrl.length > 4_096 || standaloneMediaUrl(link.normalizedUrl) === null) return false
  if (!['direct', 'youtube', 'vimeo', 'tiktok', 'instagram'].includes(String(link.provider))) return false
  if (!['loading-preview', 'ready', 'error'].includes(String(link.state))) return false
  if (typeof link.sourceLabel !== 'string' || link.sourceLabel.length > 100) return false
  if (typeof link.title !== 'string' || link.title.length > 1_000) return false
  if (link.previewSrc !== undefined && (
    typeof link.previewSrc !== 'string'
    || !/^\/media\/[A-Za-z0-9._-]+(?:\?[^\s]*)?$/.test(link.previewSrc)
  )) return false
  if (!Array.isArray(link.entries) || link.entries.length > 100) return false
  if (link.activeImportId !== undefined && (typeof link.activeImportId !== 'string' || link.activeImportId.length > 128)) return false
  if (link.downloadedItemIds !== undefined) {
    if (!link.downloadedItemIds || typeof link.downloadedItemIds !== 'object' || Array.isArray(link.downloadedItemIds)) return false
    const mappings = Object.entries(link.downloadedItemIds as Record<string, unknown>)
    if (mappings.length > 100 || mappings.some(([entryId, itemId]) => (
      entryId.length === 0 || entryId.length > 128 || typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 128
    ))) return false
  }
  return link.entries.every((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const entry = raw as Record<string, unknown>
    return typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 128
      && (entry.kind === 'image' || entry.kind === 'video')
      && typeof entry.title === 'string' && entry.title.length <= 1_000
      && typeof entry.aspectRatio === 'number' && Number.isFinite(entry.aspectRatio) && entry.aspectRatio > 0
  })
}
