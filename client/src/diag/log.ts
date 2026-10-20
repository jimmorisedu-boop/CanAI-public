import { sanitizeLogData } from './logSanitize.js'
import { clientBuild, formatBuild } from './buildInfo.js'

/**
 * Журнал приложения: что именно оно сделало и что ему ответили.
 *
 * ⚠️ Пишем ВСЕГДА, а показываем — по просьбе. Сбой уже случился к тому
 * моменту, когда человек решает «надо бы посмотреть логи»; включать запись
 * задним числом поздно, поэтому лента копится в памяти вкладки постоянно, а
 * консоль и файл лишь читают её. Стоимость записи — одна очищенная копия
 * данных на событие, поэтому в горячие циклы (кадр камеры, движение мыши)
 * журнал ставить НЕЛЬЗЯ: он для редких событий — сеть, генерация, сохранение.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Области. Список закрыт намеренно: открытый превращается в свалку имён. */
export type LogArea =
  | 'cloud'   // сетевая доска: сокет, отправленные правки, ответы сервера
  | 'gen'     // генерация: запуск, задачи, результаты
  | 'board'   // холст и сохранение локальной доски
  | 'net'     // запросы к своему серверу
  | 'app'     // запуск, экраны, общее

export interface LogEntry {
  seq: number
  at: number
  level: LogLevel
  area: LogArea
  event: string
  data?: Record<string, unknown>
}

const MAX_ENTRIES = 1500
const CONSOLE_KEY = 'canai-log'

const entries: LogEntry[] = []
let seq = 0
let consoleAreas: Set<LogArea> | 'all' | null = null
const listeners = new Set<(entry: LogEntry) => void>()

function readConsoleFilter(): Set<LogArea> | 'all' {
  const raw = (() => {
    try {
      const fromQuery = new URLSearchParams(window.location.search).get('log')
      if (fromQuery !== null) return fromQuery
      return window.localStorage.getItem(CONSOLE_KEY) ?? ''
    } catch {
      return ''
    }
  })()
  if (raw.trim() === '*' || raw.trim() === 'all') return 'all'
  const areas = raw.split(/[,\s]+/u).filter(Boolean) as LogArea[]
  return new Set(areas)
}

function wantsConsole(area: LogArea, level: LogLevel): boolean {
  // Ошибки и предупреждения видны в консоли всегда: до них никто не успевает
  // включить фильтр, а именно они объясняют падение.
  if (level === 'error' || level === 'warn') return true
  if (consoleAreas === null) consoleAreas = readConsoleFilter()
  return consoleAreas === 'all' || consoleAreas.has(area)
}

function time(at: number): string {
  const date = new Date(at)
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function logEvent(
  level: LogLevel,
  area: LogArea,
  event: string,
  data?: unknown,
): void {
  let entry: LogEntry
  try {
    seq += 1
    entry = { seq, at: Date.now(), level, area, event, data: sanitizeLogData(data) }
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  } catch {
    return // журнал не имеет права ронять приложение
  }
  try {
    for (const listener of listeners) listener(entry)
  } catch {
    // подписчик журнала — тем более
  }
  try {
    if (!wantsConsole(area, level)) return
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    const head = `[CanAI ${area}] ${event}`
    if (entry.data) method(head, entry.data)
    else method(head)
  } catch {
    // консоли может не быть (headless-проверки)
  }
}

export const log = {
  debug: (area: LogArea, event: string, data?: unknown) => logEvent('debug', area, event, data),
  info: (area: LogArea, event: string, data?: unknown) => logEvent('info', area, event, data),
  warn: (area: LogArea, event: string, data?: unknown) => logEvent('warn', area, event, data),
  error: (area: LogArea, event: string, data?: unknown) => logEvent('error', area, event, data),
}

/**
 * Повторяющееся событие (отвалилась сеть — и опрос задач бьётся об неё каждые
 * полторы секунды). Пишем первое, дальше не чаще раза в `everyMs`, и всегда
 * говорим, сколько повторов проглотили: журнал должен показывать, что сбой
 * длится, а не вытеснять одной строкой всё остальное.
 */
const repeats = new Map<string, { at: number; skipped: number }>()

export function logRepeating(
  level: LogLevel,
  area: LogArea,
  event: string,
  key: string,
  data?: Record<string, unknown>,
  everyMs = 15_000,
): void {
  const now = Date.now()
  const seen = repeats.get(key)
  if (seen && now - seen.at < everyMs) {
    seen.skipped += 1
    return
  }
  repeats.set(key, { at: now, skipped: 0 })
  logEvent(level, area, event, seen && seen.skipped > 0
    ? { ...data, skippedRepeats: seen.skipped }
    : data)
}

/** Событие снова пошло нормально — следующий сбой должен попасть в журнал. */
export function resetRepeating(key: string): void {
  repeats.delete(key)
}

export function getLogEntries(): LogEntry[] {
  return [...entries]
}

export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearLog(): void {
  entries.length = 0
  repeats.clear()
}

/** Включить вывод в консоль на эту и следующие сессии вкладки. */
export function setConsoleAreas(value: string): void {
  try {
    window.localStorage.setItem(CONSOLE_KEY, value)
  } catch {
    // приватное окно — фильтр проживёт до перезагрузки
  }
  consoleAreas = null
}

export function formatLogEntry(entry: LogEntry): string {
  const head = `${time(entry.at)}  ${entry.level.toUpperCase().padEnd(5)} ${entry.area.padEnd(5)} ${entry.event}`
  if (!entry.data) return head
  let tail: string
  try {
    tail = JSON.stringify(entry.data)
  } catch {
    tail = '[not serializable]'
  }
  return `${head}  ${tail}`
}

/** Текст для файла: шапка со средой + лента. Читается глазами и мной. */
export function dumpLogText(header: Record<string, unknown> = {}): string {
  const lines = [
    `CanAI log captured ${new Date().toLocaleString('en-US')}`,
    `Entries: ${entries.length}${entries.length >= MAX_ENTRIES ? ` (last ${MAX_ENTRIES} kept)` : ''}`,
  ]
  for (const [key, value] of Object.entries({
    URL: safeLocation(),
    Browser: safeUserAgent(),
    // Какая сборка страницы писала журнал (пункт 5.1): без этого разбор
    // жалобы начинается с угадывания, обновился ли человек.
    'Page build': formatBuild(clientBuild()),
    ...header,
  })) {
    if (value !== undefined && value !== null && value !== '') lines.push(`${key}: ${String(value)}`)
  }
  lines.push('')
  for (const entry of entries) lines.push(formatLogEntry(entry))
  return lines.join('\n')
}

function safeLocation(): string {
  try {
    return window.location.href
  } catch {
    return ''
  }
}

function safeUserAgent(): string {
  try {
    return navigator.userAgent
  } catch {
    return ''
  }
}
