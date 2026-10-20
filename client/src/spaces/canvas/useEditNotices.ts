import { useCallback, useMemo, useRef, useState } from 'react'
import type { PublicEditSession } from '../../api'
import {
  createEditNoticeMemory,
  dismissEditNotice,
  forgetEditNotices,
  visibleEditNotices,
} from './externalEditNotices'

/**
 * Обвязка над правилом видимости сообщений о внешних правках.
 *
 * Таймера здесь больше нет: сообщения не гаснут по времени, потому что
 * показываются только те, где нужно решение человека, — а решение не
 * протухает само (см. externalEditNotices).
 */
export function useEditNotices(sessions: PublicEditSession[], currentProjectId?: string | null) {
  const memory = useRef(createEditNoticeMemory())
  const [, forceRender] = useState(0)

  const visible = useMemo(
    () => visibleEditNotices(sessions, memory.current, Date.now(), currentProjectId),
    // Перерасчёт по новому снапшоту и по «скрыть»/«забыть» ниже.
    [sessions, currentProjectId, forceRender],
  )

  const dismiss = useCallback((session: PublicEditSession) => {
    dismissEditNotice(memory.current, session)
    forceRender((value) => value + 1)
  }, [])

  const forget = useCallback((sessionId: string) => {
    forgetEditNotices(memory.current, sessionId)
    forceRender((value) => value + 1)
  }, [])

  return { visible, dismiss, forget }
}
