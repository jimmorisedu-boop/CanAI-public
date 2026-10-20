const KEYBOARD_THRESHOLD = 120

export interface TabletPromptLayout {
  rows: number
  minHeight: number
  maxHeight: number
}

export interface TabletSettingsPlacement {
  placement: 'above' | 'viewport-top'
  top: number | null
  maxHeight: number | null
}

export type TabletPromptFocusTrigger = 'panel' | 'keyboard' | 'textarea' | 'editor'

/**
 * Клавиатуру зовёт ТОЛЬКО кнопка клавиатуры.
 *
 * ⚠️ На планшете клавиатура съедает половину экрана, и всплывала она от
 * любого касания поля — а в поле попадают и мимо, и разглядывая уже
 * написанное. Просьба прямая: «клавиатура должна появляться по нажатию на
 * иконку клавиатуры» (09.09.2026). Разворачивание полки — действие
 * раскладки, а не ввода.
 *
 * ⚠️ Одного этого правила мало: поле ввода фокусируется касанием само,
 * мимо наших обработчиков. Пока ввод не начат, поле держат `readOnly` —
 * тогда браузер клавиатуру не показывает, а прочитать и прокрутить
 * написанное по-прежнему можно.
 */
export function promptFocusesTextarea(trigger: TabletPromptFocusTrigger): boolean {
  return trigger === 'keyboard'
}

export function promptBlurDisposition(input: {
  settingsOpen: boolean
  relatedTargetInside: boolean
  activeElementInside: boolean
}): 'keep' | 'collapse' {
  // Native iPad selects may temporarily report body/null as the active element
  // while their picker opens. An open inline menu owns that transition.
  if (input.settingsOpen || input.relatedTargetInside || input.activeElementInside) return 'keep'
  return 'collapse'
}

export function promptFieldHeightFromDrag(height: number, deltaY: number, scale: number, maxHeight: number): number {
  return Math.min(maxHeight, Math.max(44, height - deltaY / scale))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function tabletPromptLayout(input: {
  expanded: boolean
  largeEditor: boolean
  keyboardOpen: boolean
  visibleHeight: number
}): TabletPromptLayout {
  if (!input.expanded) {
    return { rows: 1, minHeight: 44, maxHeight: 88 }
  }

  const visibleHeight = Math.max(320, input.visibleHeight)
  if (input.largeEditor) {
    const maxHeight = Math.round(visibleHeight * (input.keyboardOpen ? 0.62 : 0.68))
    return {
      rows: 10,
      minHeight: Math.min(input.keyboardOpen ? 220 : 280, maxHeight),
      maxHeight,
    }
  }

  const maxHeight = input.keyboardOpen
    ? Math.round(visibleHeight * 0.4)
    : clamp(Math.round(visibleHeight * 0.34), 220, 320)
  return {
    rows: 1,
    minHeight: Math.min(44, maxHeight),
    maxHeight,
  }
}

/**
 * Выбирает положение меню параметров по реальным прямоугольникам DOM. Меню
 * привязано к prompt, поэтому `top` — это смещение от его верхнего края;
 * итоговая верхняя координата всегда остаётся ниже верхней панели.
 */
export function tabletSettingsPlacement(input: {
  promptTop: number
  popoverHeight: number
  viewportTop: number
  viewportHeight: number
  topInset?: number
  gap?: number
}): TabletSettingsPlacement {
  const gap = Math.max(0, input.gap ?? 8)
  const topMargin = input.viewportTop + Math.max(0, input.topInset ?? 60)
  const aboveTop = input.promptTop - gap - input.popoverHeight
  if (aboveTop >= topMargin) return { placement: 'above', top: null, maxHeight: null }

  return {
    placement: 'viewport-top',
    top: Math.round(topMargin - input.promptTop),
    maxHeight: Math.max(160, Math.round(input.viewportTop + input.viewportHeight - topMargin - gap)),
  }
}

export function tabletViewportState(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number },
): { keyboardOpen: boolean; bottomInset: number; visibleHeight: number } {
  const bottomInset = Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
  return {
    keyboardOpen: bottomInset >= KEYBOARD_THRESHOLD,
    bottomInset,
    visibleHeight: Math.round(viewport.height),
  }
}
