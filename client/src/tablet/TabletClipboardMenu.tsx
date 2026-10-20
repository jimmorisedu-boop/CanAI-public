import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useDismissOnOutsidePointer } from '../ui/dismissOnOutside'
import { isActiveModal, useModalFocus } from './modalFocus'
import type { Point } from './boardGestures'

// Меню копирования и вставки — ответ на свайп тремя пальцами вниз.
//
// ⚠️ Материал и разметка ТЕ ЖЕ, что у меню объекта (`.tablet-item-menu`):
// два почти одинаковых всплывающих меню, объявленных порознь, разъедутся при
// первой же правке одного. Отличие только в наборе: копирование живёт не на
// объекте, а на доске — «Вставить» осмысленно и без выделения.

const MENU_W = 232
const MARGIN = 12

export interface ClipboardMenuState {
  at: Point
  /** Мировая точка под пальцами: вставляем туда, куда показали. */
  world: Point
}

export function TabletClipboardMenu({
  store,
  state,
  canPaste,
  onCopy,
  onCut,
  onPaste,
  onClose,
}: {
  store: CanvasStore
  state: ClipboardMenuState
  canPaste: boolean
  onCopy(): void
  onCut(): void
  onPaste(world: Point): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)
  useDismissOnOutsidePointer(true, ref, () => {
    if (ref.current && isActiveModal(ref.current)) onClose()
  })
  useModalFocus(ref, onClose)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const host = document.querySelector('.tablet-body')?.getBoundingClientRect()
    const x = (host?.left ?? 0) + state.at.x
    const y = (host?.top ?? 0) + state.at.y
    const height = node.offsetHeight
    setBox({
      left: Math.min(Math.max(MARGIN, x - MENU_W / 2), window.innerWidth - MENU_W - MARGIN),
      top: y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, y - height - 8) : y + 8,
    })
  }, [state])

  const selected = store.getSelectedIds().size
  const rows: Array<{ label: string; disabled: boolean; run(): void }> = [
    { label: 'Copy', disabled: selected === 0, run: onCopy },
    { label: 'Cut', disabled: selected === 0, run: onCut },
    { label: 'Paste', disabled: !canPaste, run: () => onPaste(state.world) },
  ]

  return createPortal(
    <div
      ref={ref}
      className="tablet-item-menu"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label="Copy and paste"
      style={box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 }}
    >
      <p className="tablet-item-menu-title">
        {selected > 0 ? `Selected: ${selected}` : 'Board clipboard'}
      </p>
      <div role="menu" aria-label="Copy and paste">
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            role="menuitem"
            className="tablet-menu-item"
            disabled={row.disabled}
            onClick={() => {
              row.run()
              onClose()
            }}
          >
            <span>{row.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
