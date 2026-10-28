import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { IconCaretDown, IconClose, IconDownload, IconMenu, IconNext, IconOpenExternal, IconRefresh, IconTrash } from '../../../ui/icons'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import { TimelineButton } from './TimelineButton'
import { frameStatusText, frameStatusTone, framesByTime, isBusyPhase, NO_FRAMES_MESSAGE } from './timelineStatus'
import { timecode } from './timelineTimecode'
import { useT } from '../../../i18n/context.js'


// Полка занимает свою строку под превью. Миниатюра выбирает момент;
// вторичные действия открываются отдельным меню вне прокручиваемой ленты.
type FrameMenu = { id: string; left: number; bottom: number; maxHeight: number }

export function TimelineFramesShelf({
  records,
  selectedId,
  open,
  toggleRef,
  onToggle,
  onSelect,
  onRetry,
  onCancel,
  onRemove,
  onShow,
  onDownload,
}: {
  records: readonly FrameCaptureRecord[]
  selectedId: string | null
  open: boolean
  toggleRef: Ref<HTMLButtonElement>
  onToggle(): void
  onSelect(record: FrameCaptureRecord): void
  onRetry(id: string): void
  onCancel(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
  onDownload(id: string): void
}) {
  const t = useT()
  const ordered = framesByTime(records)
  const gridRef = useRef<HTMLDivElement>(null)
  const shelfRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<FrameMenu | null>(null)
  const menuId = useId()
  const menuRecord = open ? records.find(record => record.id === menu?.id) : undefined

  function closeMenu(restoreFocus = true): void {
    setMenu(null)
    if (!restoreFocus) return
    const target = triggerRef.current?.isConnected
      ? triggerRef.current
      : shelfRef.current?.querySelector<HTMLButtonElement>('.tl-shelf-toggle')
    target?.focus({ preventScroll: true })
  }

  // Меню остаётся внутри модального окна для focus trap, но вне overflow
  // ленты. Escape закрывает только меню, не весь просмотрщик.
  useEffect(() => {
    if (!menuRecord) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenu(null)
    }
    const resize = () => closeMenu()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', resize)
    }
  }, [menuRecord?.id])

  useEffect(() => {
    if (!open) setMenu(null)
  }, [open])

  // Выбранная карточка остаётся на виду: снятый кадр или метка на дорожке
  // выбирают карточку, которая может лежать за краем ленты.
  useEffect(() => {
    const grid = gridRef.current
    if (!open || !selectedId || !grid) return
    const card = grid.querySelector<HTMLElement>(`[data-frame-id="${CSS.escape(selectedId)}"]`)
    if (!card) return
    const left = card.offsetLeft - grid.offsetLeft
    const right = left + card.offsetWidth
    if (left < grid.scrollLeft) grid.scrollLeft = left
    else if (right > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = right - grid.clientWidth
  }, [open, selectedId, records.length])

  return (
    <section className="tl-shelf" ref={shelfRef} data-open={open} aria-label={t('Saved frames')}>
      <div className="tl-shelf-head">
        <TimelineButton
          buttonRef={toggleRef}
          label={open ? t('Hide saved frames') : t('Show saved frames')}
          keys="B"
          shortcut="B"
          placement="top"
          expanded={open}
          className="tl-shelf-toggle"
          onClick={onToggle}
        >
          {open ? <IconCaretDown size={16} /> : <IconNext size={16} />}
        </TimelineButton>
        <span className="tl-count" aria-live="polite">
          {records.length}
          <span className="tl-sr"> {t(records.length === 1 ? 'saved frame' : 'saved frames')}</span>
        </span>
        <span className="tl-shelf-context">{t('Saved frames')}</span>
      </div>

      {open && (ordered.length === 0 ? (
        <p className="tl-lane-empty">{t(NO_FRAMES_MESSAGE)}</p>
      ) : (
        <div className="tl-lane" ref={gridRef} role="list" aria-label={t('Saved frames')} onScroll={() => setMenu(null)}>
          {ordered.map((record) => {
            const at = timecode(record.requestedTime)
            const tone = frameStatusTone(record)
            const status = frameStatusText(record)
            return (
              <article
                key={record.id}
                className={`tl-frame${record.id === selectedId ? ' is-current' : ''}`}
                data-frame-id={record.id}
                role="listitem"
                aria-label={t('Frame {0} — {1}', { 0: at, 1: status })}
              >
                <button
                  type="button"
                  className="tl-frame-thumb"
                  aria-label={t('Return to moment {0}', { 0: at })}
                  aria-current={record.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(record)}
                >
                  {record.resultUrl
                    ? <img src={record.resultUrl} alt="" draggable={false} />
                    : isBusyPhase(record.phase) && <span className="tl-spinner" aria-hidden="true" />}
                  <span className="tl-frame-time">{at}</span>
                  {record.phase !== 'saved' && (
                    <span className="tl-frame-status" data-tone={tone} title={status}>
                      {record.phase === 'error' ? t('Error') : status}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="tl-frame-menu-trigger"
                  aria-label={`${t('More')} · ${at}`}
                  title={t('More')}
                  aria-haspopup="menu"
                  aria-expanded={menuRecord?.id === record.id}
                  aria-controls={menuRecord?.id === record.id ? menuId : undefined}
                  onClick={(event) => {
                    if (menu?.id === record.id) { closeMenu(); return }
                    const trigger = event.currentTarget
                    const rect = trigger.getBoundingClientRect()
                    triggerRef.current = trigger
                    setMenu({
                      id: record.id,
                      left: Math.max(12, Math.min(rect.right - 240, window.innerWidth - 252)),
                      bottom: window.innerHeight - rect.top + 8,
                      maxHeight: Math.max(80, rect.top - 20),
                    })
                  }}
                >
                  <IconMenu size={16} />
                </button>
              </article>
            )
          })}
        </div>
      ))}
      {menu && menuRecord && (
        <div
          ref={menuRef}
          id={menuId}
          className="tl-frame-menu"
          role="menu"
          aria-label={t('Frame {0}', { 0: timecode(menuRecord.requestedTime) })}
          style={{ left: menu.left, bottom: menu.bottom, maxHeight: menu.maxHeight }}
          onKeyDownCapture={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
            if (event.key === 'Tab') { closeMenu(); return }
            if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && menuRecord.phase === 'saved') {
              if (event.code === 'KeyG' && menuRecord.resultItemId) {
                event.preventDefault(); closeMenu(); onShow(menuRecord.id); return
              }
              if (event.code === 'KeyD' && menuRecord.resultUrl) {
                event.preventDefault(); closeMenu(); onDownload(menuRecord.id); return
              }
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus({ preventScroll: true })
          }}
        >
          {menuRecord.phase !== 'saved' && (
            <p className="tl-frame-menu-status" role="status">{frameStatusText(menuRecord)}</p>
          )}
          {menuRecord.phase === 'saved' && (
            <>
              <button type="button" role="menuitem" disabled={!menuRecord.resultItemId}
                onClick={() => { closeMenu(); onShow(menuRecord.id) }}>
                <IconOpenExternal size={16} />{t('To canvas (G)')}
              </button>
              <button type="button" role="menuitem" disabled={!menuRecord.resultUrl}
                onClick={() => { closeMenu(); onDownload(menuRecord.id) }}>
                <IconDownload size={16} />{t('Download (D)')}
              </button>
            </>
          )}
          {(menuRecord.phase === 'error' || menuRecord.phase === 'cancelled') && (
            <button type="button" role="menuitem" onClick={() => { closeMenu(); onRetry(menuRecord.id) }}>
              <IconRefresh size={16} />{t('Retry frame capture')}
            </button>
          )}
          {isBusyPhase(menuRecord.phase) ? (
            <button type="button" role="menuitem" onClick={() => { closeMenu(); onCancel(menuRecord.id) }}>
              <IconClose size={16} />{t('Cancel frame capture')}
            </button>
          ) : (
            <button type="button" role="menuitem" className="danger"
              onClick={() => {
                closeMenu(false)
                onRemove(menuRecord.id)
                shelfRef.current?.querySelector<HTMLButtonElement>('.tl-shelf-toggle')?.focus({ preventScroll: true })
              }}>
              <IconTrash size={16} />{menuRecord.resultItemId ? t('Delete frame from canvas') : t('Remove from shelf')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
