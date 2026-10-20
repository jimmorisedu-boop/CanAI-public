import { config } from './config.js'
import { sortMediaByBoards, type SortMediaResult } from './mediaLayout.js'
import { boardMediaFiles } from './projects.js'

// Раскладку запускает не только старт: свежий файл сначала попадает в «общее»
// (в момент записи доска ещё не известна), и без повторного прохода он лежал бы
// там до следующего запуска приложения. Поэтому после сохранения холста
// раскладку планируем заново — с задержкой, чтобы серия автосейвов не гоняла
// обход папок на каждое нажатие.
//
// Работа фоновая и необязательная: её отказ ничего не ломает, потому что
// чтение находит файл индексом ГДЕ УГОДНО (см. mediaLayout).

const DEBOUNCE_MS = 4_000

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let again = false

export async function sortMediaNow(): Promise<SortMediaResult> {
  return sortMediaByBoards({ root: config.mediaDir, boards: await boardMediaFiles() })
}

async function run(): Promise<void> {
  if (running) {
    // Пока идёт обход, новые просьбы копим в один повтор: иначе автосейв мог бы
    // выстроить очередь обходов длиной в число сохранений.
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      await sortMediaNow()
    } while (again)
  } catch {
    // Не удалось — не беда: файлы на месте, ссылки работают, следующий запуск
    // приложения разложит.
  } finally {
    running = false
  }
}

/** Попросить разложить медиа по доскам — не сейчас, а когда правки утихнут. */
export function scheduleMediaSort(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void run()
  }, DEBOUNCE_MS)
  timer.unref?.()
}
