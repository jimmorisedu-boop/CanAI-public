// Dispatch клавиатуры полноэкранного таймлайна — чистая функция, проверяемая
// без DOM (разделы 13–14 ТЗ).
//
// Правила сверены с ТЗ:
//  - сначала defaultPrevented, потом repeat (повтор разрешён только движению),
//    потом ctrlKey/metaKey/altKey;
//  - shiftKey НЕ отсекаем до стрелок: Shift+←/→ = шаг в 10 кадров;
//  - editable (input/textarea/select/contenteditable) не трогаем;
//  - сфокусированную нативную кнопку Space/Enter не крадём (флаг from outside);
//  - буквы — по физическому `event.code` (KeyC/KeyX/KeyS/KeyF/KeyQ/KeyW/…) — одинаково на EN и RU;
//  - после стрелок shift отсекаем перед буквенными/мутациями.

export type TimelineCommand =
  | { kind: 'play' }
  | { kind: 'seek'; direction: -1 | 1; tenFrames: boolean; page?: boolean; edge?: 'start' | 'end' }
  | { kind: 'jumpCut'; direction: -1 | 1 }
  | { kind: 'cut' }
  | { kind: 'toggleDrop' }
  | { kind: 'trimLeft' }
  | { kind: 'trimRight' }
  | { kind: 'in' }
  | { kind: 'out' }
  | { kind: 'capture' }
  | { kind: 'crop' }
  | { kind: 'audio' }
  | { kind: 'drawer' }
  | { kind: 'fit' }
  | { kind: 'apply' }
  | { kind: 'showOnCanvas' }
  | { kind: 'downloadFrame' }
  | { kind: 'close' }

export interface TimelineKeyContext {
  defaultPrevented?: boolean
  repeat?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
  /** фокус в поле ввода — клавиши не трогаем. */
  inInput?: boolean
  /** фокус на нативной кнопке/ссылке — Space/Enter делает браузер сам. */
  onNativeButton?: boolean
}

export interface TimelineKeyInput {
  code: string
  key: string
  context: TimelineKeyContext
}

export function dispatchTimelineKey(input: TimelineKeyInput): TimelineCommand | null {
  const { code, key } = input
  const ctx = input.context

  if (ctx.defaultPrevented) return null
  if (ctx.inInput) return null

  const guarded = Boolean(ctx.ctrl || ctx.meta || ctx.alt)
  if (guarded) return null

  // Только движение живёт на удержании: смена позиции повторяется, остальное
  // (рез, кадр, применение, звук) — единичные точные действия, и зажатая
  // клавиша не должна нарезать клип десятками раз.
  const isMove = code === 'ArrowLeft' || code === 'ArrowRight'
    || code === 'ArrowUp' || code === 'ArrowDown'
    || code === 'PageUp' || code === 'PageDown' || code === 'Home' || code === 'End'
  if (ctx.repeat && !isMove) return null

  if (key === 'Escape') return { kind: 'close' }

  // нативная кнопка: Space/Enter делает браузер, не дублируем.
  if (ctx.onNativeButton && (code === 'Space' || key === 'Enter')) return null

  if (code === 'Space') return { kind: 'play' }
  if (key === 'Enter') return { kind: 'apply' }

  // стрелки влево/вправо: повтор разрешён, Shift — по 10 кадров.
  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    return {
      kind: 'seek',
      direction: code === 'ArrowLeft' ? -1 : 1,
      tenFrames: Boolean(ctx.shift),
    }
  }

  // стрелки вверх/вниз — переход к следующей/предыдущей склейке.
  if (!ctx.shift && (code === 'ArrowUp' || code === 'ArrowDown')) {
    return { kind: 'jumpCut', direction: code === 'ArrowUp' ? 1 : -1 }
  }

  // страница/края ползунка (семантика ARIA slider; §15 ТЗ): PageUp/Down — шаг в
  // ~10% клипа, Home/End — к началу/концу.
  if (code === 'PageUp' || code === 'PageDown') {
    return { kind: 'seek', direction: code === 'PageUp' ? -1 : 1, tenFrames: false, page: true }
  }
  if (code === 'Home') return { kind: 'seek', direction: -1, tenFrames: false, edge: 'start' }
  if (code === 'End') return { kind: 'seek', direction: 1, tenFrames: false, edge: 'end' }

  // после стрелок shift не влияет на буквы/мутации.
  if (ctx.shift) return null

  switch (code) {
    case 'KeyC': return { kind: 'cut' }
    case 'KeyX': return { kind: 'toggleDrop' }
    case 'KeyQ': return { kind: 'trimLeft' }
    case 'KeyW': return { kind: 'trimRight' }
    case 'KeyI': return { kind: 'in' }
    case 'KeyO': return { kind: 'out' }
    case 'KeyS': return { kind: 'capture' }
    case 'KeyF': return { kind: 'crop' }
    case 'KeyA': return { kind: 'audio' }
    case 'KeyB': return { kind: 'drawer' }
    case 'KeyG': return { kind: 'showOnCanvas' }
    case 'KeyD': return { kind: 'downloadFrame' }
    case 'Digit0': return { kind: 'fit' }
    default: return null
  }
}