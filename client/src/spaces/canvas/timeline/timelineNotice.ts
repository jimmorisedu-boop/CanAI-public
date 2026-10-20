import { notify, type ToastMessage } from '../toastBus'
import { getTimelineTarget } from './timelineBus'

// Пока открыт режим правки, его сообщения показываются в СТРОКЕ СОСТОЯНИЯ
// транспорта (между таймкодом и кнопкой «Снять кадр»), а не общей всплывашкой
// у правого нижнего угла: там стоит «Применить», и плашка ложилась прямо на
// неё. Плашка посреди кадра тоже не прижилась: она загораживала ровно то, ради
// чего в режим зашли. Строка рядом с таймкодом никому не мешает, а глаз и так
// там, где идёт работа с моментом.
// Сроки жизни те же, что были у плашки: строка после сообщения возвращается
// к «Готово», держать её занятой незачем.

export type TimelineNotice = Omit<ToastMessage, 'id'> & {
  /** «Внимание» — отдельный тон строки состояния: не ошибка, но и не просто
   *  сведение (этот момент уже сохранён, рез не поставить). Общим всплывашкам
   *  такого тона не нужно, поэтому живёт только здесь. */
  tone?: 'warn'
}

type Listener = (notice: TimelineNotice | null) => void

let current: TimelineNotice | null = null
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | null = null

export function getTimelineNotice(): TimelineNotice | null {
  return current
}

export function onTimelineNotice(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearTimelineNotice(): void {
  // Гасить нечего — и уведомлять не о чем: иначе подписчик слышит второе
  // «пусто» после того, как сообщение уже погасло по таймеру.
  if (!current && !timer) return
  if (timer) clearTimeout(timer)
  timer = null
  current = null
  listeners.forEach((listener) => listener(null))
}

function show(notice: TimelineNotice): void {
  if (timer) clearTimeout(timer)
  current = notice
  listeners.forEach((listener) => listener(notice))
  // Гаснет ВСЁ, включая ошибку: строка должна вернуться к «Готово», а не
  // остаться висеть на давнем сообщении. Сроки короткие (просьба пользователя
  // «буквально секунды две»), дольше живёт только сообщение с кнопкой: её
  // надо успеть нажать.
  const life = notice.action ? 6_000 : notice.kind === 'error' ? 5_000 : 2_000
  timer = setTimeout(clearTimelineNotice, life)
}

/** Сообщение туда, где его увидят: в строку состояния режима, если он открыт,
 *  иначе — обычной всплывашкой. Один вызов на обоих путях, чтобы вызывающему
 *  коду не приходилось знать, открыт ли сейчас таймлайн. */
export function notifyInTimeline(notice: TimelineNotice): void {
  if (getTimelineTarget()) {
    show(notice)
    return
  }
  // Тон «внимание» общим всплывашкам незнаком — не тащим его за пределы режима.
  const { tone: _tone, ...toast } = notice
  notify(toast)
}
