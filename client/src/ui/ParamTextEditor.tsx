import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons'

// Большой редактор текстового параметра (системный промпт и т.п.).
//
// В ноде шириной 280px длинному тексту негде жить: его нельзя ни прочитать
// целиком, ни спокойно править. Поэтому в ноде остаётся компактное поле, а
// работа идёт здесь — на всю высоту окна и с комфортной длиной строки.
//
// Правки применяются СРАЗУ (общее значение, не черновик): закрыть окно нельзя
// так, чтобы текст пропал.
export function ParamTextEditor({
  label,
  value,
  placeholder,
  onChange,
  onClose,
}: {
  label: string
  value: string
  placeholder?: string
  onChange(next: string): void
  onClose(): void
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    // курсор в конец — обычно текст дописывают, а не переписывают с начала
    area.setSelectionRange(area.value.length, area.value.length)
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // capture: у холста и редактора нод свои обработчики на тех же клавишах
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const characters = value.length
  const lines = value ? value.split('\n').length : 0

  return createPortal(
    // класс settings-backdrop не только оформляет фон: по нему хоткеи холста
    // понимают, что открыто модальное окно, и замолкают
    <div className="settings-backdrop param-editor-backdrop" onPointerDown={onClose}>
      <div
        className="param-editor"
        role="dialog"
        aria-label={label}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="param-editor-head">
          <strong>{label}</strong>
          <span className="param-editor-count">
            {characters} characters · {lines} lines
          </span>
          <button className="param-editor-close" aria-label="Close (Esc)" title="Esc" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <textarea
          ref={areaRef}
          className="param-editor-area nodrag nowheel"
          aria-label={label}
          value={value}
          placeholder={placeholder}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
          onKeyDownCapture={(event) => event.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  )
}
