import type { ArchivedItem, CanvasItem } from './types'
import { isSafeCanvasLinkData } from './mediaLinkUrl'
import { formatDuration } from './audioMeta'

// Local edition archive model. Text and link entries remain useful without a
// network board; media entries are accepted only when they point at this
// computer's /media store.
export function toArchived(item: CanvasItem, at: number): ArchivedItem {
  return { ...item, archivedAt: at }
}

export function toCanvasItem(entry: ArchivedItem): CanvasItem {
  const { archivedAt: _archivedAt, ...item } = entry
  void _archivedAt
  return item
}

export function archiveTitle(entry: ArchivedItem): string {
  if (entry.kind === 'link') return entry.link?.title || entry.name || 'link'
  if (entry.kind === 'text') {
    const line = (entry.text ?? '').trim().split('\n')[0]
    return line ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : 'text'
  }
  if (entry.kind === 'audio') return entry.name || 'audio'
  return entry.name || (entry.kind === 'video' ? 'video' : 'image')
}

export function archiveKindLabel(kind: ArchivedItem['kind']): string {
  if (kind === 'video') return 'Video'
  if (kind === 'audio') return 'Audio'
  if (kind === 'text') return 'Text'
  if (kind === 'link') return 'Link'
  return 'Image'
}

export function archiveResolution(entry: ArchivedItem): string | null {
  if (entry.kind === 'audio') {
    return entry.duration && Number.isFinite(entry.duration) ? formatDuration(entry.duration) : null
  }
  if (entry.kind === 'text' || entry.kind === 'link') return null
  const w = entry.naturalWidth
  const h = entry.naturalHeight
  return w && h ? `${Math.round(w)}×${Math.round(h)}` : null
}

export function formatArchiveDate(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Local archives never contain Cloud asset URLs, data URLs, or arbitrary
// external URLs. Text and link records carry no media src and remain allowed.
export function sanitizeArchive(raw: unknown): ArchivedItem[] {
  if (!Array.isArray(raw)) return []
  const out: ArchivedItem[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Partial<ArchivedItem>
    if (typeof entry.id !== 'string' || !entry.id) continue
    if (
      entry.kind !== 'image' && entry.kind !== 'video' && entry.kind !== 'text'
      && entry.kind !== 'link' && entry.kind !== 'audio'
    ) continue
    if (entry.kind === 'link' && (entry.src !== undefined || !isSafeCanvasLinkData(entry.link))) continue
    if (typeof entry.src === 'string' && !entry.src.startsWith('/media/')) continue
    if (entry.kind !== 'text' && entry.kind !== 'link' && typeof entry.src !== 'string') continue
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
    out.push({
      ...(entry as ArchivedItem),
      x: num(entry.x, 0),
      y: num(entry.y, 0),
      w: Math.max(20, num(entry.w, 320)),
      h: Math.max(20, num(entry.h, 320)),
      archivedAt: num(entry.archivedAt, 0),
    })
  }
  return out
}
