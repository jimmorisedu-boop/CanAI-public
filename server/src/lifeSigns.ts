import { logNote } from './log.js'

/**
 * Признаки жизни сервера в журнале.
 *
 * ⚠️ **Журнал молчал ровно там, где был нужен.** Жалоба 19–20.09.2026
 * «приложение постоянно вылетает» — а в журнале ни одной записи о падении.
 * Перехват аварий стоит и записал бы исключение, значит смерть была НЕ
 * исключением, и таких смертей три сорта, и ни один не оставлял следа:
 *
 * 1. Процесс убили снаружи (окно лаунчера закрыли, `taskkill`, выключение) —
 *    обработчики не успевают ничего.
 * 2. Процесс ЗАВИС: он жив, но не отвечает, и писать некому. В журнале
 *    событий Windows это видно как «node.exe stopped interacting» — два раза
 *    18.09.2026.
 * 3. Фатальная ошибка Node (чаще всего нехватка памяти): она печатается в
 *    консоль и исчезает вместе с окном.
 *
 * Отметка жизни закрывает второй и третий сорт сразу: по ней видно ТОЧНОЕ
 * время последнего вздоха и как росла память перед ним. Строка «остановлен»
 * закрывает первый — всё, что уходит по-людски.
 *
 * ⚠️ Раз в пять минут, одной короткой строкой. Чаще нельзя: журнал живёт до
 * мегабайта и ротацией вытеснит то, ради чего заведён.
 */

const BEAT_MS = 5 * 60_000

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

function uptime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export interface LifeSignsDeps {
  now?: () => number
  memory?: () => NodeJS.MemoryUsage
  /** Сколько задач сейчас в работе: по этому числу видно, чем он был занят. */
  activeJobs?: () => number
  note?: (scope: string, message: string) => void
  setTimer?: (callback: () => void, delayMs: number) => { unref?: () => void }
}

/** Строка отметки. Вынесена отдельно, чтобы её можно было проверить без таймеров. */
export function lifeSignLine(input: {
  startedAt: number
  now: number
  memory: NodeJS.MemoryUsage
  activeJobs: number
}): string {
  return `alive ${uptime(input.startedAt, input.now)}`
    + `, memory ${mb(input.memory.rss)} MB (heap ${mb(input.memory.heapUsed)} MB)`
    + `, active jobs ${input.activeJobs}`
}

export function startLifeSigns(deps: LifeSignsDeps = {}): () => void {
  const now = deps.now ?? Date.now
  const memory = deps.memory ?? (() => process.memoryUsage())
  const activeJobs = deps.activeJobs ?? (() => 0)
  const note = deps.note ?? logNote
  const setTimer = deps.setTimer ?? ((callback, delayMs) => {
    const timer = setInterval(callback, delayMs)
    return { unref: () => timer.unref() }
  })
  const startedAt = now()
  const timer = setTimer(() => {
    note('life', lifeSignLine({ startedAt, now: now(), memory: memory(), activeJobs: activeJobs() }))
  }, BEAT_MS)
  timer.unref?.()
  return () => { /* остановка не нужна: таймер unref и не держит процесс */ }
}

/**
 * Записать, ЧЕМ кончилась жизнь процесса.
 *
 * ⚠️ Сигнал приходит и при закрытии окна лаунчера — это «выключили», а не
 * «упало», и путать их дорого: по журналу иначе не отличить обычный выход от
 * аварии. Выходим сами, иначе сигнал перестанет завершать процесс.
 */
export function installExitNotes(
  deps: { note?: (scope: string, message: string) => void; platform?: string } = {},
): void {
  const note = deps.note ?? logNote
  process.on('exit', (code) => {
    note('life', code === 0 ? 'stopped' : `stopped, code ${code}`)
  })
  const platform = deps.platform ?? process.platform
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      if (keepsRunning(signal, platform)) {
        note('life', `Received ${signal}, but the app window remains; continuing`)
        return
      }
      note('life', `stopped: ${signalReason(signal)} (${signal})`)
      process.exit(signalExitCode(signal))
    })
  }
}

/**
 * ⚠️ **На Windows SIGHUP при живом окне — не повод умирать.**
 *
 * Дважды за день сервер уходил именно так (20.09.2026): простоял час пятьдесят
 * и четыре часа, ноль задач, память ровная — и вдруг сигнал. Тестировщик при
 * этом прямо сказал: окно не закрывалось. То есть консоль на месте, работать
 * можно, а приложение умирало и тянуло за собой вторую вкладку и конфликтную
 * копию доски.
 *
 * Если окно ДЕЙСТВИТЕЛЬНО закрыли, Windows добьёт процесс сама через несколько
 * секунд — терять нечего. А если не закрывали, человек просто продолжает
 * работать. Сигнал при этом остаётся в журнале: беду мы не прячем, мы перестаём
 * от неё умирать.
 *
 * ⚠️ Только Windows. На маке и линуксе SIGHUP означает, что терминал ушёл
 * по-настоящему, и остаться жить значило бы бросить сервер сиротой навсегда.
 */
export function keepsRunning(signal: string, platform: string): boolean {
  return signal === 'SIGHUP' && platform === 'win32'
}

/**
 * ⚠️ **Ноль означает «остановили нарочно», и лаунчер после него НЕ
 * перезапускает.** Это моя же ошибка, и она стоила дорого: обработчики сигналов
 * добавлялись ради журнала, но выходили нулём — а до них Node на SIGHUP
 * завершался ненулевым кодом, и лаунчер честно поднимал сервер заново. После
 * правки приложение стало умирать НАСОВСЕМ: окно открыто, а сервера нет
 * (20.09.2026, «вылетел», «ниче не закрывалось»).
 *
 * Различие простое и по смыслу: Ctrl+C и Ctrl+Break в окне — человек сам
 * попросил остановиться, поднимать обратно нельзя. SIGHUP — консоль уходит или
 * случилось что-то постороннее; если окно и правда закрыли, лаунчера уже нет и
 * код никому не важен, а если окно живо — приложение обязано вернуться.
 */
export function signalExitCode(signal: string): number {
  if (signal === 'SIGINT' || signal === 'SIGBREAK' || signal === 'SIGTERM') return 0
  // 128 + номер сигнала — общий признак «завершено сигналом».
  return 129
}

/**
 * ⚠️ Имя сигнала человеку не говорит ничего, а разбираем жалобы по журналу
 * именно мы, и «SIGHUP» легко принять за поломку. На Windows это закрытое окно
 * приложения — то есть обычный выход, а не авария (20.09.2026: в журнале
 * тестировщика ровно такая строка, и её надо было уметь прочитать сразу).
 */
export function signalReason(signal: string): string {
  // ⚠️ Не утверждаем «закрыли окно»: у тестировщика окно осталось открытым, а
  // сигнал пришёл (20.09.2026). Честно называем то, что известно.
  if (signal === 'SIGHUP') return 'The app console was interrupted; this is usually a closed window'
  if (signal === 'SIGBREAK') return 'Ctrl+Break in window app'
  if (signal === 'SIGINT') return 'Ctrl+C in window app'
  return 'The system requested shutdown'
}
