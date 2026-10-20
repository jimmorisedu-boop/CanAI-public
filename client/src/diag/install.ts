import { clearLog, dumpLogText, getLogEntries, log, setConsoleAreas } from './log.js'
import { downloadLogFile } from './logFile.js'

/**
 * Ручка журнала в консоли: `__canaiLog.save()` сохранит файл, `.show()`
 * напечатает ленту, `.on()` включит живой вывод. Нужна не для отладки кода —
 * по ней можно провести человека голосом, когда он смотрит на сломанный экран.
 */
export function installLogHandle(): void {
  try {
    ;(window as unknown as Record<string, unknown>).__canaiLog = {
      save: () => downloadLogFile(),
      text: () => dumpLogText(),
      show: () => { console.log(dumpLogText()) },
      entries: () => getLogEntries(),
      on: (areas = '*') => { setConsoleAreas(areas) },
      off: () => { setConsoleAreas('') },
      clear: () => { clearLog() },
    }
  } catch {
    // без window (проверки, серверный разбор) ручка просто не появится
  }
  // Необработанный сбой — самое ценное событие журнала: после него человек и
  // видит белый экран или замерший интерфейс.
  try {
    window.addEventListener('error', (event) => {
      log.error('app', 'page script error', {
        message: event.message,
        file: event.filename,
        line: event.lineno,
      })
    })
    window.addEventListener('unhandledrejection', (event) => {
      const reason = (event as PromiseRejectionEvent).reason
      log.error('app', 'unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
      })
    })
  } catch {
    // тоже необязательно
  }
}
