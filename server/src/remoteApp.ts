import express, { type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { config, serverRootDir } from './config.js'
import { attachMediaRoutes } from './mediaRoute.js'
import { ensureShareImagePreview, previewEdgeStep } from './shareMediaPreview.js'
import { mediaFilePathAsync } from './storage.js'
import {
  REMOTE_CSRF_HEADER,
  REMOTE_SESSION_COOKIE,
  RemotePinBlocked,
  loadRemoteAccess,
  remoteLogin,
  remoteSession,
  revokeRemoteSession,
} from './remoteAccess.js'
import { isAllowedRemoteApi, isAllowedRemoteHost } from './remoteAllowlist.js'
import { apiRouter, localRuntimeInstanceId } from './routes.js'
import { attachTabletHelpAssets } from './tabletHelpAssets.js'

// Планшетный сервер: своя дверь в приложение, со своим замком.
//
// Это НЕ прокси и не копия API: тот же apiRouter, но за проверкой сессии и
// белым списком путей (remoteAllowlist). Прокси добавил бы второй сетевой шаг
// и вторую копию логики ошибок, а список путей всё равно пришлось бы вести.

const CLIENT_DIST = path.resolve(serverRootDir, '..', 'client', 'dist')
const TABLET_DIST = path.join(CLIENT_DIST, 'tablet')

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function hostnameOf(req: Request): string {
  const raw = String(req.headers.host ?? '').toLowerCase()
  return raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
}

function tabletIndexFile(): string | null {
  const file = path.join(TABLET_DIST, 'tablet.html')
  return fs.existsSync(file) ? file : null
}

export function createRemoteApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    if (!isAllowedRemoteHost(hostnameOf(req))) {
      res.status(403).json({ error: 'Invalid Host' })
      return
    }
    // Планшет открывается по http в локальной сети, поэтому кэш и утечку
    // адреса закрываем явно.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true, instanceId: localRuntimeInstanceId() })
  })

  app.use(express.json({ limit: '50mb' }))

  const clientKeyOf = (req: Request): string => req.socket.remoteAddress ?? 'unknown'

  app.post('/api/remote/login', async (req, res) => {
    const body = (req.body ?? {}) as { pin?: unknown; device?: unknown }
    const pin = typeof body.pin === 'string' ? body.pin : ''
    const device = typeof body.device === 'string' ? body.device : 'device'
    try {
      const { session } = await remoteLogin(pin, device, clientKeyOf(req))
      res.cookie(REMOTE_SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: session.expiresAt - Date.now(),
        path: '/',
      })
      res.json({ ok: true, csrf: session.csrf, device: session.device })
    } catch (error) {
      const status = error instanceof RemotePinBlocked ? 429 : 401
      res.status(status).json({ error: error instanceof Error ? error.message : 'Could not sign in' })
    }
  })

  app.get('/api/remote/session', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE]
    const session = await remoteSession(token)
    const state = await loadRemoteAccess()
    res.json({
      authorized: Boolean(session),
      csrf: session?.csrf ?? null,
      device: session?.device ?? null,
      pinSet: Boolean(state.pin),
    })
  })

  app.post('/api/remote/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE]
    try {
      await revokeRemoteSession(token)
      res.clearCookie(REMOTE_SESSION_COOKIE, { path: '/', sameSite: 'strict' })
      res.json({ ok: true })
    } catch {
      // Clear the browser token even if the durable revoke failed. The client
      // is logged out locally, while the status makes the server-side failure
      // visible so the user can use “Disconnect devices” from the desktop.
      res.clearCookie(REMOTE_SESSION_COOKIE, { path: '/', sameSite: 'strict' })
      res.status(500).json({ error: 'Signed out here, but the server could not revoke this device' })
    }
  })

  // Всё остальное под /api — только с живой сессией и только из белого списка.
  app.use('/api', async (req: Request, res: Response, next) => {
    if (req.path.startsWith('/remote/')) return next()
    const session = await remoteSession(parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE])
    if (!session) {
      res.status(401).json({ error: 'Code sign-in is required' })
      return
    }
    // Небезопасные методы требуют собственный заголовок: cookie сама по себе
    // ушла бы и с чужой страницы, открытой в том же браузере.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && req.get(REMOTE_CSRF_HEADER) !== session.csrf) {
      res.status(403).json({ error: 'Invalid key request' })
      return
    }
    if (!isAllowedRemoteApi(req.method, req.path)) {
      res.status(403).json({ error: 'This action is available only on the computer' })
      return
    }
    // apiRouter обслуживает и Desktop, и эту отдельную LAN-дверь. Маркер
    // ставится сервером после PIN/CSRF/allowlist проверок, чтобы agent routes
    // могли запретить Cloud task control с планшета; клиентский заголовок не
    // является источником доверия.
    res.locals.remoteTablet = true
    next()
  })

  app.use('/api', apiRouter)

  // Экранное превью картинки. Полноразмерные растры — главная причина, по
  // которой вкладка на планшете вылетает по памяти: доска на шесть сотен
  // картинок 1024×1024 в декодированном виде туда просто не влезает. Тот же
  // механизм, что у гостевых снимков (WebP, кэш по mtime). Размер задаёт
  // САМА страница (?w= — фактический размер объекта на экране): декодить
  // 1920px ради карточки в 300px значит съесть память айпада впустую.
  // Без ?w — прежние 1920, так что старая страница продолжает работать.
  app.get('/preview/:name', async (req, res) => {
    const session = await remoteSession(parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE])
    if (!session) {
      res.status(401).send('Code sign-in is required')
      return
    }
    const name = path.basename(req.params.name)
    const maxEdge = previewEdgeStep(Number(req.query.w))
    try {
      const sourceFile = await mediaFilePathAsync(name)
      const previewFile = await ensureShareImagePreview({
        sourceFile,
        previewDir: path.join(config.mediaDir, '..', 'screen-previews'),
        maxEdge,
      })
      res.type('image/webp')
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.sendFile(path.resolve(previewFile))
    } catch {
      // Превью не сделалось (файла нет, формат неизвестен, sharp не смог) —
      // отправляем к оригиналу, а не показываем дыру.
      res.redirect(302, `/media/${encodeURIComponent(name)}`)
    }
  })

  // Медиа — за той же дверью: снимки пользователя не должны отдаваться кому
  // попало в сети. Проверка вешается ИМЕННО на /media: подсунуть сюда целое
  // приложение-обёртку значило бы закрыть заодно и саму страницу, которая
  // открывается ДО входа (так и вышло при первой сборке — «/» отвечал 401).
  app.use('/media', async (req, res, next) => {
    const session = await remoteSession(parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE])
    if (!session) {
      res.status(401).send('Code sign-in is required')
      return
    }
    next()
  })
  attachMediaRoutes(app)

  const index = tabletIndexFile()
  if (index) {
    attachTabletHelpAssets(app, path.join(TABLET_DIST, 'help'))
    app.use('/assets', express.static(path.join(TABLET_DIST, 'assets'), { maxAge: '365d', immutable: true }))
    app.use('/fonts', express.static(path.join(CLIENT_DIST, 'fonts'), { maxAge: '365d', immutable: true }))
    // Движок сравнения лиц просит свои файлы по '/ort/' (см. faceSimilarity:
    // ort.env.wasm.wasmPaths). Без этой строки сравнение на планшете молча не
    // поднимается: страница есть, кнопка есть, а движок отвечает «no backend».
    app.use('/ort', express.static(path.join(TABLET_DIST, 'ort'), { maxAge: '365d', immutable: true }))
    app.get(['/favicon.svg'], (_req, res) => {
      res.type('image/svg+xml').sendFile(path.join(CLIENT_DIST, 'favicon.svg'))
    })
    // ⚠️ Манифест обязан отдаваться ФАЙЛОМ, а не проваливаться в '*'.
    //
    // Ниже стоит фолбэк на tablet.html, и без этой строки по адресу манифеста
    // приходила разметка страницы: браузер отвечал «Manifest: Line 1, column
    // 1, Syntax error» (видно в консоли у пользователя). Ломался при этом не
    // пустяк — именно манифест держит ЛАНДШАФТ у страницы, добавленной на
    // домашний экран. То есть блокировка поворота не работала вовсе, а
    // единственным следом была строка в консоли, куда на планшете не смотрят.
    app.get('/tablet.webmanifest', (_req, res) => {
      res.type('application/manifest+json').sendFile(path.join(TABLET_DIST, 'tablet.webmanifest'))
    })
    app.get('*', (_req, res) => {
      res.sendFile(index)
    })
  } else {
    app.get('*', (_req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Tablet page is not built. Run the app build first.')
    })
  }

  return app
}
