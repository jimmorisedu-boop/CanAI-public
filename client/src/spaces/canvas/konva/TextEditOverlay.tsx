import { useEffect, useRef, useState } from 'react'
import { computeAdaptiveTextDimensions, DEFAULT_FONT_SIZE, textPadding } from './canvasLayout'
import type { CanvasStore } from './canvasStore'
import { textOverflowsFrame } from './textOverflow'
import type { CanvasItem } from './types'
import { useT } from '../../../i18n/context.js'


// Инлайн-редактирование текстового объекта: двойной клик → textarea прямо
// поверх фигуры (мировые координаты → экранные). Ctrl+Enter/blur = сохранить,
// Esc = отмена.
export function TextEditOverlay({
  store,
  item,
  onClose,
}: {
  store: CanvasStore
  item: CanvasItem
  onClose: () => void
}) {
  const t = useT()
  const [value, setValue] = useState(item.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const cam = store.getCamera()
  const fontSize = item.fontSize ?? DEFAULT_FONT_SIZE

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Новая пустая карточка растёт по мере ввода. У существующей геометрия уже
  // задана пользователем: переносы и правка текста не должны сбрасывать её форму.
  const isNewText = !item.text?.trim()
  const dims = isNewText
    ? computeAdaptiveTextDimensions(value, fontSize)
    : { w: item.w, h: item.h }
  const overlayW = dims.w
  const overlayH = dims.h
  const overflowing = textOverflowsFrame({ text: value, w: overlayW, h: overlayH, fontSize })
  const descriptionId = `text-overflow-${item.id}`

  function commit(): void {
    const text = value.trim()
    if (text) {
      store.updateItem(item.id, isNewText ? { text, w: overlayW, h: overlayH } : { text })
    } else {
      if (!item.text?.trim()) store.removeItems([item.id])
    }
    onClose()
  }

  return (
    <>
      <textarea
        ref={ref}
        className={`text-edit-overlay${overflowing ? ' is-overflowing' : ''}`}
        aria-label={t('Canvas object text')}
        aria-describedby={overflowing ? descriptionId : undefined}
        style={{
          left: cam.x + item.x * cam.scale,
          top: cam.y + item.y * cam.scale,
          width: overlayW * cam.scale,
          height: overlayH * cam.scale,
          fontSize: fontSize * cam.scale,
          // отступ тот же, что рисует Konva (см. textPadding), иначе при
          // двойном клике текст прыгал бы относительно отрисованного
          padding: textPadding(fontSize) * cam.scale,
        }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit()
          if (e.key === 'Escape') onClose()
        }}
      />
      {overflowing && (
        <span id={descriptionId} className="sr-only">
          Part of the text is hidden; scroll to see it
        </span>
      )}
    </>
  )
}
