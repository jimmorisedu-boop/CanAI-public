export type TabletCachePolicy = 'network-only' | 'cache-first' | 'shell-navigation'

const PRIVATE_PREFIXES = ['/v3/', '/api/', '/media/']
const SHELL_PREFIX = '/tablet/'
const CACHE_NAME = 'canai-tablet-shell-v3'
const INITIAL_SHELL = ['/tablet/', '/tablet/tablet.webmanifest', '/tablet/favicon.svg']

export function tabletCachePolicy(url: URL, navigation: boolean): TabletCachePolicy {
  if (url.origin !== (typeof location === 'undefined' ? url.origin : location.origin)) return 'network-only'
  if (PRIVATE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'network-only'
  if (!url.pathname.startsWith(SHELL_PREFIX)) return 'network-only'
  if (navigation) return 'shell-navigation'
  if (
    url.pathname.startsWith('/tablet/assets/')
    || url.pathname.startsWith('/tablet/fonts/')
    || url.pathname === '/tablet/tablet.webmanifest'
    || url.pathname === '/tablet/favicon.svg'
  ) return 'cache-first'
  return 'network-only'
}

interface InstallEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
}

interface FetchEventLike extends Event {
  request: Request
  respondWith(response: Promise<Response>): void
}

interface WorkerScopeLike {
  addEventListener(type: string, listener: (event: never) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
}

function shellAssets(html: string): string[] {
  const assets = new Set(INITIAL_SHELL)
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    try {
      const url = new URL(match[1]!, 'https://canai.invalid/tablet/')
      if (url.pathname.startsWith('/tablet/assets/') || url.pathname.startsWith('/tablet/fonts/')) {
        assets.add(url.pathname)
      }
    } catch {
      // Невалидная ссылка в HTML не должна сломать установку уже открытой PWA.
    }
  }
  return [...assets]
}

async function installShell(): Promise<void> {
  const home = await fetch('/tablet/', { cache: 'no-store', credentials: 'same-origin' })
  if (!home.ok) throw new Error(`tablet shell HTTP ${home.status}`)
  const html = await home.clone().text()
  const cache = await caches.open(CACHE_NAME)
  await cache.put('/tablet/', home)
  for (const path of shellAssets(html).filter((path) => path !== '/tablet/')) {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
    if (response.ok) await cache.put(path, response)
  }
}

async function removeOldShells(): Promise<void> {
  const names = await caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith('canai-tablet-shell-') && name !== CACHE_NAME)
    .map((name) => caches.delete(name)))
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone())
  return response
}

async function shellNavigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    if (response.ok) await (await caches.open(CACHE_NAME)).put('/tablet/', response.clone())
    return response
  } catch {
    const cached = await caches.match('/tablet/')
    if (cached) return cached
    throw new Error('Tablet interface is unavailable offline')
  }
}

// Модуль импортируется тестами и кодом регистрации. События подключаем только
// внутри настоящего worker context, а не в окне приложения.
if (typeof document === 'undefined' && typeof globalThis.addEventListener === 'function' && typeof caches !== 'undefined') {
  const scope = globalThis as unknown as WorkerScopeLike
  scope.addEventListener('install', ((event: InstallEventLike) => {
    event.waitUntil(installShell().then(() => scope.skipWaiting()))
  }) as never)
  scope.addEventListener('activate', ((event: InstallEventLike) => {
    event.waitUntil(removeOldShells().then(() => scope.clients.claim()))
  }) as never)
  scope.addEventListener('fetch', ((event: FetchEventLike) => {
    if (event.request.method !== 'GET') return
    const policy = tabletCachePolicy(new URL(event.request.url), event.request.mode === 'navigate')
    if (policy === 'cache-first') event.respondWith(cacheFirst(event.request))
    if (policy === 'shell-navigation') event.respondWith(shellNavigation(event.request))
  }) as never)
}
