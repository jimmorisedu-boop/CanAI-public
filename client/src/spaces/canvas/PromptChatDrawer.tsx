import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  IconClose,
  IconEdit,
  IconMenu,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '../../ui/icons'
import {
  conversationStatus,
  filterAndSortConversations,
  relativeConversationTime,
  shouldShowConversationSearch,
} from './promptChatViewModel'
import type { PromptChatSummary } from './promptChatTypes'
import { useT } from '../../i18n/context.js'


export interface PromptChatDrawerProps {
  open: boolean
  conversations: PromptChatSummary[]
  activeId: string | null
  trash: PromptChatSummary[]
  onClose(): void
  onCreate(): void | Promise<void>
  onSelect(id: string): void | Promise<void>
  onRename(id: string, title: string): void | Promise<void>
  onTrash(id: string): void | Promise<void>
  onRestore(id: string): void | Promise<void>
  onPermanentDelete(id: string): void | Promise<void>
}

interface UndoState {
  id: string
  title: string
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
  )].filter((element) => element.offsetParent !== null)
}

export function PromptChatDrawer({
  open,
  conversations,
  activeId,
  trash,
  onClose,
  onCreate,
  onSelect,
  onRename,
  onTrash,
  onRestore,
  onPermanentDelete,
}: PromptChatDrawerProps) {
  const t = useT()
  const drawerRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [undo, setUndo] = useState<UndoState | null>(null)
  const [permanent, setPermanent] = useState<PromptChatSummary | null>(null)
  const visible = useMemo(
    () => filterAndSortConversations(conversations, query),
    [conversations, query],
  )

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>('[data-drawer-focus]')?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [undo])

  if (!open) return null

  function closeTransient(): boolean {
    if (permanent) {
      setPermanent(null)
      return true
    }
    if (renameId) {
      setRenameId(null)
      return true
    }
    if (menuId) {
      setMenuId(null)
      return true
    }
    return false
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!closeTransient()) onClose()
      return
    }
    if (event.key === 'Tab') {
      const items = focusable(event.currentTarget)
      if (items.length === 0) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (current <= 0 ? items.length - 1 : current - 1)
        : (current < 0 || current === items.length - 1 ? 0 : current + 1)
      event.preventDefault()
      items[next].focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-conversation-row]')]
    const current = rows.findIndex((row) => row === document.activeElement)
    if (current < 0) return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    rows[(current + direction + rows.length) % rows.length]?.focus()
  }

  function clickOutside(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose()
  }

  function startRename(item: PromptChatSummary): void {
    setMenuId(null)
    setRenameId(item.id)
    setRenameValue(item.title)
  }

  function saveRename(item: PromptChatSummary): void {
    const title = renameValue.trim()
    if (title && title !== item.title) onRename(item.id, title)
    setRenameId(null)
  }

  async function moveToTrash(item: PromptChatSummary): Promise<void> {
    setMenuId(null)
    await onTrash(item.id)
    setUndo({ id: item.id, title: item.title })
  }

  return (
    <div className="prompt-chat-drawer-layer" onPointerDown={clickOutside}>
      <aside
        ref={drawerRef}
        className="prompt-chat-drawer"
        role="dialog"
        aria-modal="false"
        aria-label={t('Chats')}
        onKeyDown={handleKeyDown}
      >
        <header className="prompt-chat-drawer-head">
          <strong>{t('Chats')}</strong>
          <button className="icon-btn" aria-label={t('Close chats')} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <button
          className="prompt-chat-new"
          data-drawer-focus
          onClick={() => {
            onCreate()
            onClose()
          }}
        >
          <IconPlus size={16} />
          <span>{t('New chat')}</span>
        </button>

        {shouldShowConversationSearch(conversations) && (
          <label className="prompt-chat-search">
            <IconSearch size={15} aria-hidden="true" />
            <input
              aria-label={t('Search by title')}
              placeholder={t('Find chat')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}

        <div className="prompt-chat-conversation-list" role="list">
          {visible.map((item) => {
            const indicator = conversationStatus(item)
            const editing = renameId === item.id
            return (
              <article
                key={item.id}
                className={`prompt-chat-conversation${item.id === activeId ? ' active' : ''}`}
                role="listitem"
              >
                {editing ? (
                  <input
                    className="prompt-chat-rename"
                    aria-label={t('New chat name “{0}”', { 0: item.title })}
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => saveRename(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        saveRename(item)
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        setRenameId(null)
                      }
                    }}
                  />
                ) : (
                  <button
                    className="prompt-chat-conversation-main"
                    data-conversation-row
                    aria-current={item.id === activeId ? 'true' : undefined}
                    onClick={() => {
                      onSelect(item.id)
                      onClose()
                    }}
                  >
                    <span className="prompt-chat-conversation-copy">
                      <strong>{item.title}</strong>
                      <small>{item.preview || "Empty chat"}</small>
                    </span>
                    <span className="prompt-chat-conversation-meta">
                      {relativeConversationTime(item.updatedAt)}
                      {indicator.kind !== 'none' && (
                        <i className={`prompt-chat-indicator ${indicator.kind}`} title={indicator.label}>
                          <span className="sr-only">{indicator.label}</span>
                        </i>
                      )}
                    </span>
                  </button>
                )}
                <button
                  className="prompt-chat-row-menu icon-btn"
                  aria-label={t('Chat actions “{0}”', { 0: item.title })}
                  aria-expanded={menuId === item.id}
                  onClick={() => setMenuId(menuId === item.id ? null : item.id)}
                >
                  <IconMenu size={16} />
                </button>
                {menuId === item.id && (
                  <div className="prompt-chat-row-actions" role="menu">
                    <button role="menuitem" onClick={() => startRename(item)}>
                      <IconEdit size={14} />  {t('Rename')}
                    </button>
                    <button role="menuitem" className="danger" onClick={() => void moveToTrash(item)}>
                      <IconTrash size={14} />  {t('Delete')}
                    </button>
                  </div>
                )}
              </article>
            )
          })}
        </div>

        {trash.length > 0 && (
          <details className="prompt-chat-deleted">
            <summary>{t('Trash · {0}', { 0: trash.length })}</summary>
            {trash.map((item) => (
              <article key={item.id}>
                <span title={item.title}>{item.title}</span>
                <button
                  className="icon-btn"
                  aria-label={t('Restore chat “{0}”', { 0: item.title })}
                  onClick={() => onRestore(item.id)}
                >
                  <IconRefresh size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  aria-label={t('Delete the “{0}” chat permanently', { 0: item.title })}
                  onClick={() => setPermanent(item)}
                >
                  <IconTrash size={14} />
                </button>
              </article>
            ))}
          </details>
        )}

        {undo && (
          <div className="prompt-chat-undo" role="status">
            <span>{t('Chat deleted')}</span>
            <button onClick={() => {
              void onRestore(undo.id)
              setUndo(null)
            }}>{t('Cancel')}</button>
          </div>
        )}

        {permanent && (
          <section className="prompt-chat-permanent" role="alertdialog" aria-label={t('Permanent removal')}>
            <strong>{t('Delete "{0}"?', { 0: permanent.title })}</strong>
            <p>{t('History and its references cannot be restored.')}</p>
            <div>
              <button onClick={() => setPermanent(null)}>{t('Cancel')}</button>
              <button className="danger" onClick={() => {
                void onPermanentDelete(permanent.id)
                setPermanent(null)
              }}>{t('Delete permanently')}</button>
            </div>
          </section>
        )}
      </aside>
    </div>
  )
}
