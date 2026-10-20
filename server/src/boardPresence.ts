// Кто сейчас держит доску.
//
// Требование: оператор начинает на компьютере и продолжает на планшете. Оба
// клиента пишут одну доску автосейвом, и без разговора о том, кто за рулём,
// вторая вкладка ничего не теряет, но и не продолжает: сервер отвечает 409 и
// делает конфликтную копию, а человек получает вместо одной доски две.
//
// ПРАВИЛО, КОТОРОЕ НЕЛЬЗЯ НАРУШАТЬ: владение — СОВЕТУЕМОЕ. Сервер никогда не
// отказывает в сохранении из-за того, что доску держит кто-то другой. Отказ в
// записи — это риск потерять работу, а конфликтные копии остаются страховкой.
// Решение принимает клиент: увидел чужое владение — ушёл в просмотр.
//
// Живёт только в памяти и НАМЕРЕННО не переживает перезапуск: после рестарта
// сервера доску не держит никто, и это правда.

export interface BoardHolder {
  clientId: string
  device: string
  since: number
  lastSeen: number
}

export interface BoardPresenceAnswer {
  holder: BoardHolder | null
  /** Держит ли доску тот, кто спрашивает. */
  mine: boolean
}

// Планшет засыпает, вкладку сворачивают, сеть моргает — держатель обязан
// протухать сам, иначе доска останется занятой навсегда. Пятнадцать секунд на
// heartbeat, три пропуска подряд — освобождение.
export const BOARD_HOLD_TTL_MS = 45_000

// Держатель и «доска у кого-то открыта» — РАЗНЫЕ вещи, и путать их дорого.
// Свёрнутая вкладка держателем быть не должна (иначе переход на планшет
// требовал бы перехвата), но доска у неё ОТКРЫТА: она по-прежнему сохраняет
// холст, когда туда приезжают результаты. Если считать такую доску ничьей,
// серверная доставка запишет результат под открытым клиентом — и следующее
// его сохранение уедет в конфликтную копию (поймано живым прогоном).
//
// Отсюда второй срок, длиннее: спрятанная вкладка отмечается редко (браузер
// душит её таймеры), поэтому три минуты, а не сорок пять секунд.
export const BOARD_ATTACH_TTL_MS = 180_000

// ⚠️ Сразу после запуска сервер НЕ ЗНАЕТ, какие доски открыты: присутствие
// живёт в памяти, а вкладки, пережившие перезапуск, отметятся не сразу —
// видимая за пятнадцать секунд, спрятанная не чаще раза в минуту (браузер
// душит её таймеры). А при старте как раз доезжают результаты, готовые, пока
// сервер лежал. Поставить их в этот миг значит писать под открытой доской, и
// её следующее сохранение уйдёт в конфликтную копию. Поэтому первые секунды
// считаем занятой любую доску: доставка подождёт свой обычный повтор.
export const PRESENCE_WARMUP_MS = 75_000
let warmupUntil = 0

/** Сервер только что запущен: открытые вкладки ещё не успели отметиться. */
export function startPresenceWarmup(now: number = Date.now()): void {
  warmupUntil = now + PRESENCE_WARMUP_MS
}

export function presenceWarmingUp(now: number = Date.now()): boolean {
  return now < warmupUntil
}

const holders = new Map<string, BoardHolder>()
const attached = new Map<string, Map<string, number>>()

function noteAttached(projectId: string, clientId: string, now: number): void {
  const byClient = attached.get(projectId) ?? new Map<string, number>()
  byClient.set(clientId, now)
  attached.set(projectId, byClient)
}

function forgetAttached(projectId: string, clientId: string): void {
  const byClient = attached.get(projectId)
  if (!byClient) return
  byClient.delete(clientId)
  if (byClient.size === 0) attached.delete(projectId)
}

/** Открыта ли доска хоть где-нибудь — включая свёрнутые вкладки. */
export function boardAttached(projectId: string, now: number = Date.now()): boolean {
  const byClient = attached.get(projectId)
  if (!byClient) return false
  for (const [clientId, seen] of [...byClient]) {
    if (now - seen > BOARD_ATTACH_TTL_MS) byClient.delete(clientId)
  }
  if (byClient.size === 0) {
    attached.delete(projectId)
    return false
  }
  return true
}

/**
 * Занята ли доска кем-то живым.
 *
 * Именно этот вопрос задаёт серверная доставка результата: писать в доску
 * можно, только когда её не держит и не смотрит никто.
 */
export function boardBusy(projectId: string, now: number = Date.now()): boolean {
  return Boolean(boardHolder(projectId, now)) || boardAttached(projectId, now)
}

function fresh(holder: BoardHolder | undefined, now: number): BoardHolder | null {
  if (!holder) return null
  return now - holder.lastSeen <= BOARD_HOLD_TTL_MS ? holder : null
}

/** Кто держит доску прямо сейчас (протухшего не показываем — его уже нет). */
export function boardHolder(projectId: string, now: number = Date.now()): BoardHolder | null {
  const holder = fresh(holders.get(projectId), now)
  if (!holder) holders.delete(projectId)
  return holder
}

/**
 * Перехват: доска переходит к этому клиенту, кто бы её ни держал.
 *
 * Это осознанное действие человека («Перехватить» в карточке), поэтому спорить
 * не с чем. Прежний держатель узнает об этом на ближайшем heartbeat.
 */
export function claimBoard(
  projectId: string,
  clientId: string,
  device: string,
  now: number = Date.now(),
): BoardPresenceAnswer {
  noteAttached(projectId, clientId, now)
  const previous = boardHolder(projectId, now)
  const holder: BoardHolder = {
    clientId,
    device,
    since: previous?.clientId === clientId ? previous.since : now,
    lastSeen: now,
  }
  holders.set(projectId, holder)
  return { holder, mine: true }
}

/**
 * Отметиться. Свободную доску heartbeat занимает сам — это и есть обычный
 * случай «открыл доску, никого нет». Занятую чужим не трогает: клиент увидит
 * чужого держателя и уйдёт в просмотр.
 */
export function heartbeatBoard(
  projectId: string,
  clientId: string,
  device: string,
  now: number = Date.now(),
  visible = true,
): BoardPresenceAnswer {
  // Отмечаем ОТКРЫТОСТЬ всегда — и у спрятанной вкладки тоже.
  noteAttached(projectId, clientId, now)
  if (!visible) {
    // На доску не смотрят: держателем быть перестаём, чтобы другому
    // устройству не пришлось ничего перехватывать.
    const current = boardHolder(projectId, now)
    if (current?.clientId === clientId) holders.delete(projectId)
    return { holder: boardHolder(projectId, now), mine: false }
  }
  const holder = boardHolder(projectId, now)
  if (!holder) return claimBoard(projectId, clientId, device, now)
  if (holder.clientId !== clientId) return { holder, mine: false }
  holder.lastSeen = now
  holder.device = device
  return { holder, mine: true }
}

/**
 * Отпустить доску. Чужое владение не снимаем: закрытая вкладка, опоздавшая с
 * release, не должна выбивать из-за руля того, кто уже перехватил доску.
 */
export function releaseBoard(
  projectId: string,
  clientId: string,
  now: number = Date.now(),
): BoardPresenceAnswer {
  // Уходя, клиент перестаёт быть и держателем, и открытым: доска свободна.
  forgetAttached(projectId, clientId)
  const holder = boardHolder(projectId, now)
  if (holder && holder.clientId === clientId) {
    holders.delete(projectId)
    return { holder: null, mine: false }
  }
  return { holder, mine: false }
}

/** Для галереи: на карточке видно, что доска открыта на другом устройстве. */
export function listBoardHolders(now: number = Date.now()): Array<{ projectId: string; holder: BoardHolder }> {
  const out: Array<{ projectId: string; holder: BoardHolder }> = []
  for (const projectId of [...holders.keys()]) {
    const holder = boardHolder(projectId, now)
    if (holder) out.push({ projectId, holder })
  }
  return out
}

/**
 * Сколько вкладок держат доску открытой и кто за рулём — для журнала.
 *
 * ⚠️ Считаются ИМЕНА держателей, а не вкладки: если две вкладки представились
 * одним именем, здесь будет одна. Ровно это и надо видеть рядом с конфликтом.
 */
export function boardPresenceSummary(
  projectId: string,
  now: number = Date.now(),
): { openTabs: number; holder: string | null } {
  boardAttached(projectId, now)
  return {
    openTabs: attached.get(projectId)?.size ?? 0,
    holder: boardHolder(projectId, now)?.clientId ?? null,
  }
}

/** Только для тестов: между проверками память не должна протекать. */
/** Только для тестов: между проверками память не должна протекать. */
export function resetBoardPresence(): void {
  holders.clear()
  attached.clear()
  warmupUntil = 0
}
