import type { MediaProvider } from './mediaImportTypes.js'

const HOSTS: Record<Exclude<MediaProvider, 'direct'>, ReadonlySet<string>> = {
  youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']),
  vimeo: new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']),
  tiktok: new Set(['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']),
  instagram: new Set(['instagram.com', 'www.instagram.com']),
}

const LABELS: Record<MediaProvider, string> = {
  direct: 'Link',
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  tiktok: 'TikTok',
  instagram: 'Instagram',
}

export class MediaLinkError extends Error {
  readonly code: string
  /** То, что клиенту нужно ЗНАТЬ, а не читать в тексте: например площадка, на
   *  которую надо войти. Превью при отказе не приходит вовсе, и без этого
   *  карточка не знает даже, чьё имя писать на кнопке. */
  readonly details?: unknown

  constructor(message: string, code = 'MEDIA_LINK_INVALID', details?: unknown) {
    super(message)
    this.name = 'MediaLinkError'
    this.code = code
    this.details = details
  }
}

function providerFor(hostname: string): MediaProvider {
  const host = hostname.toLowerCase()
  if (HOSTS.youtube.has(host)) return 'youtube'
  if (HOSTS.vimeo.has(host)) return 'vimeo'
  if (HOSTS.tiktok.has(host)) return 'tiktok'
  if (HOSTS.instagram.has(host)) return 'instagram'
  return 'direct'
}

export function normalizeMediaLink(raw: string): {
  url: string
  provider: MediaProvider
  sourceLabel: string
} {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new MediaLinkError('Link has an invalid format')
  }
  if (parsed.username || parsed.password) throw new MediaLinkError('Link must not contain a username or password')
  const provider = providerFor(parsed.hostname)
  if (parsed.protocol === 'http:' && provider !== 'direct') parsed.protocol = 'https:'
  if (parsed.protocol !== 'https:') throw new MediaLinkError('Supported only safe HTTPS-links')
  return { url: parsed.toString(), provider, sourceLabel: LABELS[provider] }
}
