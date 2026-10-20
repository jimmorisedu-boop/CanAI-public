import { api } from '../../../api'
import type { ProjectSource, SessionDraft } from '../../../types'
import { deviceName } from './deviceIdentity'

// Черновик сеанса: то, что человек уже набрал, но ещё не запустил.
//
// Пишется тем же приёмом, что и холст, — с дебаунсом и «последнее побеждает».
// Отдельной защиты от гонки двух устройств здесь нет намеренно: это положение
// рычагов, а не материал. Проиграть в такой гонке значит увидеть промпт с
// другого устройства, а не потерять картинку.

export const DRAFT_DEBOUNCE_MS = 700

let timer: number | null = null
let pending: { projectId: string; draft: SessionDraft; source: ProjectSource } | null = null
let lastSaved = ''
let inFlight: Promise<unknown> = Promise.resolve()

function key(source: ProjectSource, projectId: string, draft: SessionDraft): string {
  return `${source}:${projectId}:${JSON.stringify(draft)}`
}

async function flushOne(next: { projectId: string; draft: SessionDraft; source: ProjectSource } | null): Promise<void> {
  if (!next) return
  const signature = key(next.source, next.projectId, next.draft)
  if (signature === lastSaved) return
  try {
    const save = api.saveSessionDraft
    await save(next.projectId, next.draft, deviceName())
    lastSaved = signature
  } catch {
    // Черновик не сохранился — не беда и не повод шуметь: следующая правка
    // попробует снова. Сообщать о такой мелочи значит приучать не читать
    // сообщения вовсе.
  }
}

async function flushNow(): Promise<void> {
  const next = pending
  pending = null
  await flushOne(next)
}

/** Запомнить черновик. Частые правки схлопываются в одну запись. */
export function scheduleSessionDraftSave(
  projectId: string,
  draft: SessionDraft,
  source: ProjectSource = 'local',
): void {
  pending = { projectId, draft, source }
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    inFlight = inFlight.then(flushNow, flushNow)
  }, DRAFT_DEBOUNCE_MS)
}

/** Дописать немедленно — при уходе с доски и когда вкладку сворачивают. */
export function flushSessionDraft(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  // Забираем pending синхронно. При смене доски React сначала вызывает cleanup
  // (он ставит этот flush в очередь), а затем новый effect очищает память; если
  // оставить чтение до microtask, resetSessionDraftMemory() успеет удалить
  // старый черновик.
  const next = pending
  pending = null
  inFlight = inFlight.then(() => flushOne(next), () => flushOne(next))
  return inFlight.then(() => undefined)
}

/**
 * Забыть, что уже сохранено. Зовётся при смене доски: иначе одинаковый на вид
 * черновик другой доски посчитался бы уже записанным и не сохранился.
 */
export function resetSessionDraftMemory(): void {
  lastSaved = ''
  pending = null
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

export async function loadSessionDraft(
  projectId: string,
  source: ProjectSource = 'local',
): Promise<{ draft: SessionDraft; device: string; updatedAt: number } | null> {
  try {
    const answer = await api.loadSessionDraft(projectId)
    if (!answer.draft) return null
    // Считаем загруженное уже сохранённым: иначе первое же касание поля
    // записало бы обратно ровно то, что только что прочитали.
    lastSaved = key(source, projectId, answer.draft)
    return {
      draft: answer.draft,
      device: answer.device ?? 'another device',
      updatedAt: answer.updatedAt ?? 0,
    }
  } catch {
    return null
  }
}
