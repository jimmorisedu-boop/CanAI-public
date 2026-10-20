import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { useDismissOnOutsidePointer } from '../ui/dismissOnOutside'
import { ACTION_LABEL, actionSection, type InspectorAction } from './inspectorModel'
import { contextActionsFor } from './contextActionModel'
import type { Point } from './boardGestures'
import { isActiveModal, useModalFocus } from './modalFocus'

// Меню объекта по долгому нажатию.
//
// Инспектор справа отвечает на вопрос «что я выделил и что с этим можно», а
// это меню — на «хочу вот с этим прямо сейчас», не отводя пальца. Набор
// действий у них ОБЩИЙ (inspectorModel): два разных списка разошлись бы при
// первой же правке одного.

// The action list is a two-column grid. Keep the positioning fallback in sync
// with its CSS max width; the measured width below still wins for Split View.
const MENU_W = 344
const MARGIN = 12

export function TabletItemMenu({
  store,
  itemId,
  at,
  onAction,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  at: Point
  onAction(action: InspectorAction, items: CanvasItem[]): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)
  useDismissOnOutsidePointer(true, ref, () => {
    if (ref.current && isActiveModal(ref.current)) onClose()
  })
  useModalFocus(ref, onClose)

  const selected = store.getSelectedIds()
  const ids = selected.has(itemId) && selected.size > 1 ? [...selected] : [itemId]
  const items = ids.map((id) => store.getItem(id)).filter((item): item is CanvasItem => Boolean(item))

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return

    // Меню появляется у пальца, но целиком на экране: наполовину срезанное
    // меню — худшее, что может ответить долгое нажатие. Размер берём у DOM,
    // потому что в Split View CSS сжимает панель до ширины viewport.
    const update = () => {
      const host = document.querySelector('.tablet-body')?.getBoundingClientRect()
      const visual = window.visualViewport
      const viewportLeft = visual?.offsetLeft ?? 0
      const viewportTop = visual?.offsetTop ?? 0
      const viewportWidth = visual?.width ?? window.innerWidth
      const viewportHeight = visual?.height ?? window.innerHeight
      const width = Math.min(node.offsetWidth || MENU_W, Math.max(1, viewportWidth - MARGIN * 2))
      const height = node.offsetHeight
      const x = (host?.left ?? 0) + at.x
      const y = (host?.top ?? 0) + at.y
      const right = viewportLeft + viewportWidth
      const bottom = viewportTop + viewportHeight
      const below = y + 8
      const above = y - height - 8
      setBox({
        left: Math.min(Math.max(viewportLeft + MARGIN, x - width / 2), right - width - MARGIN),
        top: below + height + MARGIN > bottom ? Math.max(viewportTop + MARGIN, above) : below,
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('canai-tablet-ui-scale', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('canai-tablet-ui-scale', update)
    }
  }, [at])

  if (items.length === 0) return null
  const many = items.length > 1
  const model = contextActionsFor(items)
  const actions = [...model.primary.filter((action) => action !== 'grid'), ...model.overflow] as InspectorAction[]

  return createPortal(
    <div
      ref={ref}
      className="tablet-item-menu tablet-item-menu-object"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label="Object actions"
      style={box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 }}
    >
      <p className="tablet-item-menu-title">
        {many ? `Selected: ${items.length}` : items[0]!.name || items[0]!.text?.slice(0, 28) || 'Object'}
      </p>
      <div className="tablet-item-menu-actions" role="menu" aria-label="Object actions" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        event.preventDefault()
        buttons[next]?.focus()
      }}>{actions.map((action, index) => {
        const section = actionSection(action)
        const previous = index > 0 ? actionSection(actions[index - 1]!) : null
        const disabled = false
        const disabledReason = disabled ? '' : undefined
        return (
          <Fragment key={action}>
            {previous && previous !== section && <span className="tablet-menu-sep" aria-hidden="true" />}
            <button
              type="button"
              role="menuitem"
              className={`tablet-menu-item ${action === 'archive' ? 'archive' : ''}`}
              disabled={disabled}
              title={disabledReason ?? ACTION_LABEL[action]}
              aria-label={disabledReason ? `${ACTION_LABEL[action]}. ${disabledReason}` : ACTION_LABEL[action]}
              onClick={() => {
                onAction(action, items)
                onClose()
              }}
            >
              <span>{ACTION_LABEL[action]}</span>
            </button>
          </Fragment>
        )
      })}</div>
    </div>,
    document.body,
  )
}
