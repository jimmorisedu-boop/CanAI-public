import type { PublicEditSession } from '../../api'

/**
 * Что из внешних правок ПОКАЗЫВАТЬ человеку.
 *
 * ⚠️ Правило пользователя (07.09.2026): «нужны только оповещения, где нужно
 * участие человека». До этого угол сообщал обо всём подряд — «открыт в
 * редакторе», «правка готова», «правки применены: 6 файлов». Последнее особенно
 * бессмысленно: правка УЖЕ на холсте, её видно глазами, а карточка занимала
 * место и требовала «Скрыть».
 *
 * Осталось два случая, и оба требуют решения:
 *   • сессия сломалась (`broken`) — доска удалена, файл не читается;
 *   • правка готова, но ждёт ЧУЖУЮ доску (`ready` не на текущей доске) — её
 *     надо открыть, иначе правка никуда не приедет.
 *
 * Всё остальное идёт молча. Ответ на F2 — сам открывшийся редактор, а живое
 * слежение видно в «Задачах» в шапке, оттуда же его и прекращают.
 */

/** Момент запуска приложения.
 *
 *  Именно модульная переменная, а не время монтирования: App пересобирает
 *  дерево при переходе галерея↔доска, и время монтирования сбросилось бы
 *  вместе с ним. */
const APP_STARTED_AT = Date.now()

export interface EditNoticeMemory {
  /** Когда сообщение о конкретной версии показалось впервые. */
  shownAt: Map<string, number>
  /** Что убрали крестиком — до появления новой версии. */
  dismissed: Set<string>
  /** Момент запуска: сессии старше него подняты из прошлого запуска. */
  startedAt: number
}

export function createEditNoticeMemory(startedAt: number = APP_STARTED_AT): EditNoticeMemory {
  return { shownAt: new Map(), dismissed: new Set(), startedAt }
}

/** Ключ версии сообщения: новая правка того же файла показывается заново. */
export function editNoticeKey(session: PublicEditSession): string {
  const version = session.state === 'broken'
    ? session.error ?? 'broken'
    : session.state === 'waiting'
      ? session.createdAt
      : session.lastMtime
  return `${session.id}:${session.state}:${version}`
}

/** Нужно ли человеку что-то решать по этой сессии. */
export function needsAttention(
  session: PublicEditSession,
  currentProjectId?: string | null,
): boolean {
  if (session.state === 'broken') return true
  // «Готово» само по себе не новость: на текущей доске правка применится
  // сама. А вот правка для ДРУГОЙ доски так и останется лежать, пока ту не
  // откроют — об этом сказать надо.
  return session.state === 'ready' && session.projectId !== currentProjectId
}

/** Само правило: что из активных сессий сейчас показывать. */
export function visibleEditNotices(
  sessions: PublicEditSession[],
  memory: EditNoticeMemory,
  now: number,
  currentProjectId?: string | null,
): PublicEditSession[] {
  const visible: PublicEditSession[] = []
  for (const session of sessions) {
    if (!needsAttention(session, currentProjectId)) continue
    const key = editNoticeKey(session)
    if (memory.dismissed.has(key)) continue
    if (!memory.shownAt.has(key)) memory.shownAt.set(key, now)
    visible.push(session)
  }
  return visible
}

/** Скрыть сообщение, НЕ останавливая слежение: это разные действия. */
export function dismissEditNotice(memory: EditNoticeMemory, session: PublicEditSession): void {
  memory.dismissed.add(editNoticeKey(session))
}

/** Забыть сессию целиком — например, когда слежение остановлено. */
export function forgetEditNotices(memory: EditNoticeMemory, sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of [...memory.shownAt.keys()]) if (key.startsWith(prefix)) memory.shownAt.delete(key)
  for (const key of [...memory.dismissed]) if (key.startsWith(prefix)) memory.dismissed.delete(key)
}
