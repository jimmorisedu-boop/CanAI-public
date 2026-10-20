import { deviceName } from '../spaces/canvas/continuity/deviceIdentity'
import { tabletHttpError } from './tabletSystemMessage'

// The tablet is a view of the local Host.  Mutating requests carry the
// per-device CSRF value issued by the Host's remote-access door.
const CSRF_HEADER = 'x-canai-remote-csrf'
let csrf: string | null = null

export function needsRemoteCsrf(method: string, url: string, origin: string): boolean {
  const verb = method.toUpperCase()
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return false
  return url.startsWith('/api/') || url.startsWith(`${origin}/api/`)
}

export interface RemoteSessionState {
  authorized: boolean
  device: string | null
  pinSet: boolean
}

export function installRemoteFetch(): void {
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!csrf || !needsRemoteCsrf(method, url, location.origin)) return original(input as RequestInfo, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(CSRF_HEADER, csrf)
    return original(input as RequestInfo, { ...init, headers })
  }

  const XHR = window.XMLHttpRequest
  const open = XHR.prototype.open
  const send = XHR.prototype.send
  const pending = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  XHR.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    pending.set(this, { method, url: String(url) })
    return (open as unknown as (...args: unknown[]) => unknown).apply(this, [method, url, ...rest]) as void
  } as typeof XHR.prototype.open
  XHR.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = pending.get(this)
    if (csrf && request && needsRemoteCsrf(request.method, request.url, location.origin)) this.setRequestHeader(CSRF_HEADER, csrf)
    return send.call(this, body ?? null)
  }
}

export async function readRemoteSession(): Promise<RemoteSessionState> {
  try {
    const answer = await fetch('/api/remote/session').then((response) => response.json()) as {
      authorized?: boolean
      csrf?: string | null
      device?: string | null
      pinSet?: boolean
    }
    csrf = answer.csrf ?? null
    return { authorized: Boolean(answer.authorized), device: answer.device ?? null, pinSet: Boolean(answer.pinSet) }
  } catch {
    return { authorized: false, device: null, pinSet: false }
  }
}

export async function remoteLogin(pin: string): Promise<RemoteSessionState> {
  const response = await fetch('/api/remote/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, device: deviceName() }),
  })
  const body = await response.json().catch(() => null) as { csrf?: string; device?: string; error?: string; code?: string; details?: unknown } | null
  if (!response.ok) throw tabletHttpError(body?.error ?? 'Could not sign in', response.status, body?.code, body?.details)
  csrf = body?.csrf ?? null
  return { authorized: true, device: body?.device ?? deviceName(), pinSet: true }
}

export async function remoteLogout(): Promise<void> {
  await fetch('/api/remote/logout', { method: 'POST' }).catch(() => {})
  csrf = null
}

const PREVIEW_EDGE_STEPS = [256, 512, 1024, 1920] as const

export function previewEdgeBucket(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 1920
  for (const step of PREVIEW_EDGE_STEPS) if (requested <= step) return step
  return 1920
}

/** Local media is served by the Host and can use its preview endpoint. */
export function previewSrc(src: string | undefined, displayEdge?: number): string | undefined {
  const [mediaPath, query] = (src ?? '').split('?')
  if (!mediaPath?.startsWith('/media/')) return src
  const name = mediaPath.slice('/media/'.length)
  if (displayEdge === undefined) return `/preview/${name}${query ? `?${query}` : ''}`
  const params = new URLSearchParams(query ?? '')
  params.set('w', String(previewEdgeBucket(displayEdge)))
  return `/preview/${name}?${params.toString()}`
}
