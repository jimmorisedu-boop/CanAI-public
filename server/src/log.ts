import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

// Ошибки — в файл data/logs/server.log (+ в консоль). У покупателя окно
// консоли закрывается — без файла жалобу «не работает» нечем диагностировать.
const logDir = path.join(path.dirname(config.projectFile), 'logs')
const logFile = path.join(logDir, 'server.log')
const MAX_LOG_BYTES = 1024 * 1024 // 1 МБ, потом ротация в server.log.old

// ⚠️ Тестовый прогон в журнал НЕ пишет, если ему не дали своей папки данных.
// Папку выбирает config.ts при импорте, и тест, который её не задал, писал
// прямо в ЖИВОЙ server/data/logs/server.log разработчика. Данным вреда нет, а
// диагностике прямой: журнал — единственное, по чему разбирают жалобу
// «приложение вылетает», а полный прогон заливал его сотнями строк «доска
// открыта за 1 мс» и вытеснял настоящие записи ротацией (найдено 19.09.2026
// при разборе такой жалобы). Признак официальный: node:test ставит
// NODE_TEST_CONTEXT в каждом своём процессе.
const testRunWithoutOwnData = Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.CANAI_DATA_DIR

function writeLine(line: string): void {
  if (testRunWithoutOwnData) return
  try {
    fs.mkdirSync(logDir, { recursive: true })
    rotateIfNeeded()
    fs.appendFileSync(logFile, line)
  } catch {
    // диск переполнен/недоступен — хотя бы консоль осталась
  }
}

function rotateIfNeeded(): void {
  try {
    const size = fs.statSync(logFile).size
    if (size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.old`)
  } catch {
    // файла ещё нет
  }
}

/** Файлы журнала от старого к новому — для жалобы с журналами (пункт 5.9). */
export function logFilePaths(): string[] {
  return [`${logFile}.old`, logFile]
}

// Запись-хлебная крошка: не ошибка, но событие, о котором надо будет
// вспомнить при разборе жалобы («куда делся результат»). Пишется в тот же
// файл — иначе смотреть придётся в двух местах.
export function logNote(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}
`
  console.log(`[CanAI:${scope}]`, message)
  writeLine(line)
}

export function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`
  console.error(`[CanAI:${scope}]`, message)
  writeLine(line)
}

// падения процесса: логируем вместо молчаливой смерти; unhandledRejection в
// Node 22 иначе роняет процесс целиком
export function installCrashHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
  })
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err)
    // состояние процесса после такой ошибки ненадёжно — выходим, лаунчер перезапустит
    process.exit(1)
  })
}
