import { api } from '../../../api'
import type { BoardHolder } from '../../../types'
import { deviceName, verifiedOwnerId } from './deviceIdentity'

// Кто за рулём доски.
//
// Правило простоты, ради которого всё и делается: **доску держит то
// устройство, на которое человек сейчас смотрит**. Спрятанная вкладка
// держателем быть перестаёт, и обычный переход выглядит так, как человек его и
// представляет: отложил компьютер, открыл планшет — доска уже твоя, никаких
// вопросов. И наоборот: вернулся к компьютеру, а планшет заблокирован — доска
// возвращается сама.
//
// ⚠️ Но отмечаться спрятанная вкладка ПРОДОЛЖАЕТ: доска у неё открыта, она
// по-прежнему сохраняет холст (туда приезжают результаты генераций), и
// серверная доставка не имеет права писать под ней. «Держит» и «открыта» —
// разные вещи, и на сервере это разные сроки жизни.
//
// Спрашивать «перехватить?» приходится ровно в одном случае: оба устройства
// смотрят на одну доску одновременно. Это и правда стоит вопроса.

export type BoardOwnership =
  | { status: 'unknown' }
  | { status: 'mine'; holder: BoardHolder }
  | { status: 'other'; holder: BoardHolder }
  // Клиент долго не отмечался (ноутбук уснул, вкладку заморозили): сервер к
  // этому времени мог посчитать доску ничьей и сам поставить на неё
  // результат. Снимок в памяти устарел, и писать его поверх нельзя — доску
  // надо перечитать.
  | { status: 'stale' }

export interface BoardOwnershipSession {
  /** Перехватить доску себе (кнопка «Вернуть сюда»). */
  claim(): Promise<BoardOwnership>
  /** Разовая внеочередная отметка — например, после того как что-то сохранили. */
  ping(): Promise<BoardOwnership>
  stop(): void
}

export const HEARTBEAT_MS = 15_000

// Столько же, сколько живёт «доска открыта» на сервере. Пропустили больше —
// значит нас там уже забыли, и всё, что мы помним о доске, может быть неправдой.
export const STALE_AFTER_MS = 180_000

export interface BoardOwnershipDeps {
  action?: typeof api.boardPresenceAction
  now?(): number
  schedule?(callback: () => void, delayMs: number): unknown
  unschedule?(timer: unknown): void
  subscribeVisibility?(callback: () => void): () => void
  isVisible?(): boolean
  /**
   * Кто отмечается. По умолчанию — устройство плюс ПРОВЕРЕННОЕ имя вкладки:
   * вкладка, открытая из этой, получает копию её sessionStorage, и без
   * проверки две вкладки одной доски были бы для сервера одним держателем
   * (см. verifiedTabId).
   */
  owner?(): string | Promise<string>
}

export function startBoardOwnership(
  projectId: string,
  onChange: (state: BoardOwnership) => void,
  deps: BoardOwnershipDeps = {},
): BoardOwnershipSession {
  const action = deps.action ?? ((...args: Parameters<typeof api.boardPresenceAction>) => api.boardPresenceAction(...args))
  const schedule = deps.schedule ?? ((callback, delayMs) => window.setInterval(callback, delayMs))
  const unschedule = deps.unschedule ?? ((timer) => window.clearInterval(timer as number))
  const isVisible = deps.isVisible ?? (() => document.visibilityState === 'visible')
  const subscribeVisibility = deps.subscribeVisibility ?? ((callback) => {
    document.addEventListener('visibilitychange', callback)
    return () => document.removeEventListener('visibilitychange', callback)
  })

  // Имя вкладки проверяется замком, и это занимает миллисекунды. До ответа
  // не отмечаемся вовсе: отметка под чужим (скопированным) именем и есть та
  // беда, от которой проверка защищает.
  const initialOwner = (deps.owner ?? verifiedOwnerId)()
  let me: string | null = typeof initialOwner === 'string' ? initialOwner : null
  const identity: Promise<string> = typeof initialOwner === 'string'
    ? Promise.resolve(initialOwner)
    : initialOwner.then((id) => {
      me = id
      return id
    })
  const now = deps.now ?? (() => Date.now())
  let stopped = false
  let state: BoardOwnership = { status: 'unknown' }
  let held = false
  let lastBeatAt = 0

  const publish = (next: BoardOwnership) => {
    // Дёргаем подписчика только на настоящих сменах: тик раз в пятнадцать
    // секунд не должен перерисовывать интерфейс.
    if (next.status === state.status && next.status !== 'other') return
    if (next.status === 'other' && state.status === 'other'
      && next.holder.clientId === (state as { holder: BoardHolder }).holder.clientId) return
    state = next
    onChange(next)
  }

  const send = async (kind: 'claim' | 'heartbeat' | 'release', visible = true): Promise<BoardOwnership> => {
    try {
      const who = me ?? await identity
      const answer = await action(projectId, who, deviceName(), kind, visible)
      if (stopped && kind !== 'release') return state
      if (kind === 'release') {
        held = false
        return state
      }
      held = answer.mine
      const next: BoardOwnership = answer.mine && answer.holder
        ? { status: 'mine', holder: answer.holder }
        : answer.holder
          ? { status: 'other', holder: answer.holder }
          : { status: 'unknown' }
      publish(next)
      return next
    } catch {
      // Сервер недоступен или моргнула сеть. Состояние НЕ меняем: уводить
      // человека в просмотр из-за сетевой заминки — худшее, что тут можно
      // сделать. Ближайший тик всё поправит.
      return state
    }
  }

  const beat = () => {
    if (stopped) return
    const at = now()
    if (lastBeatAt > 0 && at - lastBeatAt > STALE_AFTER_MS) {
      // Проспали дольше, чем сервер нас помнит. Сообщаем об этом ДО
      // отметки: доску надо перечитать, а не дописывать по памяти.
      lastBeatAt = at
      onChange({ status: 'stale' })
      return
    }
    lastBeatAt = at
    // Отмечаемся ВСЕГДА, но по-разному. Видимая вкладка держит доску;
    // спрятанная держателем быть перестаёт (чтобы другому устройству не
    // пришлось ничего перехватывать), однако сообщает, что доска у неё
    // открыта: она продолжает её сохранять, и серверная доставка не имеет
    // права писать под ней.
    void send('heartbeat', isVisible())
  }

  // Уходящая страница обязана сказать «меня больше нет».
  //
  // Обычный fetch на выгрузке браузер обрывает, и сервер ещё три минуты считает
  // доску открытой — всё это время он не ставит на неё результаты (поймано
  // живым прогоном: макрос с планшета досчитался, а картинке было некуда
  // встать). `keepalive` переживает выгрузку и, в отличие от sendBeacon,
  // сохраняет заголовки — а значит и ключ запроса планшетной двери.
  //
  // ⚠️ Это НЕ нарушение запрета «не сохранять снапшот из pagehide»: тот запрет
  // о состоянии документа, которым устаревшая вкладка однажды затёрла доску.
  // Здесь не уезжает ничего, кроме факта ухода.
  const releaseOnUnload = () => {
    // Имя ещё не проверено — значит, мы и не отмечались: отпускать нечего.
    if (stopped || !me) return
    try {
      void fetch('/api/board-presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectId, clientId: me, device: deviceName(), action: 'release' }),
        keepalive: true,
      }).catch(() => {})
    } catch {
      // Страница уже уходит — обрабатывать тут нечего.
    }
  }
  const canListen = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (canListen) window.addEventListener('pagehide', releaseOnUnload)

  const timer = schedule(beat, HEARTBEAT_MS)
  const unsubscribeVisibility = subscribeVisibility(beat)
  beat()

  return {
    claim: () => send('claim'),
    ping: () => send('heartbeat'),
    stop: () => {
      if (stopped) return
      stopped = true
      unschedule(timer)
      unsubscribeVisibility()
      if (canListen) window.removeEventListener('pagehide', releaseOnUnload)
      // Release шлём ВСЕГДА, а не только когда держали: доска у нас была
      // открыта в любом случае, и серверу пора об этом забыть.
      void send('release')
      held = false
    },
  }
}
