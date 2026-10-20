import type { ReactNode, Ref } from 'react'
import { Tooltip, type TooltipPlacement } from '../../../ui/Tooltip'

// Кнопка правки клипа: квадрат только с иконкой, подпись живёт в подсказке и в
// aria-label. Одна форма на транспорт, монтаж и полку кадров — три ряда кнопок
// разной формы читались бы как три разных набора действий.

export interface TimelineButtonProps {
  /** Человеческое имя действия: aria-label и начало подсказки. */
  label: string
  /** Клавиша для человека («S», «Enter», «←»): дописывается в подсказку. */
  keys?: string
  /** Клавиша в записи ARIA («S», «Enter», «Space», «ArrowLeft»): НЕ код
   *  события (`KeyS`) — вспомогательные технологии ждут именно такой вид. */
  shortcut?: string
  /** Расширение подсказки, если одного имени мало («нет звуковой дорожки»). */
  hint?: string
  placement?: TooltipPlacement
  /** Главное действие ряда (заливка акцентом). */
  primary?: boolean
  /** Кнопка лежит ПОВЕРХ видео: стеклянная подложка, чтобы читалась на любом кадре. */
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
  const classes = ['tl-btn', primary ? 'primary' : '', glass ? 'glass' : '', on ? 'is-on' : '', className ?? ''].filter(Boolean).join(' ')
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
      </button>
    </Tooltip>
  )
}
