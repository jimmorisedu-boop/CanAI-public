import { useEffect, useRef, useState } from 'react'
import { IconFit } from './icons'
import { ParamTextEditor } from './ParamTextEditor'

// Текстовое поле с кнопкой «Развернуть».
//
// В ноде шириной 280px длинный текст нечитаем: его нельзя ни окинуть взглядом,
// ни спокойно править. Поэтому у КАЖДОГО текстового поля (промпт ноды,
// постоянный текст, разделитель, системный промпт модели) есть выход в большой
// редактор. Реализация одна — кнопка везде выглядит и ведёт себя одинаково.
//
// Правки применяются сразу и в поле, и в большом окне: значение общее, черновика
// нет — закрыть редактор так, чтобы текст пропал, невозможно.
const AUTO_GROW_MAX = 180

export function ExpandableTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 2,
  className = '',
  wrapClassName = '',
  autoGrow = false,
}: {
  // подпись поля — шапка большого редактора
  label: string
  value: string
  onChange(next: string): void
  placeholder?: string
  rows?: number
  // класс самой textarea (у ноды и у параметра модели свой вид)
  className?: string
  wrapClassName?: string
  // поле растёт под содержимое до потолка (у параметров модели)
  autoGrow?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!autoGrow) return
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, AUTO_GROW_MAX)}px`
  }, [autoGrow, value, expanded])

  return (
    <div className={`expandable-text ${wrapClassName}`.trim()}>
      <textarea
        ref={areaRef}
        className={className}
        aria-label={label}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        // не даём канвасу и редактору нод перехватывать клавиши при вводе
        onKeyDownCapture={(event) => event.stopPropagation()}
      />
      <button
        type="button"
        className="param-expand nodrag"
        title="Open in a larger window"
        onClick={(event) => {
          event.preventDefault()
          setExpanded(true)
        }}
      >
        <IconFit size={13} /> Expand
      </button>
      {expanded && (
        <ParamTextEditor
          label={label}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}
