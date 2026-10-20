import type { CanvasDoc } from './konva/types'

/** A media link that cannot be safely persisted in a local board. */
export interface LocalSnapshotMediaIssue {
  path: string
  src: string
}

// Kept for callers that use the old name while opening legacy documents. It
// deliberately recognises only non-local asset-shaped paths and never creates
// or requests one.
const LEGACY_REMOTE_MEDIA_RE = /^\/(?:api\/[^/]+|v3)\/assets\/[A-Za-z0-9_-]{1,120}(?:\?[^#]*)?$/u

export function isCloudMediaSrc(value: unknown): value is string {
  return typeof value === 'string' && LEGACY_REMOTE_MEDIA_RE.test(value)
}

const LOCAL_MEDIA_RE = /^\/media\/[^/\\?#]+(?:\?[^#]*)?$/u

export function isLocalMediaSrc(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  const pathOnly = value.split('?')[0] ?? value
  return LOCAL_MEDIA_RE.test(pathOnly) && !pathOnly.includes('..')
}

function inspectMediaSource(value: unknown, path: string, issues: LocalSnapshotMediaIssue[]): void {
  if (typeof value !== 'string' || isLocalMediaSrc(value)) return
  issues.push({ path, src: value })
}

function inspectItem(value: unknown, path: string, issues: LocalSnapshotMediaIssue[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const item = value as Record<string, unknown>
  const kind = String(item.kind ?? '')
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    inspectMediaSource(item.src, `${path}.src`, issues)
  }
  const crop = item.crop
  if (crop && typeof crop === 'object' && !Array.isArray(crop)) {
    inspectMediaSource((crop as Record<string, unknown>).sourceSrc, `${path}.crop.sourceSrc`, issues)
  }
  if (kind === 'link') {
    const link = item.link
    if (link && typeof link === 'object' && !Array.isArray(link)) {
      inspectMediaSource((link as Record<string, unknown>).previewSrc, `${path}.link.previewSrc`, issues)
    }
  }
}

function inspectRetry(value: unknown, path: string, issues: LocalSnapshotMediaIssue[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const retry = value as Record<string, unknown>
  if (!Array.isArray(retry.refs)) return
  retry.refs.forEach((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return
    const row = ref as Record<string, unknown>
    if (row.kind === 'image' || row.kind === 'video' || row.kind === 'audio') {
      inspectMediaSource(row.src, `${path}.refs[${index}].src`, issues)
    }
  })
}

export function localSnapshotMediaIssues(snapshot: CanvasDoc | unknown): LocalSnapshotMediaIssue[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
  const doc = snapshot as Record<string, unknown>
  const issues: LocalSnapshotMediaIssue[] = []
  const inspectCollection = (name: 'items' | 'archive' | 'assets'): void => {
    const rows = doc[name]
    if (!Array.isArray(rows)) return
    rows.forEach((entry, index) => {
      const path = `${name}[${index}]`
      if (name === 'assets') {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
        const row = entry as Record<string, unknown>
        if (row.kind !== 'text') inspectMediaSource(row.src, `${path}.src`, issues)
        return
      }
      inspectItem(entry, path, issues)
    })
  }
  inspectCollection('items')
  inspectCollection('archive')
  inspectCollection('assets')
  if (Array.isArray(doc.pending)) {
    doc.pending.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
      inspectRetry((entry as Record<string, unknown>).retry, `pending[${index}].retry`, issues)
    })
  }
  return issues.slice(0, 32)
}

export function localSnapshotMediaError(snapshot: CanvasDoc | unknown): Error | null {
  const issues = localSnapshotMediaIssues(snapshot)
  if (issues.length === 0) return null
  const data = issues.some((issue) => issue.src.startsWith('data:'))
  const detail = data
    ? 'The local board contains embedded data instead of media files.'
    : 'The local board contains invalid media links.'
  return new Error(`${detail} Download the JSON; full recovery requires the original files.`)
}

export function missingLocalMediaError(sources: readonly string[]): Error | null {
  const unique = [...new Set(sources.filter((source): source is string => isLocalMediaSrc(source)))]
  if (unique.length === 0) return null
  const shown = unique.slice(0, 3).join(', ')
  const suffix = unique.length > 3 ? `and also ${unique.length - 3}` : ''
  return new Error(`Local board references missing media files: ${shown}${suffix}. Download the JSON, check in the files, and save again.`)
}
