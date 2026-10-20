import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import dns from 'node:dns'
import type { LookupAddress } from 'node:dns'
import dnsPromises from 'node:dns/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { extForMime } from './mediaTypes.js'
import { mediaPathIn } from './mediaLayout.js'
import { config } from './config.js'
import { proxyForUrl, type ProxyEnv } from './proxyConfig.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_MAX_REDIRECTS = 5
const MAX_PREVIEW_RANGE_BYTES = 8 * 1024 * 1024
const SAFE_BASE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/

export class UploadTooLargeError extends Error {}

export interface SafeRemoteDeps {
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>
  fetch(url: string | URL, init?: RequestInit & { redirect?: RequestRedirect }): Promise<Response>
}

export interface SafeRemoteInit {
  method?: 'GET' | 'HEAD'
  headers?: {
    Referer?: string
    'User-Agent'?: string
    Range?: string
  }
  signal?: AbortSignal
  timeoutMs?: number
  maxRedirects?: number
}

export interface SafeRemoteResponse {
  response: Response
  finalUrl: URL
}

export interface DownloadRemoteMediaInput {
  url: string
  mediaDir: string
  baseName: string
  maxBytes: number
  headers?: SafeRemoteInit['headers']
  signal?: AbortSignal
  onProgress?: (received: number, total: number | undefined) => void
  deps?: SafeRemoteDeps
}

function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase()
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0
      || a === 10
      || a === 100 && b >= 64 && b <= 127 // CGNAT 100.64/10 (Tailscale и корпоративные сети)
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224
  }
  if (isIP(address) === 6) {
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice('::ffff:'.length))
    return lower === '::'
      || lower === '::1'
      || lower.startsWith('fc')
      || lower.startsWith('fd')
      || /^fe[89ab]/.test(lower)
      || lower.startsWith('ff')
      || lower.startsWith('2002:') // 6to4 может нести приватный IPv4 внутри адреса
      || lower.startsWith('100::') // discard-only
  }
  return true
}

// Проверка адреса на самом соединении: undici/net резолвят имя СВОИМ lookup,
// и между предпроверкой в assertSafeRemoteUrl и фактическим connect публичное
// имя может отдать внутренний адрес (DNS rebinding). Этот lookup встаёт в
// connect-опции агента, поэтому фильтр применяется к каждому реальному
// соединению, а не к «проверили и забыли».
function checkedLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family: number,
  ) => void,
): void {
  dns.lookup(hostname, { ...(options as dns.LookupAllOptions), all: true }, (err, addresses) => {
    if (err) {
      callback(err, '' as never, -1 as never)
      return
    }
    const list = addresses as LookupAddress[]
    if (list.length === 0 || list.some(({ address }) => isPrivateAddress(address))) {
      const unsafe = new Error(`External URL points to an internal network (${hostname})`) as NodeJS.ErrnoException
      unsafe.code = 'EACCES'
      callback(unsafe, '' as never, -1 as never)
      return
    }
    if ((options as dns.LookupAllOptions).all) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list)
    } else {
      (callback as unknown as (error: null, address: string, family: number) => void)(null, list[0].address, list[0].family)
    }
  })
}

// Длинный connect нужен для CDN fal из РФ/VPN. Редиректы при этом всегда
// обрабатываются вручную, чтобы проверить DNS каждого нового адреса.
const remoteAgent = new Agent({
  connectTimeout: 60_000,
  headersTimeout: 120_000,
  bodyTimeout: 300_000,
  connect: { lookup: checkedLookup as never },
})

/**
 * Через какой прокси идти к внешнему адресу; null — напрямую.
 *
 * ⚠️ Внешние файлы обязаны ходить ТОЙ ЖЕ дорогой, что и всё приложение
 * (жалоба 27.09.2026 со снимком: семь карточек YouTube-ссылок с «CanAI
 * временно недоступен»). Этот модуль держал свой транспорт — ради проверки
 * адреса на самом соединении — и ходил напрямую всегда, хотя `fetch`, сокет
 * доски и yt-dlp давно шли через прокси. Картинка-превью YouTube напрямую
 * висела на рукопожатии 21,7 с и обрывалась, через прокси приходила за 1,1 с;
 * каждое превью ссылки из-за этого шло 30 с, и семь разом упирались в предел
 * ожидания браузера. Та же беда давно била по скачиванию оплаченных
 * результатов с CDN fal («DPI режет по имени домена» — лечили повторами).
 *
 * ⚠️ Только https и только `HTTPS_PROXY`: эту переменную ведёт и проверяет
 * замером само приложение (`cloudRoute`). http-переменная приходит из системы
 * как есть и у прокси-клиентов нередко указывает на SOCKS-порт — туннель через
 * неё оборвался бы там, где прямой путь для http-ссылки работал.
 *
 * ⚠️ Через прокси имя цели разрешает уже прокси, и проверка на самом
 * соединении (`checkedLookup`) там не действует. Остаётся проверка перед
 * КАЖДЫМ шагом, включая переадресации (`assertSafeRemoteUrl`): внутренний
 * адрес и имя, которое у нас разрешается во внутреннюю сеть, отвергаются, как
 * и раньше. Открытой остаётся лишь подмена DNS между нашей проверкой и ответом
 * прокси — плата за то, что без прокси внешние файлы у человека за VPN не
 * открываются вовсе.
 */
export function remoteProxyFor(url: URL, env: ProxyEnv = process.env): string | null {
  if (url.protocol !== 'https:') return null
  return proxyForUrl(url.toString(), env)
}

const proxyAgents = new Map<string, ProxyAgent>()

function remoteDispatcher(url: URL): Dispatcher {
  const proxy = remoteProxyFor(url)
  if (!proxy) return remoteAgent
  let agent = proxyAgents.get(proxy)
  if (!agent) {
    agent = new ProxyAgent({ uri: proxy, headersTimeout: 120_000, bodyTimeout: 300_000 })
    proxyAgents.set(proxy, agent)
  }
  return agent
}

const defaultDeps: SafeRemoteDeps = {
  lookup: (hostname) => dnsPromises.lookup(hostname, { all: true }),
  fetch: (url, init) => undiciFetch(url, {
    ...(init as object),
    dispatcher: remoteDispatcher(new URL(String(url))),
  }) as unknown as Promise<Response>,
}

function cleanHeader(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (value.includes('\r') || value.includes('\n')) throw new Error(`invalid header ${name}`)
  return value
}

function publicHeaders(headers: SafeRemoteInit['headers']): Headers {
  const result = new Headers()
  const referer = cleanHeader(headers?.Referer, 'Referer')
  const userAgent = cleanHeader(headers?.['User-Agent'], 'User-Agent')
  const range = cleanHeader(headers?.Range, 'Range')
  if (referer) result.set('Referer', referer)
  if (userAgent) result.set('User-Agent', userAgent)
  if (range) result.set('Range', range)
  return result
}

/**
 * Свой сервер CanAI — исключение из защиты от внутренних адресов.
 *
 * Защита существует, чтобы чужая ссылка (от модели, из чужого ответа) не увела
 * нас во внутреннюю сеть. Адрес сервера CanAI приходит не оттуда: его ввёл сам
 * человек при входе в команду. Без исключения путь
 * «через сервер» не работает вовсе, когда сервер стоит рядом — в той же сети
 * или на этой машине (поймано первым же сквозным прогоном: генерация прошла и
 * была оплачена, а результат забрать не удалось).
 *
 * Сравниваем ORIGIN целиком, а не начало строки: «http://сервер.ru» не должен
 * открывать дорогу «http://сервер.ru.чужой-домен».
 */
// Адрес сервера команды живёт в защищённом хранилище и читается асинхронно,
// а проверка адреса зовётся на каждую загрузку. Поэтому держим его здесь и
// обновляем, когда вход в команду состоялся или отменён.
let ownCloudOrigin: string | null = null

export function setOwnCloudOrigin(serverUrl: string | null): void {
  if (!serverUrl) { ownCloudOrigin = null; return }
  try { ownCloudOrigin = new URL(serverUrl).origin } catch { ownCloudOrigin = null }
}

function isOwnCloudOrigin(url: URL): boolean {
  return ownCloudOrigin !== null && ownCloudOrigin === url.origin
}

async function assertSafeRemoteUrl(url: URL, deps: SafeRemoteDeps): Promise<void> {
  // Свой сервер разрешён целиком: и http (он бывает в локальной сети), и
  // приватный адрес. Всё остальное проходит проверку как прежде.
  if (isOwnCloudOrigin(url)) return
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe external URL')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('unsafe external URL')
  const addresses = await deps.lookup(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('External URL points to an internal network')
  }
}

function timeoutSignal(input: SafeRemoteInit): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const abortFromInput = () => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) abortFromInput()
  else input.signal?.addEventListener('abort', abortFromInput, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('External request timed out')), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timer.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abortFromInput)
    },
  }
}

export async function openSafeRemote(
  url: string | URL,
  init: SafeRemoteInit = {},
  deps: SafeRemoteDeps = defaultDeps,
): Promise<SafeRemoteResponse> {
  const timed = timeoutSignal(init)
  try {
    let current = new URL(url)
    const headers = publicHeaders(init.headers)
    const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      await assertSafeRemoteUrl(current, deps)
      const response = await deps.fetch(current, {
        method: init.method ?? 'GET',
        headers,
        redirect: 'manual',
        signal: timed.signal,
      })
      if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current }
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw new Error('External redirect URL is empty')
      if (redirects === maxRedirects) break
      current = new URL(location, current)
    }
    throw new Error('Too many external redirects')
  } finally {
    timed.dispose()
  }
}

function responseMime(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export async function downloadRemoteMedia(input: DownloadRemoteMediaInput): Promise<{
  url: string
  mime: string
  bytes: number
}> {
  if (!SAFE_BASE_NAME.test(input.baseName)) throw new Error('Invalid external file name')
  const { response } = await openSafeRemote(input.url, {
    headers: input.headers,
    signal: input.signal,
  }, input.deps)
  if (!response.ok) throw new Error(`could not download external file (HTTP ${response.status})`)
  if (!response.body) throw new Error('The external server returned an empty file')
  const mime = responseMime(response)
  // ⚠️ Звук здесь ОБЯЗАН быть наравне с картинкой и видео. Через эту функцию
  // идут ВСЕ результаты генерации (runner → saveFromUrl → downloadRemoteMedia),
  // и пока в списке были только image/ и video/, любая звуковая генерация
  // умирала уже ПОСЛЕ оплаты: fal делал работу, деньги списывались, а файл
  // отвергался с «неподдерживаемый тип audio/wav» (проверено на Lyria и на
  // разделении дорожки, 20.08.2026). Добавляешь новый тип объекта на холст —
  // проверь, что его mime проходит здесь.
  if (!mime.startsWith('image/') && !mime.startsWith('video/') && !mime.startsWith('audio/')) {
    throw new Error(`external URL returned unsupported type ${mime || 'without Content-Type'}`)
  }
  const total = contentLength(response)
  if (total !== undefined && total > input.maxBytes) throw new UploadTooLargeError('file too large')

  const ext = extForMime(mime)
  if (ext === 'bin') throw new Error(`unsupported external file type ${mime}`)
  const fileName = `${input.baseName}.${ext}`
  // Папку внутри media выбирает раскладка (mediaLayout): в ссылке остаётся
  // только имя, поэтому чтение найдёт файл и без пути.
  const finalPath = mediaPathIn(input.mediaDir, fileName)
  const tmpPath = `${finalPath}.tmp`
  await fs.mkdir(path.dirname(finalPath), { recursive: true })

  let received = 0
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > input.maxBytes) {
        callback(new UploadTooLargeError('file too large'))
        return
      }
      input.onProgress?.(received, total)
      callback(null, chunk)
    },
  })

  try {
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    await pipeline(body, progress, createWriteStream(tmpPath), { signal: input.signal })
    if (received === 0) throw new Error('The external server returned an empty file')
    await fs.rename(tmpPath, finalPath)
    return { url: `/media/${fileName}`, mime, bytes: received }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {})
    throw error
  }
}

function cappedRange(value: string): string {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) throw new Error('Invalid Range header')
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : start + MAX_PREVIEW_RANGE_BYTES - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    throw new Error('Invalid Range header')
  }
  return `bytes=${start}-${Math.min(requestedEnd, start + MAX_PREVIEW_RANGE_BYTES - 1)}`
}

export async function proxyRemoteRange(
  url: string,
  range: string | undefined,
  deps: SafeRemoteDeps = defaultDeps,
): Promise<SafeRemoteResponse> {
  const result = await openSafeRemote(url, { headers: { Range: cappedRange(range ?? 'bytes=0-') } }, deps)
  if (result.response.status !== 200 && result.response.status !== 206) {
    throw new Error(`could not get preview video (HTTP ${result.response.status})`)
  }
  const mime = responseMime(result.response)
  if (!mime.startsWith('video/')) throw new Error('The external URL did not return a video')
  return result
}
