import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismissOnOutsidePointer } from '../ui/dismissOnOutside'
import { isActiveModal, useModalFocus } from './modalFocus'

// Всплывающая панель, привязанная к кнопке.
//
// На iPad это основная форма короткого выбора: лист снизу закрывает пол-экрана
// и уводит взгляд от того места, где нажали. Панель встаёт под своей кнопкой и
// закрывается нажатием мимо.
//
// Рисуется ПОРТАЛОМ в body: у панелей планшета есть backdrop-filter, а он
// делает элемент точкой отсчёта для position: fixed внутри — вложенная панель
// считала бы координаты не от экрана (та же ловушка, что у окна помощника на
// компьютере).

const MARGIN = 10

export function scheduleFocusRestore(
  target: { focus(): void } | null,
  schedule: (run: () => void) => void = (run) => window.requestAnimationFrame(run),
): void {
  if (!target) return
  schedule(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active && active !== document.body && active.isConnected) return
    target.focus()
  })
}

interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** Чистая геометрия нужна и компоненту, и регрессии Split View. */
export function positionPopover(
  anchor: RectLike,
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end' | 'center' = 'end',
  avoidRect?: RectLike | null,
): { left: number; top: number } {
  const raw = align === 'start'
    ? anchor.left
    : align === 'center'
      ? anchor.left + anchor.width / 2 - box.width / 2
      : anchor.right - box.width
  const left = Math.min(Math.max(MARGIN, raw), Math.max(MARGIN, viewport.width - box.width - MARGIN))
  const below = anchor.bottom + MARGIN
  const top = below + box.height > viewport.height - MARGIN
    ? Math.max(MARGIN, anchor.top - box.height - MARGIN)
    : below
  if (!avoidRect) return { left, top }
  const intersects = (candidateLeft: number, candidateTop: number) => (
    candidateLeft < avoidRect.right
    && candidateLeft + box.width > avoidRect.left
    && candidateTop < avoidRect.bottom
    && candidateTop + box.height > avoidRect.top
  )
  if (!intersects(left, top)) return { left, top }
  const candidates = [
    { left, top: Math.max(MARGIN, avoidRect.top - box.height - MARGIN) },
    { left, top: Math.min(viewport.height - box.height - MARGIN, avoidRect.bottom + MARGIN) },
    { left: Math.min(viewport.width - box.width - MARGIN, avoidRect.right + MARGIN), top },
    { left: Math.max(MARGIN, avoidRect.left - box.width - MARGIN), top },
  ].map((candidate) => ({
    left: Math.min(Math.max(MARGIN, candidate.left), Math.max(MARGIN, viewport.width - box.width - MARGIN)),
    top: Math.min(Math.max(MARGIN, candidate.top), Math.max(MARGIN, viewport.height - box.height - MARGIN)),
  }))
  return candidates.find((candidate) => !intersects(candidate.left, candidate.top)) ?? { left, top }
}

export function shouldUsePopoverSheet(anchor: RectLike, boxHeight: number, viewportHeight: number): boolean {
  const above = anchor.top - MARGIN
  const below = viewportHeight - anchor.bottom - MARGIN
  return Math.max(above, below) < boxHeight
}

export function TabletPopover({
  anchor,
  align = 'end',
  onClose,
  label,
  fallbackSheet = false,
  avoidRect = null,
  children,
}: {
  /** Прямоугольник кнопки на экране. */
  anchor: DOMRect | HTMLElement
  align?: 'start' | 'end' | 'center'
  onClose(): void
  label: string
  fallbackSheet?: boolean
  /** Optional selection bounds that the anchored panel should avoid. */
  avoidRect?: RectLike | null
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; sheet: boolean } | null>(null)
  useDismissOnOutsidePointer(true, ref, () => {
    if (ref.current && isActiveModal(ref.current)) onClose()
  })

  useModalFocus(ref, onClose)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => {
      const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
      const viewport = window.visualViewport
      const position = positionPopover(
        rect,
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight },
        align,
        avoidRect,
      )
      setBox({
        ...position,
        sheet: fallbackSheet && shouldUsePopoverSheet(
          rect,
          node.offsetHeight,
          viewport?.height ?? window.innerHeight,
        ),
      })
    }
    update()
    // Split View и экранная клавиатура меняют visualViewport без повторного
    // нажатия на кнопку. Панель должна переехать сама, пока она открыта.
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [anchor, align, fallbackSheet, avoidRect])

  return createPortal(
    <div
      ref={ref}
      className={`tablet-popover ${box?.sheet ? 'sheet' : ''}`}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label={label}
      style={box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Хранит прямоугольник нажатой кнопки — им панель и позиционируется. */
export function useAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = (event: { currentTarget: EventTarget | null }) => {
    const target = event.currentTarget
    setAnchor(target instanceof HTMLElement ? target : null)
  }
  return { anchor, open, close: () => setAnchor(null) }
}
