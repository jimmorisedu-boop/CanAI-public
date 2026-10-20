import type { PasteChoice } from './konva/pasteDecision'

// Чей ход по Ctrl+V, когда в буфере обмена лежит макрос: ряда кнопок макросов
// или холста. Вставку ловят оба — холст первым (он слушает окно на погружении),
// ряд за ним (useMacroClipboard). Решение одно и живёт здесь, без React и без
// сети: холсту незачем тянуть к себе каталоги ради одной развилки.

type RowHovered = () => boolean
const rows = new Set<RowHovered>()

/** Ряд кнопок макросов сообщает о себе, пока он на экране. Возвращает «снять». */
export function registerMacroRow(hovered: RowHovered): () => void {
  rows.add(hovered)
  return () => {
    rows.delete(hovered)
  }
}

/** Стоит ли курсор над рядом кнопок макросов — тогда макрос из буфера вставит ряд. */
export function macroRowHovered(): boolean {
  for (const hovered of rows) if (hovered()) return true
  return false
}

export const MACRO_PASTE_HINT = "A macro is in the clipboard. Hover over the macro row in the prompt panel and press Ctrl+V to paste it"

export type MacroPasteRoute =
  /** Макроса в буфере нет либо вставка не про текст буфера — холст работает как обычно. */
  | 'canvas'
  /** Курсор над рядом макросов: вставит ряд, холст не вмешивается. */
  | 'row'
  /** Своя копия объектов свежее макроса, оставшегося в буфере, — холст вставляет её. */
  | 'objects'
  /** Холсту вставлять нечего: говорим, куда вести курсор. */
  | 'hint'

/**
 * Что холсту делать с Ctrl+V, когда в буфере макрос.
 *
 * `choice` — то, что холст решил бы для любого другого текста (decidePaste).
 *
 * ⚠️ Раньше холст, увидев макрос, просто выходил — ещё ДО этого решения. Два
 * следствия. Своя копия объектов, не доехавшая до системного буфера (там
 * остался макрос), не вставлялась вовсе: Ctrl+V молчал. И человек, нажавший
 * Ctrl+V над холстом, не получал ни макроса, ни слова о том, куда вести курсор.
 *
 * ⚠️ Курсор над рядом макросов важнее «своей копии объектов»: пометка «копия не
 * доехала до буфера» живёт до следующего копирования на холсте, а макрос могли
 * скопировать уже после неё. Без этого правила Ctrl+C по макросу и Ctrl+V над
 * рядом клали бы на доску давние объекты — и так до следующего удачного
 * копирования на холсте.
 */
export function routeMacroPaste(input: {
  macroInClipboard: boolean
  choice: PasteChoice
  overMacroRow: boolean
}): MacroPasteRoute {
  if (!input.macroInClipboard) return 'canvas'
  // Файлы из буфера и поле ввода — не про текст буфера: макрос тут ни при чём.
  if (input.choice !== 'text' && input.choice !== 'internal') return 'canvas'
  if (input.overMacroRow) return 'row'
  return input.choice === 'internal' ? 'objects' : 'hint'
}
