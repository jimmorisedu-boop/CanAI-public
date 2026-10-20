export interface RefChipFallback {
  name: string
  reason: string
  action: string
}

const KIND_WORDS: Record<string, { noun: string; failed: string }> = {
  image: { noun: 'Image', failed: 'failed to load' },
  video: { noun: 'Video', failed: 'failed to load' },
  audio: { noun: 'Audio', failed: 'failed to load' },
}
const UNKNOWN_KIND = { noun: 'File', failed: 'failed to load' }
const GENERIC_LABELS = new Set(['image', 'video', 'audio', 'file', 'картинка', 'изображение', 'видео', 'аудио', 'файл'])

export function refChipFallback(input: { kind: string; label?: string; src?: string }): RefChipFallback {
  const words = KIND_WORDS[input.kind] ?? UNKNOWN_KIND
  const label = (input.label ?? '').trim()
  const generic = GENERIC_LABELS.has(label.toLocaleLowerCase('en-US'))
  const name = (!label || generic ? fileNameFromSrc(input.src) : label) || words.noun
  return { name, reason: `${words.noun} ${words.failed}`, action: 'Click to retry loading' }
}

export function fileNameFromSrc(src: string | undefined): string {
  const path = (src ?? '').split('?')[0].split('#')[0]
  const raw = path.split(/[\/]/).pop() ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function retryRefSrc(src: string, attempt: number): string {
  if (attempt <= 0) return src
  const at = src.indexOf('#')
  const head = at < 0 ? src : src.slice(0, at)
  const hash = at < 0 ? '' : src.slice(at)
  return `${head}${head.includes('?') ? '&' : '?'}canai-retry=${attempt}${hash}`
}
