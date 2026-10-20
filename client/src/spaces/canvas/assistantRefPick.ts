import type { SelectionRef } from './konva/selection'

// Клик по миниатюре референса в ленте помощника (просьба пользователя
// 20.08.2026: «чтобы они появлялись как рефы в промпте и выделялись на
// канвасе»).
//
// Ключевая мысль: отдельного «добавить в референсы» не нужно. Чипы промпт-бара
// — живое зеркало выделения канваса, поэтому достаточно ВЫДЕЛИТЬ объект, и он
// сам станет референсом. Так же ведёт себя клик по объекту на доске, то есть
// новый жест не заводит третье поведение, а повторяет привычное.
//
// Объекта может уже не быть: его удалили, заархивировали или он приехал из
// другой доски. Тогда выделять нечего — и мы кладём ручной чип по ссылке, тем
// же путём, что полка ассетов. Молчать нельзя: человек кликнул по картинке,
// которую видит, и обязан получить её в референсах.

export type RefPickAction =
  | { kind: 'select'; ids: string[] }
  | { kind: 'manual'; ref: SelectionRef }
  | { kind: 'none' }

export interface RefPickContext {
  /** Объект всё ещё лежит на доске. */
  onBoard: boolean
  /** Клик с Ctrl/Shift — добавить к выделению, а не заменить его. */
  additive: boolean
  /** Что выделено сейчас. */
  selected: string[]
}

export function planRefPick(ref: SelectionRef, context: RefPickContext): RefPickAction {
  if (context.onBoard) {
    if (!context.additive) return { kind: 'select', ids: [ref.shapeId] }
    // Повторный клик с Ctrl снимает — так же, как на холсте.
    const ids = context.selected.includes(ref.shapeId)
      ? context.selected.filter((id) => id !== ref.shapeId)
      : [...context.selected, ref.shapeId]
    return { kind: 'select', ids }
  }
  // Объекта нет, но ссылка на файл есть — референс всё равно можно дать.
  if (ref.src || ref.text) return { kind: 'manual', ref }
  return { kind: 'none' }
}
