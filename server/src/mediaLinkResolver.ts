import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { config } from './config.js'
import type { MediaLinkEntry, MediaLinkPreview, MediaProvider } from './mediaImportTypes.js'
import { MediaLinkError, normalizeMediaLink } from './mediaLinkUrl.js'
import { PortableMediaTools, type LocatePortableToolOptions, type PortableMediaTool } from './portableMediaTools.js'
import { openSafeRemote, type SafeRemoteInit, type SafeRemoteResponse } from './safeRemote.js'
import { saveBuffer } from './storage.js'
import { extractProviderPreview } from './extractorPreview.js'
import { needsExtractorLogin } from './extractorLogin.js'
import { argsCarryCookies, currentCookieArgs } from './extractorCookies.js'
import { jsRuntimeArgs } from './ytRuntime.js'
import { terminateProcessTree } from './terminateProcessTree.js'

const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_TOOL_STDOUT = 16 * 1024 * 1024
const TOOL_TIMEOUT_MS = 90_000
/**
 * Картинка-превью — украшение: без неё карточка ссылки всё равно рабочая, а за
 * ней есть запасной путь (yt-dlp сам скачивает миниатюру). Ждать её дольше
 * нескольких секунд нельзя — замер 27.09.2026: заблокированный адрес
 * миниатюры висел на рукопожатии 21,7 с, и каждое превью YouTube шло по 30 с.
 */
const THUMBNAIL_TIMEOUT_MS = 10_000
const UPDATE_SIGNATURE = /unsupported url|no suitable extractor|extractor.+(?:broken|failed)|site.+changed/i

export type MediaEntryDownload =
  | {
    type: 'remote'
    url: string
    headers?: { Referer?: string; 'User-Agent'?: string }
  }
  | {
    type: 'yt-dlp'
    url: string
    playlistIndex?: number
  }

export interface ResolvedMediaEntry extends MediaLinkEntry {
  download: MediaEntryDownload
}

export interface ResolvedMediaLink {
  public: MediaLinkPreview
  entries: ResolvedMediaEntry[]
}

export interface ToolRunResult {
  stdout: string
  stderr: string
}

export interface ResolverDeps {
  tools?: {
    locate(tool: PortableMediaTool, options?: LocatePortableToolOptions): Promise<string>
  }
  runTool?: (executable: string, args: string[]) => Promise<ToolRunResult>
  openRemote?: (url: string | URL, init?: SafeRemoteInit) => Promise<SafeRemoteResponse>
  makeThumbnail?: (buffer: Buffer) => Promise<Buffer>
  savePreview?: (buffer: Buffer, baseName: string) => Promise<string>
  extractorPreview?: (
    provider: 'youtube' | 'vimeo' | 'instagram' | 'tiktok',
    url: string,
    entryId: string,
  ) => Promise<string | undefined>
  /** Вход на площадку, если человек его задал (extractorCookies.ts). */
  cookieArgs?: () => Promise<string[]>
}

const defaultTools = new PortableMediaTools({ toolsDir: config.mediaToolsDir })

function stableEntryId(provider: MediaProvider, providerId: string, index: number): string {
  return createHash('sha256').update(`${provider}:${providerId}:${index}`).digest('hex').slice(0, 16)
}

type ExtractorFailure = 'unreadable' | 'update' | 'login' | 'stale-login'

function publicError(provider: MediaProvider, reason: ExtractorFailure = 'unreadable'): Error {
  const label = provider === 'youtube'
    ? 'YouTube'
    : provider === 'vimeo'
      ? 'Vimeo'
      : provider === 'instagram'
        ? 'Instagram'
        : provider === 'tiktok' ? 'TikTok' : 'link'
  if (reason === 'update') return new Error(`Could not read ${label}: extractor must be updated`)
  // Ссылка и публикация тут ни при чём — см. extractorLogin.ts. Код важнее
  // текста: по нему карточка показывает кнопку «Войти», а не разбирает фразу
  // (на разборе формулировок мы уже обжигались с кодами ответов публикации).
  // ⚠️ Площадка едет ОТДЕЛЬНЫМ полем: превью при отказе не приходит вовсе, и
  // карточка иначе остаётся с заглушкой «Ссылка» — кнопка называлась бы «Войти
  // на Ссылка», а на сервер уходил бы provider «direct», которому входа нет.
  if (reason === 'login') {
    return new MediaLinkError(
      `${label} serves video only after you sign in`,
      'MEDIA_LINK_LOGIN_REQUIRED',
      { provider, sourceLabel: label },
    )
  }
  // Вход задан, но площадка его не приняла: cookies истекают, и человек должен
  // знать, что обновлять надо их, а не искать беду в ссылке.
  if (reason === 'stale-login') {
    return new MediaLinkError(
      `Saved sign-in in ${label} is no longer valid`,
      'MEDIA_LINK_LOGIN_STALE',
      { provider, sourceLabel: label },
    )
  }
  return new Error(`Could not read ${label}. Check the link and publication availability`)
}

function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function mime(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
}

function titleFromUrl(raw: string): string {
  const pathname = new URL(raw).pathname
  const last = pathname.split('/').filter(Boolean).at(-1)
  if (!last) return 'Media by link'
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function ratio(width: unknown, height: unknown, fallback = 1): number {
  const w = Number(width)
  const h = Number(height)
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : fallback
}

async function readResponseBuffer(response: Response, maxBytes = MAX_IMAGE_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('The linked image is too large')
  if (!response.body) throw new Error('The server returned an empty image')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > maxBytes) throw new Error('The linked image is too large')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (received === 0) throw new Error('The server returned an empty image')
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received)
}

async function defaultThumbnail(buffer: Buffer): Promise<Buffer> {
  return await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer()
}

async function defaultSavePreview(buffer: Buffer, baseName: string): Promise<string> {
  return (await saveBuffer(buffer, 'image/webp', baseName)).url
}

function runProcess(executable: string, args: string[]): Promise<ToolRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopping = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        Object.assign(error, { stderr })
        reject(error)
      } else resolve({ stdout, stderr })
    }
    const stop = (error: Error) => {
      if (settled || stopping) return
      stopping = true
      void terminateProcessTree(child).then(() => finish(error), (cause: Error) => finish(cause))
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_TOOL_STDOUT) {
        stop(new Error('The extractor returned too much data'))
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_TOOL_STDOUT) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (!stopping) finish(code === 0 ? undefined : new Error(`extractor exited with code ${code ?? 'unknown'}`))
    })
    const timer = setTimeout(() => {
      stop(new Error('The extractor did not respond in time'))
    }, TOOL_TIMEOUT_MS)
    timer.unref()
  })
}

function toolErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  return `${error instanceof Error ? error.message : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
}

async function runExtractor(
  tool: PortableMediaTool,
  args: string[],
  provider: MediaProvider,
  deps: Required<Pick<ResolverDeps, 'tools' | 'runTool' | 'cookieArgs'>>,
): Promise<ToolRunResult> {
  // Вход подмешивается ЗДЕСЬ, одной точкой на все вызовы: разбросанный по
  // местам, он неизбежно где-нибудь бы потерялся, а ссылка нужна последней.
  const cookies = await deps.cookieArgs().catch(() => [])
  const full = cookies.length ? [...cookies, ...args] : args
  const withCookies = argsCarryCookies(full)
  let executable: string
  try {
    executable = await deps.tools.locate(tool)
  } catch {
    throw publicError(provider)
  }
  try {
    return await deps.runTool(executable, full)
  } catch (firstError) {
    const firstText = toolErrorText(firstError)
    // Вход в аккаунт обновлением инструмента не лечится — не гоняем закачку зря.
    if (needsExtractorLogin(firstText)) throw publicError(provider, withCookies ? 'stale-login' : 'login')
    if (!UPDATE_SIGNATURE.test(firstText)) throw publicError(provider)
    let refreshed: string
    try {
      refreshed = await deps.tools.locate(tool, { forceRefresh: true })
    } catch {
      throw publicError(provider, 'update')
    }
    try {
      return await deps.runTool(refreshed, full)
    } catch (secondError) {
      if (needsExtractorLogin(toolErrorText(secondError))) {
        throw publicError(provider, withCookies ? 'stale-login' : 'login')
      }
      throw publicError(provider, 'update')
    }
  }
}

async function localPreview(
  remoteUrl: string,
  entryId: string,
  deps: Required<Pick<ResolverDeps, 'openRemote' | 'makeThumbnail' | 'savePreview'>>,
): Promise<string> {
  const { response } = await deps.openRemote(remoteUrl, { timeoutMs: THUMBNAIL_TIMEOUT_MS })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (!mime(response).startsWith('image/')) throw new Error('The preview is not an image')
  const buffer = await readResponseBuffer(response)
  const thumbnail = await deps.makeThumbnail(buffer)
  return await deps.savePreview(thumbnail, `link-preview-${entryId}`)
}

async function resolveDirect(
  normalizedUrl: string,
  sourceLabel: string,
  deps: Required<Pick<ResolverDeps, 'openRemote' | 'makeThumbnail' | 'savePreview'>>,
): Promise<ResolvedMediaLink> {
  let opened = await deps.openRemote(normalizedUrl, { method: 'HEAD' })
  if (!opened.response.ok || !mime(opened.response)) opened = await deps.openRemote(normalizedUrl)
  if (!opened.response.ok) throw new Error(`Could not open link (HTTP ${opened.response.status})`)
  const contentType = mime(opened.response)
  const title = titleFromUrl(normalizedUrl)
  const kind = contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : null
  if (!kind) {
    await opened.response.body?.cancel().catch(() => {})
    throw new Error('The link must point directly to an image or video')
  }
  const id = stableEntryId('direct', normalizedUrl, 0)
  let aspectRatio = kind === 'video' ? 16 / 9 : 1
  let previewSrc: string | undefined
  if (kind === 'image') {
    let response = opened.response
    if (!response.body) response = (await deps.openRemote(normalizedUrl)).response
    const buffer = await readResponseBuffer(response)
    const metadata = await sharp(buffer, { failOn: 'error' }).rotate().metadata()
    aspectRatio = ratio(metadata.width, metadata.height)
    const thumbnail = await deps.makeThumbnail(buffer)
    previewSrc = await deps.savePreview(thumbnail, `link-preview-${id}`)
  } else {
    await opened.response.body?.cancel().catch(() => {})
  }
  const entry: ResolvedMediaEntry = {
    id, kind, title, aspectRatio,
    download: { type: 'remote', url: normalizedUrl },
  }
  return {
    public: {
      normalizedUrl,
      provider: 'direct',
      sourceLabel,
      title,
      previewSrc,
      previewKind: kind === 'image' ? 'image' : 'video',
      entries: [{ id, kind, title, aspectRatio }],
    },
    entries: [entry],
  }
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v'])

function galleryObject(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const object = raw.find((value) => value && typeof value === 'object' && !Array.isArray(value))
    return object as Record<string, unknown> | undefined ?? null
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

function extensionOf(item: Record<string, unknown>, url: string): string {
  const explicit = item.extension ?? item.ext
  if (typeof explicit === 'string') return explicit.toLowerCase().replace(/^\./, '')
  return new URL(url).pathname.split('.').at(-1)?.toLowerCase() ?? ''
}

function safeDownloadHeaders(raw: unknown): { Referer?: string; 'User-Agent'?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const headers: { Referer?: string; 'User-Agent'?: string } = {}
  if (typeof source.Referer === 'string' && !/[\r\n]/.test(source.Referer)) headers.Referer = source.Referer
  if (typeof source['User-Agent'] === 'string' && !/[\r\n]/.test(source['User-Agent'])) headers['User-Agent'] = source['User-Agent']
  return Object.keys(headers).length > 0 ? headers : undefined
}

function parseGallery(stdout: string, provider: 'instagram' | 'tiktok'): ResolvedMediaEntry[] {
  const entries: ResolvedMediaEntry[] = []
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const item = galleryObject(parsed)
    if (!item) continue
    const role = String(item.role ?? item.type ?? item.category ?? '').toLowerCase()
    if (/cover|thumb|audio|subtitle/.test(role)) continue
    const url = safeHttpsUrl(item.url ?? item.file_url ?? item.download_url)
    if (!url) continue
    const extension = extensionOf(item, url)
    const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : null
    if (!kind) continue
    const index = entries.length
    const providerId = String(item.id ?? item.post_id ?? item.filename ?? url)
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `${provider === 'instagram' ? 'Instagram' : 'TikTok'} ${index + 1}`
    const headers = safeDownloadHeaders(item._http_headers ?? item.http_headers)
    entries.push({
      id: stableEntryId(provider, providerId, index),
      kind,
      title,
      aspectRatio: ratio(item.width, item.height, kind === 'video' ? 16 / 9 : 1),
      download: { type: 'remote', url, ...(headers ? { headers } : {}) },
    })
  }
  return entries
}

function parseYt(stdout: string, provider: 'youtube' | 'vimeo' | 'instagram' | 'tiktok', sourceUrl: string, index = 0): {
  entry: ResolvedMediaEntry
  thumbnail?: string
  title: string
} {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw publicError(provider)
  }
  const providerId = String(data.id ?? sourceUrl)
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim()
    : provider === 'youtube' ? 'YouTube video' : provider === 'vimeo' ? 'Vimeo video' : 'Video'
  const id = stableEntryId(provider, providerId, index)
  let thumbnail = safeHttpsUrl(data.thumbnail)
  if (!thumbnail && Array.isArray(data.thumbnails)) {
    for (const candidate of [...data.thumbnails].reverse()) {
      if (candidate && typeof candidate === 'object') {
        thumbnail = safeHttpsUrl((candidate as Record<string, unknown>).url)
        if (thumbnail) break
      }
    }
  }
  return {
    title,
    thumbnail: thumbnail ?? undefined,
    entry: {
      id,
      kind: 'video',
      title,
      aspectRatio: ratio(data.width, data.height, 16 / 9),
      download: { type: 'yt-dlp', url: sourceUrl },
    },
  }
}

const YT_ARGS = [
  '--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist',
  ...jsRuntimeArgs(),
]
const GALLERY_ARGS = [
  '--config-ignore', '--no-input', '--simulate', '--dump-json',
  '--option', 'output.jsonl=true',
  '--option', 'extractor.instagram.include=posts,reels',
  '--option', 'extractor.tiktok.photos=true',
  '--option', 'extractor.tiktok.videos=true',
]

async function resolveYtDlp(
  normalizedUrl: string,
  sourceLabel: string,
  provider: 'youtube' | 'vimeo',
  deps: Required<Pick<ResolverDeps, 'tools' | 'runTool' | 'openRemote' | 'makeThumbnail' | 'savePreview' | 'extractorPreview' | 'cookieArgs'>>,
): Promise<ResolvedMediaLink> {
  const output = await runExtractor('yt-dlp', [...YT_ARGS, normalizedUrl], provider, deps)
  const parsed = parseYt(output.stdout, provider, normalizedUrl)
  const remotePreview = parsed.thumbnail
    ? await localPreview(parsed.thumbnail, parsed.entry.id, deps).catch(() => undefined)
    : undefined
  const previewSrc = remotePreview ?? await deps.extractorPreview(
    provider, normalizedUrl, parsed.entry.id,
  ).catch(() => undefined)
  const { download: _download, ...publicEntry } = parsed.entry
  return {
    public: {
      normalizedUrl,
      provider,
      sourceLabel,
      title: parsed.title,
      previewSrc,
      previewKind: previewSrc ? 'image' : undefined,
      entries: [publicEntry],
    },
    entries: [parsed.entry],
  }
}

async function resolveGallery(
  normalizedUrl: string,
  provider: 'instagram' | 'tiktok',
  sourceLabel: string,
  deps: Required<Pick<ResolverDeps, 'tools' | 'runTool' | 'openRemote' | 'makeThumbnail' | 'savePreview' | 'extractorPreview' | 'cookieArgs'>>,
): Promise<ResolvedMediaLink> {
  const output = await runExtractor('gallery-dl', [...GALLERY_ARGS, normalizedUrl], provider, deps)
  const entries = parseGallery(output.stdout, provider)
  if (!entries.some((entry) => entry.kind === 'video')) {
    try {
      const ytOutput = await runExtractor('yt-dlp', [...YT_ARGS, normalizedUrl], provider, deps)
      const fallback = parseYt(ytOutput.stdout, provider, normalizedUrl, entries.length).entry
      if (!entries.some((entry) => entry.id === fallback.id)) entries.push(fallback)
    } catch {
      // Фото и карусель остаются полноценным результатом, даже если видео-fallback
      // для этой конкретной публикации недоступен.
    }
  }
  if (entries.length === 0) throw publicError(provider)
  const first = entries[0]
  const previewRemote = first.kind === 'image' && first.download.type === 'remote' ? first.download.url : undefined
  const remotePreview = previewRemote
    ? await localPreview(previewRemote, first.id, deps).catch(() => undefined)
    : undefined
  const previewSrc = remotePreview ?? await deps.extractorPreview(
    provider, normalizedUrl, first.id,
  ).catch(() => undefined)
  const title = first.title
  return {
    public: {
      normalizedUrl,
      provider,
      sourceLabel,
      title,
      previewSrc,
      previewKind: previewSrc ? 'image' : undefined,
      entries: entries.map(({ download: _download, ...entry }) => entry),
    },
    entries,
  }
}

export async function resolveMediaLink(rawUrl: string, input: ResolverDeps = {}): Promise<ResolvedMediaLink> {
  const normalized = normalizeMediaLink(rawUrl)
  const deps = {
    tools: input.tools ?? defaultTools,
    runTool: input.runTool ?? runProcess,
    openRemote: input.openRemote ?? openSafeRemote,
    makeThumbnail: input.makeThumbnail ?? defaultThumbnail,
    savePreview: input.savePreview ?? defaultSavePreview,
    cookieArgs: input.cookieArgs ?? currentCookieArgs,
    extractorPreview: input.extractorPreview ?? ((provider, url, entryId) => (
      extractProviderPreview({ provider, url, entryId })
    )),
  }
  if (normalized.provider === 'direct') return await resolveDirect(normalized.url, normalized.sourceLabel, deps)
  if (normalized.provider === 'youtube' || normalized.provider === 'vimeo') {
    return await resolveYtDlp(normalized.url, normalized.sourceLabel, normalized.provider, deps)
  }
  return await resolveGallery(normalized.url, normalized.provider, normalized.sourceLabel, deps)
}
