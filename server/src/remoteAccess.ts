import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.js'
import { AttemptWindow } from './accessAttempts.js'

// Доступ к приложению с планшета.
//
// Основной сервер как слушал 127.0.0.1, так и слушает: открывать его наружу
// нельзя, там ключ fal, настройки и выключение приложения. Гостевой сервер
// тоже не трогаем — инвариант «у гостя физически нет доступа к /api» стоит
// дороже экономии на ещё одном слушателе. Поэтому появляется третий, свой:
// он знает PIN, отдаёт планшетную страницу и пускает СТРОГО перечисленные
// ручки.
//
// PIN обязателен. Приложение по сети без пароля — это чужой доступ к чужим
// деньгам: любой в той же кофейне запустит генерацию с вашего счёта.

const scrypt = promisify(scryptCallback)

export const REMOTE_SESSION_COOKIE = 'canai_remote'
export const REMOTE_CSRF_HEADER = 'x-canai-remote-csrf'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 32

export interface RemoteSession {
  token: string
  csrf: string
  device: string
  createdAt: number
  expiresAt: number
}

export interface RemoteAccessState {
  /** Слушать ли на всех интерфейсах (иначе только 127.0.0.1). */
  enabled: boolean
  pin: { salt: string; hash: string } | null
  sessions: RemoteSession[]
}

const EMPTY: RemoteAccessState = { enabled: false, pin: null, sessions: [] }

function stateFile(): string {
  return path.join(path.dirname(config.settingsFile), 'remote-access.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeSession(value: unknown, now: number): RemoteSession | null {
  if (!isRecord(value)) return null
  const token = typeof value.token === 'string' ? value.token : ''
  const csrf = typeof value.csrf === 'string' ? value.csrf : ''
  const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : 0
  if (!token || !csrf || expiresAt <= now) return null
  return {
    token,
    csrf,
    device: typeof value.device === 'string' ? value.device.slice(0, 40) : 'device',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    expiresAt,
  }
}

let cache: RemoteAccessState | null = null
let queue: Promise<unknown> = Promise.resolve()

function withLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

export async function loadRemoteAccess(now: number = Date.now()): Promise<RemoteAccessState> {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(stateFile(), 'utf8'))
    if (!isRecord(parsed)) throw new Error('unreadable')
    const pin = isRecord(parsed.pin)
      && typeof parsed.pin.salt === 'string'
      && typeof parsed.pin.hash === 'string'
      ? { salt: parsed.pin.salt, hash: parsed.pin.hash }
      : null
    cache = {
      // Без PIN доступ по сети не включается никогда, даже если в файле
      // написано обратное: файл мог остаться от прежней настройки.
      enabled: parsed.enabled === true && pin !== null,
      pin,
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((entry) => sanitizeSession(entry, now)).filter((s): s is RemoteSession => s !== null)
        : [],
    }
  } catch {
    cache = { ...EMPTY, sessions: [] }
  }
  return cache
}

async function writeState(next: RemoteAccessState): Promise<void> {
  cache = next
  const file = stateFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2))
  await fs.rename(tmp, file)
}

export function hashRemotePin(pin: string): Promise<{ salt: string; hash: string }> {
  if (!/^\d{4,12}$/.test(pin)) return Promise.reject(new Error('Code must contain 4–12 digits'))
  const salt = randomBytes(16).toString('base64url')
  return (scrypt(pin, salt, 32) as Promise<Buffer>).then((derived) => ({
    salt,
    hash: derived.toString('base64url'),
  }))
}

async function pinMatches(pin: string, stored: { salt: string; hash: string }): Promise<boolean> {
  const actual = await scrypt(pin, stored.salt, 32) as Buffer
  const expected = Buffer.from(stored.hash, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Перебор PIN должен быть бесполезен: десять попыток за пять минут с адреса. */
const attempts = new AttemptWindow({ max: 10, windowMs: 5 * 60_000 })

export class RemotePinBlocked extends Error {
  constructor() {
    super('Too many attempts. Wait five minutes.')
  }
}

export async function setRemotePin(pin: string): Promise<void> {
  const hashed = await hashRemotePin(pin)
  await withLock(async () => {
    const state = await loadRemoteAccess()
    // Смена кода разлогинивает все устройства — иначе новый код ничего не
    // закрывает: старая сессия работает по-прежнему.
    await writeState({ ...state, pin: hashed, sessions: [] })
  })
}

export async function clearRemoteAccess(): Promise<void> {
  await withLock(async () => {
    await writeState({ enabled: false, pin: null, sessions: [] })
  })
}

export async function setRemoteEnabled(enabled: boolean): Promise<RemoteAccessState> {
  return withLock(async () => {
    const state = await loadRemoteAccess()
    if (enabled && !state.pin) throw new Error('Enter the access code first')
    // Turning LAN access off must invalidate every tablet session. The listener
    // moves back to loopback, but an old token must not revive when LAN access
    // is enabled again later.
    const next = { ...state, enabled, sessions: enabled ? state.sessions : [] }
    await writeState(next)
    return next
  })
}

export interface RemoteLoginResult {
  session: RemoteSession
}

export async function remoteLogin(
  pin: string,
  device: string,
  clientKey: string,
  now: number = Date.now(),
): Promise<RemoteLoginResult> {
  if (attempts.blocked(clientKey)) throw new RemotePinBlocked()
  const state = await loadRemoteAccess(now)
  if (!state.enabled) throw new Error('Tablet access is turned off')
  const verifiedPin = state.pin
  if (!verifiedPin) throw new Error('Access code is not set')
  if (!(await pinMatches(pin, verifiedPin))) {
    attempts.register(clientKey)
    throw new Error('Invalid code')
  }
  const session: RemoteSession = {
    token: randomBytes(32).toString('base64url'),
    csrf: randomBytes(24).toString('base64url'),
    device: device.slice(0, 40) || 'device',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  }
  await withLock(async () => {
    const current = await loadRemoteAccess(now)
    // PIN hashing is asynchronous. Re-check the durable state inside the
    // commit lock so a login that started before disable/PIN rotation cannot
    // create a fresh session after the old sessions were revoked.
    if (!current.enabled) throw new Error('Tablet access is turned off')
    if (!current.pin || current.pin.salt !== verifiedPin.salt || current.pin.hash !== verifiedPin.hash) {
      throw new Error('Access code changed. Sign in again.')
    }
    const sessions = [...current.sessions.filter((s) => s.expiresAt > now), session].slice(-MAX_SESSIONS)
    await writeState({ ...current, sessions })
  })
  return { session }
}

export async function remoteSession(
  token: string | undefined,
  now: number = Date.now(),
): Promise<RemoteSession | null> {
  if (!token) return null
  const state = await loadRemoteAccess(now)
  if (!state.enabled) return null
  const session = state.sessions.find((entry) => entry.token === token)
  if (!session || session.expiresAt <= now) return null
  return session
}

/** Revoke one tablet token, leaving other devices signed in. */
export async function revokeRemoteSession(token: string | undefined): Promise<void> {
  if (!token) return
  await withLock(async () => {
    const state = await loadRemoteAccess()
    const sessions = state.sessions.filter((entry) => entry.token !== token)
    if (sessions.length !== state.sessions.length) await writeState({ ...state, sessions })
  })
}

export async function revokeRemoteSessions(): Promise<void> {
  await withLock(async () => {
    const state = await loadRemoteAccess()
    await writeState({ ...state, sessions: [] })
  })
}

/** Только для тестов: состояние читается один раз и живёт в памяти. */
export function resetRemoteAccessCache(): void {
  cache = null
}
