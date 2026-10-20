/**
 * Есть ли в доске новое, чего человек ещё не видел.
 *
 * ⚠️ Значок непрочитанного живёт в ШАПКЕ ОТКРЫТОЙ доски, поэтому о новом
 * замечании узнавал только тот, кто эту доску уже открыл. Вопрос заказчика был
 * прямым: «а есть ли уведомления у тебя, что я что-то написала» (09.09.2026) —
 * и ответ был «нет». Метка на карточке в галерее закрывает ровно этот разрыв.
 *
 * ⚠️ Всплывашки тут не будет: правило проекта — оповещать только там, где нужно
 * участие человека. Замечание ждёт ответа, но не сию секунду, поэтому метка, а
 * не окно поверх работы.
 *
 * ⚠️ Отметку «видел» хранит браузер (localStorage), и это осознанно: она про
 * одного человека на одном устройстве. Заводить её на сервере значило бы
 * складывать туда состояние глаз, а не доски.
 */

const PREFIX = 'canai.board-notes-seen.'

export function boardSeenKey(projectId: string): string {
  return `${PREFIX}${projectId}`
}

export function readBoardSeen(projectId: string): number {
  try {
    const value = Number(localStorage.getItem(boardSeenKey(projectId)))
    return Number.isFinite(value) ? value : 0
  } catch {
    // Приватное окно или запрет на хранилище: метка просто не погаснет.
    return 0
  }
}

export function writeBoardSeen(projectId: string, value: number): void {
  try {
    localStorage.setItem(boardSeenKey(projectId), String(value))
  } catch {
    // См. выше: молча, это удобство, а не состояние доски.
  }
}

/**
 * Ждёт ли доска внимания. `commentsAt` — время последней ЧУЖОЙ записи; старый
 * сервер его не присылает, и тогда мы ничего не обещаем.
 */
export function boardHasUnseenNotes(commentsAt: number | null | undefined, seenAt: number): boolean {
  return typeof commentsAt === 'number' && Number.isFinite(commentsAt) && commentsAt > seenAt
}
