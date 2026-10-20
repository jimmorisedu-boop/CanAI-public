export const LOST_LOCAL_LAUNCH = "Failed to restore startup state. Check the tasks before repeating."

export const ORPHANED_LAUNCH = "The launch was interrupted: communication with this generation was lost. The card can be removed."

/**
 * Сколько ждать номер задачи, прежде чем признать запуск брошенным.
 *
 * Номер приходит через секунды после нажатия: сервер заводит задачу сразу, а
 * референсы доски копирует у себя. Полчаса — с большим запасом, в том числе на
 * расхождение часов: время старта карточке ставит устройство, которое её
 * запустило, а сравнивает — то, которое открыло доску.
 */
export const ORPHAN_LAUNCH_AFTER_MS = 30 * 60_000

/**
 * Карточка «идёт генерация», за которой следить нечем.
 *
 * ⚠️ Номер задачи карточке ставит вкладка, которая её запустила. Закрылась она
 * (или упала) раньше, чем номер пришёл, — и карточка крутится у всех, кто
 * открывает доску, вечно: у неё нет задачи, которую можно спросить. Так на
 * сетевой доске висели десять карточек от 23.09 (найдено 26.09.2026).
 */
export function isOrphanedLaunch(
  pending: {
    jobId?: string
    status: string
    taskType?: string
    transient?: boolean
    startedAt?: number
  },
  now: number,
): boolean {
  return pending.status === 'loading'
    && !pending.jobId
    && pending.transient !== true
    && pending.taskType !== 'media-import'
    && typeof pending.startedAt === 'number'
    && Number.isFinite(pending.startedAt)
    && now - pending.startedAt > ORPHAN_LAUNCH_AFTER_MS
}

/**
 * ⚠️ Номер `local:` носит и заглушка ИДУЩЕЙ местной работы — скетч, обрезка,
 * кадр из клипа (`startLocalWork`). Она `transient`: живёт только в этой
 * вкладке, в доску не сохраняется и потеряться не может. Без этой проверки
 * планшет показывал такую карточку сбоем сразу, пока работа ещё шла, а
 * переподключение сетевой доски помечало её сбоем для всех.
 */
export function isLostLocalLaunch(pending: {
  jobId?: string
  status: string
  taskType?: string
  transient?: boolean
}): boolean {
  return pending.status === 'loading'
    && pending.transient !== true
    && pending.taskType !== 'media-import'
    && pending.jobId?.startsWith('local:') === true
}
