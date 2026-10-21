import { useEffect, useRef } from 'react'
import type { PublicEditSession } from '../../api'
import { announce } from '../../ui/announce'
import type { ExternalEditSnapshot } from './externalEditRegistry'
import { editNoticeGroupText, groupEditNotices } from './editNoticeGroups'
import { useEditNotices } from './useEditNotices'
import { systemErrorMessage } from '../../ui/systemMessage'
import { useT } from '../../i18n/context.js'


export interface ExternalEditStatusHostProps {
  snapshot: ExternalEditSnapshot
  currentProjectId: string | null
  onOpenProject(projectId: string): void
  onOpenTrash(projectId: string): void
  onRevealFile(src: string): void
  onStop(sessionId: string): void
}

export interface ExternalEditAnnouncement {
  message: string
  priority: 'polite' | 'assertive'
}

// App switches between gallery and editor roots, so the host can remount while
// the same durable session stays unchanged. Keep spoken fingerprints at module
// scope to avoid announcing the same save again after ordinary navigation.
const browserAnnouncements = new Set<string>()

function projectLabel(session: PublicEditSession): string {
  return session.projectName ? `«${session.projectName}»` : "remote board"
}

function sessionAnnouncement(session: PublicEditSession): ExternalEditAnnouncement {
  if (session.state === 'broken') {
    return {
      message: session.error ? systemErrorMessage(session.error) : "Failed to continue external editing",
      priority: 'assertive',
    }
  }
  if (session.state === 'ready') {
    return {
      message: `Edit ready for board ${projectLabel(session)}`,
      priority: 'polite',
    }
  }
  if (session.state === 'applied') {
    return {
      message: `Edit applied on board ${projectLabel(session)}`,
      priority: 'polite',
    }
  }
  return {
    message: `"${session.sourceName}" is open in the editor - waiting to save`,
    priority: 'polite',
  }
}

export function externalEditAnnouncement(
  snapshot: ExternalEditSnapshot,
  seen: Set<string>,
): ExternalEditAnnouncement | null {
  const messages: ExternalEditAnnouncement[] = []
  for (const session of snapshot.sessions) {
    const version = session.state === 'broken'
      ? session.error ?? ''
      : session.state === 'ready' || session.state === 'applied'
        ? session.lastMtime
        : session.createdAt
    const key = `${session.id}:${session.state}:${version}`
    if (seen.has(key)) continue
    seen.add(key)
    messages.push(sessionAnnouncement(session))
  }
  if (messages.length === 0) return null
  return {
    message: messages.map((item) => item.message).join('. '),
    priority: messages.some((item) => item.priority === 'assertive') ? 'assertive' : 'polite',
  }
}

function cardText(session: PublicEditSession): { title: string; detail: string } {
  if (session.state === 'broken') {
    return {
      title: "Failed to continue external editing",
      detail: session.error ? systemErrorMessage(session.error) : "The session requires attention.",
    }
  }
  if (session.state === 'ready') {
    return {
      title: `Edit ready for board ${projectLabel(session)}`,
      detail: "Open the original board and the edits will be applied and saved automatically.",
    }
  }
  if (session.state === 'applied') {
    return {
      title: `Edit applied on board ${projectLabel(session)}`,
      detail: "The tracking continues until it clearly stops.",
    }
  }
  return {
    title: `"${session.sourceName}" is open in the editor`,
    detail: `I'm waiting for saving (Ctrl+S) for the ${projectLabel(session)} board.`,
  }
}

export function ExternalEditStatusHost({
  snapshot,
  currentProjectId,
  onOpenProject,
  onOpenTrash,
  onRevealFile,
  onStop,
}: ExternalEditStatusHostProps) {
  const t = useT()
  const announced = useRef(browserAnnouncements)
  useEffect(() => {
    const next = externalEditAnnouncement(snapshot, announced.current)
    if (next) announce(next.message, next.priority)
  }, [snapshot])

  // Сообщения о внешних правках приходят СЮДА, все до одного, включая правки
  // текущей доски: место у них одно — общий угол (решение пользователя
  // 19.08.2026 «всё в одном углу»). Раньше свои показывались полоской над
  // промпт-баром, чужие — карточкой в другом углу, и глаз искал каждый раз
  // заново. Дубля при этом не возникает: полоски над холстом больше нет.
  //
  // ⚠️ Сюда попадает НЕ всё подряд, а только то, где нужно решение человека
  // (см. externalEditNotices): сломанная сессия и правка, ждущая чужую доску.
  // «Открыт в редакторе» и «правки применены» больше не показываются вовсе —
  // первое подтверждает сам открывшийся редактор, второе видно на холсте.
  // Слежение идёт молча, а увидеть и прекратить его можно в «Задачах» в шапке.
  const { visible, dismiss, forget } = useEditNotices(snapshot.sessions, currentProjectId)
  if (snapshot.status !== 'error' && visible.length === 0) return null

  return (
    <aside className="external-edit-status-host" aria-label={t('External edits')}>
      {snapshot.status === 'error' && (
        <div className="external-edit-status-card connection" role="status" aria-live="polite">
          <strong>{t('No connection to external editor')}</strong>
          <span>{snapshot.error ? systemErrorMessage(snapshot.error) : t('Sessions saved. I will reconnect automatically.')}</span>
        </div>
      )}
      {/* Карточки об одном и том же складываются в одну с числом: у группы
          общие доска, состояние и потому общий набор кнопок. Иначе шесть
          файлов, открытых в Фотошопе, давали шесть одинаковых карточек и
          занимали весь угол экрана (жалоба 19.08.2026). */}
      {groupEditNotices(visible).map((group) => {
        const session = group.sessions[0]
        const many = group.sessions.length > 1
        const text = cardText(session)
        const broken = group.state === 'broken'
        return (
          <section
            key={group.key}
            className={`external-edit-status-card ${group.state}`}
            role={broken ? 'alert' : 'status'}
            aria-live={broken ? 'assertive' : 'polite'}
          >
            <strong>{many ? editNoticeGroupText(group) : text.title}</strong>
            <span>{text.detail}</span>
            {many && (
              <ul className="edit-notice-list">
                {group.sessions.map((item) => (
                  <li key={item.id}><span title={item.sourceName}>{item.sourceName}</span></li>
                ))}
              </ul>
            )}
            <div className="external-edit-status-actions">
              {session.projectStatus === 'active' && session.projectId !== currentProjectId && (
                <button type="button" onClick={() => onOpenProject(session.projectId)}>{t('Open board')}</button>
              )}
              {session.projectStatus === 'trashed' && (
                <button type="button" onClick={() => onOpenTrash(session.projectId)}>{t('Open trash')}</button>
              )}
              {/* Показать в папке — действие про КОНКРЕТНЫЙ файл, поэтому оно
                  есть только у одиночной карточки: у группы имена в списке. */}
              {session.projectStatus === 'missing' && !many && (
                <button type="button" onClick={() => onRevealFile(session.url)}>{t('Show file in folder')}</button>
              )}
              <button
                type="button"
                onClick={() => {
                  for (const item of group.sessions) {
                    forget(item.id)
                    onStop(item.id)
                  }
                }}
              >
                Stop tracking
              </button>
              {!broken && (
                <button
                  type="button"
                  className="external-edit-status-hide"
                  onClick={() => { for (const item of group.sessions) dismiss(item) }}
                >

                  {t('Hide')}
                </button>
              )}
            </div>
          </section>
        )
      })}
    </aside>
  )
}
