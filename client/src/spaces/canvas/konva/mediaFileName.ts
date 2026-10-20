import type { CanvasItem } from './types'

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-m4v': 'm4v', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/webm': 'weba', 'audio/flac': 'flac',
}

const MEDIA_EXTENSIONS = [
  'jpeg', 'jpg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tiff', 'tif',
  'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'weba',
  'm4a', 'aac', 'flac',
]
const MEDIA_EXTENSION_PATTERN = MEDIA_EXTENSIONS.join('|')
const EXTENSION_BEFORE_SKETCH = new RegExp(
  `\\.(?:${MEDIA_EXTENSION_PATTERN})(?=\\s*\\+\\s*(?:скетч|sketch))`, 'giu',
)
const TRAILING_MEDIA_EXTENSION = new RegExp(`\\.(?:${MEDIA_EXTENSION_PATTERN})$`, 'iu')
const REPEATED_SKETCH_SUFFIX = /(?:\s*\+\s*(?:скетч|sketch)){2,}$/iu

function safeBaseName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || fallback
}

export function canvasItemExtension(item: CanvasItem, downloadedMime?: string): string {
  if (item.kind === 'text') return 'txt'
  const last = (item.src?.split('?')[0] ?? '').split('/').pop() ?? ''
  const match = /\.([a-z0-9]{2,5})$/i.exec(last)
  if (match) return match[1].toLowerCase()
  const mime = (item.mime || downloadedMime || '').split(';')[0].trim().toLowerCase()
  return EXT_BY_MIME[mime] || (item.kind === 'video' ? 'mp4' : 'bin')
}

export function canvasItemFileBase(item: CanvasItem, fallback: string): string {
  if (item.kind === 'text') return safeBaseName((item.text || fallback).slice(0, 40), fallback)
  const raw = item.name || fallback
  const withoutEmbeddedExtensions = safeBaseName(raw, fallback).replace(EXTENSION_BEFORE_SKETCH, '')
  const withoutTrailingExtension = withoutEmbeddedExtensions.replace(TRAILING_MEDIA_EXTENSION, '')
  return safeBaseName(withoutTrailingExtension.replace(REPEATED_SKETCH_SUFFIX, ' + sketch'), fallback)
}

export function canvasItemFileName(item: CanvasItem, fallback = 'canai', downloadedMime?: string): string {
  return `${canvasItemFileBase(item, fallback)}.${canvasItemExtension(item, downloadedMime)}`
}

export function sketchResultName(sourceName: string | null | undefined): string {
  const item: CanvasItem = {
    id: 'sketch-name', kind: 'image', x: 0, y: 0, w: 1, h: 1,
    name: sourceName || 'sketch', src: '/media/sketch.png',
  }
  const base = canvasItemFileBase(item, 'sketch')
  const withSketch = /(?:^|\s*\+\s*)sketch$/iu.test(base)
    ? base
    : /(?:^|\s*\+\s*)скетч$/iu.test(base)
      ? base.replace(/скетч$/iu, 'sketch')
      : `${base} + sketch`
  return `${withSketch}.png`
}
