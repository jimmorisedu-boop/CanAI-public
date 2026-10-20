import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

// Ежедневный лимит генераций с планшета (пункт плана аудита 3).
//
// Держим простой счётчик «сколько локальных оплачиваемых генераций запущено
// с планшета сегодня». Счётчик переживает перезапуск сервера (лежит рядом с
// настройками, data/tablet-daily-count.json) и сам сбрасывается в полночь по
// локальному времени — это единственное место, которое знает про календарную
// дату.
//
// Ограничение одно на планшет целиком, как и просил пользователь: «простой
// ежедневный лимит (настройка)». Ноль = выключено (неограниченно).
//
// Отдельные задачи с глубинным бюджетом (агенты) сюда не входят — у них свой
// spendBudget на приглашение, и это другой механизм. Здесь — быстрый прямой
// расход с планшета через POST /generate.

interface DailyCount {
  /** Дата в формате YYYY-MM-DD по локальному времени. */
  date: string
  /** Сколько локальных генераций уже списано с планшета за этот день. */
  count: number
}

const counterFile = path.join(path.dirname(config.settingsFile), 'tablet-daily-count.json')

function localDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readCounter(): Promise<DailyCount> {
  try {
    const raw = JSON.parse(await fs.readFile(counterFile, 'utf8')) as Partial<DailyCount>
    return { date: typeof raw.date === 'string' ? raw.date : '', count: typeof raw.count === 'number' ? raw.count : 0 }
  } catch (err) {
    if (isNotFound(err)) return { date: '', count: 0 }
    // Битый файл не должен рушить генерацию — начинаем день с нуля.
    return { date: '', count: 0 }
  }
}

async function writeState(state: DailyCount): Promise<void> {
  await fs.mkdir(path.dirname(counterFile), { recursive: true })
  const tmp = `${counterFile}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(state))
    await fs.rename(tmp, counterFile)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

// Календарный день уже снова, а счётчик за вчера всё ещё в файле — сбрасываем.
function rollover(state: DailyCount, today: string): DailyCount {
  return state.date === today ? state : { date: today, count: 0 }
}

/**
 * Забрать с планшета одну локальную генерацию под лимит дня.
 * Возвращает true, если заявка принята (счётчик списан); false — если лимит
 * за сегодня исчерпан. Собственный замок модуля не даёт двум одновременным
 * запросам проскочить лимит.
 */
export async function takeLocalGenerationFromTablet(limit: number, now = new Date()): Promise<boolean> {
  if (!(limit > 0)) return true // лимит выключен — всегда можно
  const today = localDateKey(now)
  return withCounterLock(async () => {
    const state = rollover(await readCounter(), today)
    if (state.count >= limit) return false
    state.count += 1
    await writeState(state)
    return true
  })
}

/** Сколько локальных генераций с планшета уже списано за сегодня. Для UI. */
export async function tabletDailyUsed(now = new Date()): Promise<number> {
  const today = localDateKey(now)
  return withCounterLock(async () => {
    const state = rollover(await readCounter(), today)
    return state.count
  })
}

let counterQueue: Promise<unknown> = Promise.resolve()
function withCounterLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = counterQueue.then(fn, fn)
  counterQueue = next.then(() => undefined, () => undefined)
  return next
}