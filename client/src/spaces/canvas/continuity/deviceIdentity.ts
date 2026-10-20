import { newId } from '../../../ui/ids'
// Кто это устройство.
//
// Нужны две вещи, и они разные по смыслу. `clientId` — техническое: по нему
// сервер понимает, тот же это клиент или другой, и он обязан пережить
// перезагрузку страницы (иначе после F5 компьютер перестал бы узнавать сам
// себя и отобрал бы доску у планшета). `deviceName` — человеческое: его читает
// оператор в карточке «Доска открыта на iPad», поэтому оно должно называть
// устройство так, как называет его сам человек.

const CLIENT_ID_KEY = 'canai-client-id'

/**
 * Имя устройства по строке браузера.
 *
 * Порядок проверок важен: iPadOS с 13-й версии представляется как Macintosh,
 * и отличить планшет от компьютера можно только по числу точек касания —
 * поэтому сначала спрашиваем про касания, и лишь потом верим слову Macintosh.
 */
export function deviceNameFrom(
  userAgent: string,
  options: { maxTouchPoints?: number; platform?: string } = {},
): string {
  const ua = userAgent || ''
  const touch = options.maxTouchPoints ?? 0
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return touch > 1 ? 'Android tablet' : 'Android phone'
  if (/Macintosh|Mac OS X/i.test(ua)) return touch > 1 ? 'iPad' : 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'another device'
}

let cachedClientId: string | null = null

/** Постоянный id этого браузера. Переживает перезагрузку, свой у каждого устройства. */
export function clientId(): string {
  if (cachedClientId) return cachedClientId
  let stored: string | null = null
  try {
    stored = localStorage.getItem(CLIENT_ID_KEY)
  } catch {
    // Приватное окно или запрещённое хранилище: тогда id живёт только в памяти.
    // Хуже от этого лишь то, что после F5 устройство считается новым.
    stored = null
  }
  const id = stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored) ? stored : newId()
  try {
    if (id !== stored) localStorage.setItem(CLIENT_ID_KEY, id)
  } catch {
    // см. выше
  }
  cachedClientId = id
  return id
}

export function deviceName(): string {
  return deviceNameFrom(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
  })
}

const TAB_ID_KEY = 'canai-tab-id'
let cachedTabId: string | null = null

/**
 * Id ЭТОЙ ВКЛАДКИ. Переживает F5 в ней самой и не совпадает с соседней.
 *
 * Живёт в sessionStorage намеренно: localStorage общий на все вкладки браузера,
 * а нам нужно ровно обратное.
 */
export function tabId(): string {
  if (cachedTabId) return cachedTabId
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem(TAB_ID_KEY)
  } catch {
    // Приватное окно или запрещённое хранилище: id живёт только в памяти, и
    // после F5 вкладка считается новой. Хуже от этого лишь лишняя передача
    // доски самому себе — на сроке владения это проходит за полминуты.
    stored = null
  }
  const id = stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored) ? stored : newId()
  try {
    if (id !== stored) sessionStorage.setItem(TAB_ID_KEY, id)
  } catch {
    // см. выше
  }
  cachedTabId = id
  return id
}

/**
 * Замок на имя вкладки, взятый через Web Locks.
 *
 * ⚠️ **sessionStorage КОПИРУЕТСЯ в новую вкладку, открытую из этой** — через
 * `window.open`, «Дублировать вкладку», восстановление сессии браузера.
 * Проверено вживую в Chrome 21.09.2026: вкладка, открытая галереей по
 * Ctrl+клику или пунктом «Открыть в новой вкладке», получала ТОТ ЖЕ id. Две
 * вкладки одной доски становились для сервера одним держателем, обе писали
 * её, и каждая вторая запись уезжала в конфликтную копию — «запускаешь
 * генерацию, и в момент, как сгенерилось, падает» (жалоба тестировщика
 * 20.09.2026). Защита, заведённая 18.09 ради ровно этой беды, не работала
 * там, где ею чаще всего и пользуются.
 *
 * Поэтому одного sessionStorage мало. Живая вкладка держит замок на своё имя
 * всю жизнь страницы; дубль узнаёт себя по занятому замку и берёт новое имя.
 * F5 имя сохраняет: старая страница ушла, её замок свободен.
 */
export interface TabLockApi {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
}

const TAB_LOCK_PREFIX = 'canai-tab:'
// Замок отвечает за миллисекунды. Молчит дольше — не держим работу из-за
// него: без проверки вкладка ведёт себя ровно так, как вела до неё.
const TAB_LOCK_TIMEOUT_MS = 1000

function holdTabLock(locks: TabLockApi, id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(true), timeoutMs)
    try {
      void locks.request(`${TAB_LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          done(false)
          return undefined
        }
        done(true)
        // Держим до конца жизни страницы: замок и есть «эта вкладка жива».
        return new Promise<void>(() => {})
      }).catch(() => done(true))
    } catch {
      done(true)
    }
  })
}

/**
 * Проверить, что имя вкладки ничьё, и занять его. Занято — взять новое.
 *
 * Возвращает имя, под которым вкладка теперь живёт. Отдельной функцией, чтобы
 * правило можно было проверить без браузера.
 */
export async function claimTabId(input: {
  current: string
  locks: TabLockApi
  makeId(): string
  remember(id: string): void
  timeoutMs?: number
}): Promise<string> {
  let id = input.current
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await holdTabLock(input.locks, id, input.timeoutMs ?? TAB_LOCK_TIMEOUT_MS)) {
      if (id !== input.current) input.remember(id)
      return id
    }
    id = input.makeId()
  }
  // Три занятых имени подряд не бывает. Но останавливать работу из-за замка
  // нельзя: берём последнее и живём с ним.
  input.remember(id)
  return id
}

function browserTabLocks(): TabLockApi | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: TabLockApi } }).navigator?.locks
    return locks && typeof locks.request === 'function' ? locks : null
  } catch {
    return null
  }
}

function rememberTabId(id: string): void {
  cachedTabId = id
  try {
    sessionStorage.setItem(TAB_ID_KEY, id)
  } catch {
    // Хранилище запрещено: имя живёт в памяти этой страницы, этого достаточно.
  }
}

let tabCheck: Promise<string> | null = null
let tabChecked = false

/**
 * Имя вкладки, проверенное на дубль.
 *
 * Возвращает строку сразу, когда проверять нечем (нет Web Locks: планшет по
 * http, тесты) или проверка уже прошла; иначе — обещание.
 */
export function verifiedTabId(locks: TabLockApi | null = browserTabLocks()): string | Promise<string> {
  if (tabChecked) return tabId()
  if (!locks) {
    tabChecked = true
    return tabId()
  }
  tabCheck ??= claimTabId({ current: tabId(), locks, makeId: newId, remember: rememberTabId })
    .then((id) => {
      tabChecked = true
      return id
    })
  return tabCheck
}

/** Держатель доски с проверенным именем вкладки (см. verifiedTabId). */
export function verifiedOwnerId(): string | Promise<string> {
  const tab = verifiedTabId()
  return typeof tab === 'string' ? `${clientId()}~${tab}` : tab.then((id) => `${clientId()}~${id}`)
}

/**
 * Кто держит доску. Устройство И вкладка.
 *
 * ⚠️ Владение считалось по одному `clientId`, а он общий на все вкладки
 * браузера — поэтому вторая вкладка той же доски не считалась «другим
 * держателем», карточка передачи не показывалась, и обе вкладки писали доску.
 * Номер ревизии при этом у каждой свой, и сервер на второй записи делал
 * конфликтную копию: человек получал дубли, ничего для этого не делая
 * (жалоба с видео 18.09.2026).
 */
export function ownerId(): string {
  return `${clientId()}~${tabId()}`
}

/** Тот же ли это браузер — то есть «другая вкладка», а не другое устройство. */
export function isSameDevice(owner: string | null | undefined): boolean {
  if (!owner) return false
  return owner.split('~')[0] === clientId()
}
