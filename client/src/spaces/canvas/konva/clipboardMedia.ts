const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.tiff']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.opus', '.flac', '.oga']

export type MediaKind = 'image' | 'video' | 'audio'

export function mediaKind(file: Pick<File, 'type' | 'name'>): MediaKind | null {
  const type = (file.type || '').toLowerCase()
  const name = (file.name || '').toLowerCase()
  // Тип сильнее расширения, и порядок тут не косметика: .ogg бывает и видео, и
  // звуком, а по одному расширению звук уехал бы в видео-ветку и встал бы на
  // холст чёрным прямоугольником вместо плашки.
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('image/')) return 'image'
  if (VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'video'
  if (AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'audio'
  if (IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'image'
  return null
}
interface ClipboardItemLike {
  kind: string
  type?: string
  getAsFile(): File | null
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike>
  files?: ArrayLike<File>
}

function clipboardExtension(type: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
  }
  return extensions[type] ?? type.split('/')[1]?.split(/[;+]/)[0] ?? 'bin'
}

function normalizeClipboardFile(file: File, itemType?: string): File {
  const type = (file.type || itemType || '').toLowerCase()
  const kind = mediaKind({ type, name: file.name })
  if (!kind || (file.type && file.name)) return file
  const name = file.name || `clipboard.${clipboardExtension(type)}`
  return new File([file], name, {
    type,
    lastModified: file.lastModified,
  })
}

export function mediaFilesFromClipboard(data: ClipboardDataLike | null | undefined): File[] {
  if (!data) return []
  const fromItems: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    if (
      mediaKind(file)
      || item.type?.startsWith('image/')
      || item.type?.startsWith('video/')
      || item.type?.startsWith('audio/')
    ) {
      fromItems.push(normalizeClipboardFile(file, item.type))
    }
  }
  if (fromItems.length > 0) return fromItems
  return Array.from(data.files ?? []).filter((file) => mediaKind(file) !== null)
}
