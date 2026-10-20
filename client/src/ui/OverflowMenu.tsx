import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { IconMenu } from './icons'

const FOCUSABLE = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function OverflowMenu({
  label,
  panelLabel,
  attention = false,
  compact,
  defaultOpen = false,
  children,
}: {
  label: string
  panelLabel: string
  attention?: boolean
  compact: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const closeAfterAction = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const action = target?.closest('button, a[href], [role="menuitem"]')
    if (!action || action.matches(':disabled, [aria-disabled="true"]')) return
    setOpen(false)
  }

  useEffect(() => {
    if (!compact) setOpen(false)
  }, [compact])

  useEffect(() => {
    if (!open) return
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    })
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
    window.addEventListener('mousedown', closeOutside)
    window.addEventListener('keydown', closeWithEscape)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('keydown', closeWithEscape)
    }
  }, [open])

  return (
    <div className="compact-overflow" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="compact-overflow-trigger icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        data-attention={attention || undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <IconMenu size={20} />
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="compact-overflow-panel"
        role="menu"
        aria-label={panelLabel}
        hidden={!open}
        onClickCapture={closeAfterAction}
      >
        {children}
      </div>
    </div>
  )
}
