import { useCallback, useState, useSyncExternalStore } from 'react'
import { IconChats, IconPlus, IconTrash } from '../ui/icons'
import { notify } from '../spaces/canvas/notifications'
import { promptChatStore } from '../spaces/canvas/promptChatStore'
import { TabletDialog } from './TabletDialog'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


// Диалоги помощника на планшете.
//
// ⚠️ Их не было вовсе: вкладка «Помощник» показывала ОДИН разговор — тот, что
// сервер отдал первым, — и начать новый было нечем (жалоба 14.09.2026).
// На компьютере этим заведует шапка ленты (`AssistantShelf`): список слева,
// название посередине, «+» справа. Здесь та же работа, но одной строкой и
// пальцем: название открывает список, «+» заводит новый разговор.
//
// Хранилище общее с компьютером (`promptChatStore`), поэтому ни своего
// состояния, ни второго набора правил тут нет — только раскладка под палец.

const TITLE_FALLBACK = 'New conversation'

function when(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
}

export function TabletAssistantChats({ projectId }: { projectId: string }) {
  const t = useT()
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => promptChatStore.subscribe(projectId, listener), [projectId]),
    useCallback(() => promptChatStore.getSnapshot(projectId), [projectId]),
  )
  const [listOpen, setListOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Удаление переспрашивает вторым нажатием и разряжается само — тот же приём,
  // что в корзине досок: от промаха защищает второе нажатие, а не запрет.
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const title = snapshot.active?.meta.title?.trim() || t(TITLE_FALLBACK)

  const run = async (work: Promise<unknown>, fallback: string): Promise<boolean> => {
    setBusy(true)
    try {
      await work
      return true
    } catch (error) {
      notify({ kind: 'error', message: tabletSystemMessage(error, t(fallback)) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (await run(promptChatStore.createConversation(projectId), 'Could not create conversation')) {
      setListOpen(false)
    }
  }

  return (
    <>
      <div className="tablet-assistant-chats" role="group" aria-label={t('Assistant conversations')}>
        <button
          type="button"
          className="ui-btn quiet tablet-assistant-chat-open"
          aria-label={t('Assistant conversations: {0}', { 0: title })}
          aria-haspopup="dialog"
          onClick={() => setListOpen(true)}
        >
          <IconChats size={17} />
          <span className="tablet-assistant-chat-name">{title}</span>
        </button>
        <button
          type="button"
          className="ui-btn quiet icon-only tablet-assistant-chat-new"
          aria-label={t('New conversation')}
          title={t('New conversation')}
          disabled={busy}
          onClick={() => void create()}
        >
          <IconPlus size={18} />
        </button>
      </div>

      {listOpen && (
        <TabletDialog
          title={t('Assistant conversations')}
          onClose={() => { setListOpen(false); setConfirmId(null) }}
          actions={
            <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void create()}>
              <IconPlus size={18} />  {t('New conversation')}
            </button>
          }
        >
          <div className="tablet-chat-list">
            {snapshot.list.length === 0 && (
              <p className="tablet-inline-empty">{t('No conversations yet — start a new one.')}</p>
            )}
            {snapshot.list.map((item) => (
              <div
                className={`tablet-chat-row ${item.id === snapshot.activeId ? 'on' : ''}`}
                key={item.id}
              >
                <button
                  type="button"
                  className="ui-btn tablet-chat-pick"
                  aria-current={item.id === snapshot.activeId}
                  disabled={busy}
                  onClick={() => {
                    if (item.id === snapshot.activeId) { setListOpen(false); return }
                    void run(promptChatStore.selectConversation(projectId, item.id), 'Could not open conversation')
                      .then((ok) => { if (ok) setListOpen(false) })
                  }}
                >
                  <strong>{item.title?.trim() || TITLE_FALLBACK}</strong>
                  <span className="tablet-chat-note">
                    {[when(item.updatedAt), item.preview].filter(Boolean).join(' · ')}
                  </span>
                </button>
                <button
                  type="button"
                  className="ui-btn danger tablet-chat-drop"
                  aria-label={t('Delete conversation “{0}”', { 0: item.title?.trim() || TITLE_FALLBACK })}
                  disabled={busy}
                  onClick={() => {
                    if (confirmId !== item.id) {
                      setConfirmId(item.id)
                      window.setTimeout(
                        () => setConfirmId((current) => (current === item.id ? null : current)),
                        4000,
                      )
                      return
                    }
                    setConfirmId(null)
                    void run(promptChatStore.trash(projectId, item.id), 'Could not delete conversation')
                  }}
                >
                  <IconTrash size={18} /> {confirmId === item.id ? t('Are you sure?') : ''}
                </button>
              </div>
            ))}
          </div>
        </TabletDialog>
      )}
    </>
  )
}
