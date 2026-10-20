// Состояние связи с интернетом. Отдельный модуль, потому что сообщение о нём
// должно быть одинаковым везде, а проверка — тестируемой.
//
// Важно про CanAI: сервер локальный, и без интернета приложение НЕ ломается —
// доски, холст, архив и редактор макросов работают полностью. Отваливается
// только то, что ходит на fal.ai: генерации, помощник и баланс. Поэтому текст
// говорит «генерации недоступны», а не «нет соединения с сервером».
//
// navigator.onLine врёт в одну сторону: он бывает true без реального доступа в
// сеть (подключение к роутеру без интернета). Поэтому false ему верим и
// предупреждаем, а true ничего не гарантирует — запуск мы не блокируем.

export interface OnlineWatcherDeps {
  isOnline(): boolean
  subscribe(listener: () => void): () => void
}

export interface OnlineWatcher {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
}

export function createOnlineWatcher(deps: OnlineWatcherDeps): OnlineWatcher {
  let online = deps.isOnline()
  const listeners = new Set<() => void>()

  const refresh = () => {
    const next = deps.isOnline()
    if (next === online) return
    online = next
    for (const listener of listeners) listener()
  }

  // Отписка от window хранится ОДНА на всех, а не в замыкании первого
  // подписчика: иначе, когда он уходил раньше остальных, снять обработчики
  // было уже некому — они висели до конца сессии.
  let stopSource: (() => void) | null = null

  return {
    getSnapshot: () => online,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) stopSource = deps.subscribe(refresh)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        stopSource?.()
        stopSource = null
      }
    },
  }
}

export const OFFLINE_TITLE = 'No internet connection'
export const OFFLINE_DETAIL =
  'Generation, the assistant, and balance are unavailable because they use fal.ai. ' +
  'Boards, canvas, archive, and the macro editor keep working as usual.'

const browserWatcher = createOnlineWatcher({
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  subscribe(listener) {
    window.addEventListener('online', listener)
    window.addEventListener('offline', listener)
    return () => {
      window.removeEventListener('online', listener)
      window.removeEventListener('offline', listener)
    }
  },
})

export const subscribeOnline = browserWatcher.subscribe
export const getOnline = browserWatcher.getSnapshot
