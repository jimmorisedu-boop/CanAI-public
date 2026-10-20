import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

// Дневной лимит подтверждённых ПЛАТНЫХ решений агентов с планшета
// (пункт плана аудита 3: «подписанное согласие на approve решений агентов»).
//
// Это родной брат tabletDailyLimit.ts, но для карточек согласования агента:
// approve, за которым стоит ОПЛАЧИВАЕМАЯ генерация fal, запущенная с планшета
// по локальной сети. Счётчик живёт СВОИМ файлом (data/agent-approve-count.json)
// и под СВОИМ замком — генерации и подтверждения не должны тягаться за один
// замок, и сброс одного не должен трогать другой.
//
// В день несколько десятков платных подтверждений — это осознанный рабочий
// поток, а вот сотни с планшета уже похожи на случайность или пробой доступа.
// Ноль = выключено (неограниченно). Счётчик переживает перезапуск сервера и
// сам сбрасывается в полночь по локальному времени.

interface ApproveDailyCount {
  /** Дата в формате YYYY-MM-DD по локальному времени. */
  date: string
  /** Сколько платных подтверждённых решений уже списано с планшета за день. */
  count: number
}

const counterFile = path.join(path.dirname(config.settingsFile), 'agent-approve-count.json')

function localDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readCounter(): Promise<ApproveDailyCount> {
  try {
    const raw = JSON.parse(await fs.readFile(counterFile, 'utf8')) as Partial<ApproveDailyCount>
    return { date: typeof raw.date === 'string' ? raw.date : '', count: typeof raw.count === 'number' ? raw.count : 0 }
  } catch (err) {
    if (isNotFound(err)) return { date: '', count: 0 }
    // Битый файл не должен останавливать подтверждение — начинаем день с нуля.
    return { date: '', count: 0 }
  }
}

async function writeState(state: ApproveDailyCount): Promise<void> {
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
function rollover(state: ApproveDailyCount, today: string): ApproveDailyCount {
  return state.date === today ? state : { date: today, count: 0 }
}

/**
 * Забрать с планшета одно подтверждение ПЛАТНОГО решения агента под лимит дня.
 * Возвращает true, если заявка принята (счётчик списан); false — если лимит
 * за сегодня исчерпан. Собственный замок модуля не даёт двум одновременным
 * подтверждениям проскочить лимит. Звать ТОЛЬКО для реально оплачиваемого
 * одобрения (approved + generationSpec + generationBudget) и только после
 * проверки согласия.
 */
export async function takePaidApproveFromTablet(limit: number, now = new Date()): Promise<boolean> {
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

/** Сколько платных подтверждений с планшета уже списано за сегодня. For UI. */
export async function tabletApproveUsed(now = new Date()): Promise<number> {
  const today = localDateKey(now)
  return withCounterLock(async () => {
    const state = rollover(await readCounter(), today)
    return state.count
  })
}

let approveQueue: Promise<unknown> = Promise.resolve()
function withCounterLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = approveQueue.then(fn, fn)
  approveQueue = next.then(() => undefined, () => undefined)
  return next
}