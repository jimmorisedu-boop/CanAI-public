/**
 * Есть ли связь с сервером команды — одной точкой в шапке (просьба
 * 09.09.2026: «внутри шестерёнки зелёная точка — есть соединение, красная —
 * нет»).
 *
 * ⚠️ Правда о связи живёт в ДВУХ местах, и одного мало. Открытая сетевая
 * доска знает её точнее всех — она держит живое соединение и первой замечает
 * обрыв; но доска бывает локальной или не открытой вовсе, и тогда спросить
 * некого, кроме профиля аккаунта. Поэтому доска, пока открыта, ГОВОРИТ своё
 * состояние, а без неё индикатор спрашивает профиль сам.
 *
 * ⚠️ Не в команде — точки НЕТ. Показывать «нет связи» тому, кому не с чем
 * связываться, значит пугать поломкой, которой не существует.
 */

export type ServerLinkState = 'unknown' | 'online' | 'offline'

/** Состояние загрузки сетевой доски → состояние связи. */
export function linkFromBoardState(state: string): ServerLinkState {
  // `connecting` — не диагноз: открытие идёт в два шага, и в промежутке связи
  // формально нет (см. quietReconnect). Помечать это красным значило бы моргать
  // тревогой на каждом открытии.
  if (state === 'ready' || state === 'readonly') return 'online'
  if (state === 'offline' || state === 'error') return 'offline'
  return 'unknown'
}

/** Профиль аккаунта → состояние связи. */
export function linkFromAccount(account: { connected: boolean; reachable: boolean }): ServerLinkState {
  if (!account.connected) return 'unknown'
  return account.reachable ? 'online' : 'offline'
}

type Listener = () => void

let boardLink: ServerLinkState = 'unknown'
let accountLink: ServerLinkState = 'unknown'
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Открытая сетевая доска — самый точный источник; она же его и снимает. */
export function publishBoardServerLink(state: ServerLinkState): void {
  if (boardLink === state) return
  boardLink = state
  emit()
}

export function publishAccountServerLink(state: ServerLinkState): void {
  if (accountLink === state) return
  accountLink = state
  emit()
}

/** Живая доска перевешивает профиль: она узнаёт об обрыве первой. */
export function getServerLink(): ServerLinkState {
  return boardLink !== 'unknown' ? boardLink : accountLink
}

export function subscribeServerLink(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Только для тестов: вернуть шину в исходное состояние. */
export function resetServerLink(): void {
  boardLink = 'unknown'
  accountLink = 'unknown'
  emit()
}
