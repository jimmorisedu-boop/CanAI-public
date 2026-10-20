import fs from 'node:fs/promises'
import { mediaFilePathAsync } from './storage.js'

const MEDIA_SRC_RE = /^\/media\/[^/\\?#]+$/u

function localMediaSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  const pathOnly = value.split('?')[0] ?? value
  return MEDIA_SRC_RE.test(pathOnly) && !pathOnly.includes('..')
}

function collectSources(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
  const doc = snapshot as Record<string, unknown>
  const out = new Set<string>()
  const add = (value: unknown): void => {
    if (localMediaSource(value)) out.add(value)
  }
  const inspectItem = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const kind = String(item.kind ?? '')
    if (kind === 'image' || kind === 'video' || kind === 'audio') add(item.src)
    if (item.crop && typeof item.crop === 'object' && !Array.isArray(item.crop)) {
      add((item.crop as Record<string, unknown>).sourceSrc)
    }
    if (kind === 'link' && item.link && typeof item.link === 'object' && !Array.isArray(item.link)) {
      add((item.link as Record<string, unknown>).previewSrc)
    }
  }
  for (const name of ['items', 'archive'] as const) {
    if (Array.isArray(doc[name])) for (const row of doc[name] as unknown[]) inspectItem(row)
  }
  if (Array.isArray(doc.assets)) {
    for (const raw of doc.assets as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      if (row.kind !== 'text') add(row.src)
    }
  }
  if (Array.isArray(doc.pending)) {
    for (const raw of doc.pending as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const retry = (raw as Record<string, unknown>).retry
      if (!retry || typeof retry !== 'object' || Array.isArray(retry)) continue
      const refs = (retry as Record<string, unknown>).refs
      if (!Array.isArray(refs)) continue
      for (const ref of refs as unknown[]) {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue
        const row = ref as Record<string, unknown>
        if (row.kind === 'image' || row.kind === 'video' || row.kind === 'audio') add(row.src)
      }
    }
  }
  return [...out]
}

/**
 * Return local media links whose bytes are absent from this installation.
 * Structural validation still lives in canvasSnapshot.ts; this check is the
 * second, filesystem-aware boundary used by the local save route.
 */
export async function missingCanvasMedia(snapshot: unknown, limit = 32): Promise<string[]> {
  const missing: string[] = []
  for (const src of collectSources(snapshot)) {
    const file = await mediaFilePathAsync(src).catch(() => null)
    if (!file) continue
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) missing.push(src)
    } catch {
      missing.push(src)
    }
    if (missing.length >= limit) break
  }
  return missing
}

export { collectSources as collectCanvasMediaSources }
