import type { ReactNode, Ref } from 'react'
import { Tooltip, type TooltipPlacement } from '../../../ui/Tooltip'

// Кнопка правки клипа: поддерживает как компактный квадрат с иконкой (шаг по
// кадру, звук), так и подписанную кнопку с бейджем клавиши в ряду монтажа и
// транспорте (закон Хика — узнавание вместо вспоминания по голой иконке).

export interface TimelineButtonProps {
  /** Человеческое имя действия: aria-label и начало подсказки. */
  label: string
  /** Короткая видимая подпись внутри кнопки (на узком экране скрывается). */
  text?: string
  /** Видимый бейдж горячей клавиши внутри кнопки. */
  kbd?: string
  /** Клавиша для человека («C», «Enter», «←»): дописывается в подсказку. */
  keys?: string
  /** Клавиша в записи ARIA («C», «Enter», «Space», «ArrowLeft»). */
  shortcut?: string
  /** Расширение подсказки, если одного имени мало («нет звуковой дорожки»). */
  hint?: string
  placement?: TooltipPlacement
  /** Главное действие всего окна (заливка акцентом по эффекту фон Ресторфф). */
  primary?: boolean
  /** Кнопка лежит ПОВЕРХ видео: стеклянная подложка. */
  glass?: boolean
  /** Включённое состояние переключателя — мягкий акцент. */
  on?: boolean
  /** Переключатель: рисует aria-pressed. */
  toggle?: boolean
  expanded?: boolean
  busy?: boolean
  disabled?: boolean
  className?: string
  buttonRef?: Ref<HTMLButtonElement>
  onClick?: () => void
  children: ReactNode
}

/** Текст подсказки: «Действие · Клавиша», как в макете. */
export function tooltipText(label: string, keys?: string): string {
  return keys ? `${label} · ${keys}` : label
}

export function TimelineButton({
  label,
  text,
  kbd,
  keys,
  shortcut,
  hint,
  placement = 'top',
  primary,
  glass,
  on,
  toggle,
  expanded,
  busy,
  disabled,
  className,
  buttonRef,
  onClick,
  children,
}: TimelineButtonProps) {
  const hasLabel = Boolean(text || kbd)
  const classes = [
    'tl-btn',
    hasLabel ? 'has-label' : '',
    primary ? 'primary' : '',
    glass ? 'glass' : '',
    on ? 'is-on' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <Tooltip title={tooltipText(label, keys)} hint={hint} placement={placement}>
      <button
        ref={buttonRef}
        type="button"
        className={classes}
        disabled={disabled}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        aria-pressed={toggle ? Boolean(on) : undefined}
        aria-expanded={expanded}
        aria-busy={busy || undefined}
        onClick={onClick}
      >
        {children}
        {text && <span className="tl-btn-label">{text}</span>}
        {kbd && <kbd className="tl-kbd" aria-hidden="true">{kbd}</kbd>}
      </button>
    </Tooltip>
  )
}
