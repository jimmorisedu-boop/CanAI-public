import type { ServerStatus } from '../../types'

/**
 * Доступность своего сервера.
 *
 * ⚠️ Одна неудачная проверка — ещё НЕ диагноз. Раньше первый же сбой `/api/status`
 * публиковал `null`, а это значит сразу две вещи на экране: тревожная плашка
 * «Сервер недоступен» и погашенная кнопка «Создать». На живом сервере такой
 * сбой — обычное дело: браузер держит к одному адресу шесть соединений, и на
 * доске с картинками проверка статуса легко оказывается в очереди за ними
 * (жалоба 18.09.2026: «иногда на локальной доске появляется такое сообщение»,
 * при этом приложение работает).
 *
 * Поэтому держим последний известный ответ и тревожим, только когда сервер
 * молчит НЕСКОЛЬКО раз подряд — то же правило, что у сетевой доски
 * (`OFFLINE_GRACE_MS`): короткий обрыв, который чинится сам, человека не
 * касается. При повторах через 1с и 2с это около трёх секунд молчания.
 */
const ALARM_AFTER_FAILURES = 3

export function startServerStatusMonitor(input: {
  read(): Promise<ServerStatus>
  publish(status: ServerStatus | null): void
  /** Called once the first status attempt settles enough to inform the UI. */
  onReady?(): void
  schedule?(run: () => void, delayMs: number): unknown
  unschedule?(timer: unknown): void
}) {
  const schedule = input.schedule ?? ((run, delay) => window.setTimeout(run, delay))
  const unschedule = input.unschedule ?? (timer => window.clearTimeout(timer as number))
  let disposed = false
  let running = false
  let refreshPending = false
  let timer: unknown
  let failures = 0
  let ready = false

  const markReady = () => {
    if (ready) return
    ready = true
    input.onReady?.()
  }

  function refresh(): void {
    if (disposed) return
    if (timer !== undefined) unschedule(timer)
    timer = undefined
    if (running) { refreshPending = true; return }
    running = true
    void input.read().then(status => {
      if (disposed) return
      failures = 0
      markReady()
      input.publish(status)
    }, () => {
      if (disposed) return
      failures++
      // Молчим, пока сбой может оказаться случайным: на экране остаётся
      // последний известный ответ, и человек продолжает работать.
      if (failures >= ALARM_AFTER_FAILURES) {
        markReady()
        input.publish(null)
      }
    }).finally(() => {
      running = false
      if (disposed) return
      if (refreshPending) {
        refreshPending = false
        refresh()
      } else {
        timer = schedule(refresh, failures ? Math.min(10_000, 1_000 * failures) : 30_000)
      }
    })
  }

  refresh()
  return {
    refresh,
    dispose() {
      disposed = true
      if (timer !== undefined) unschedule(timer)
      timer = undefined
    },
  }
}
