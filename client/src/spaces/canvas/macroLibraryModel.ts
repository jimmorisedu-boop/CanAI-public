import type { Macro } from '../../api'
import { pluralWithCount } from '../../ui/plural'

// «3 нод» — не по-русски; склоняем, как везде в интерфейсе
export const NODES: [string, string, string] = ["node", "nodes", "node"]
export const STEPS: [string, string, string] = ["step", "steps", "steps"]

// Кнопок-слотов девять в каждой области. Потолок жёсткий (решение пользователя):
// десятый макрос не создаётся, а не уезжает в невидимые.
export const MACRO_SLOT_COUNT = 9

export function freeMacroSlots(macros: Macro[]): number[] {
  const taken = new Set(macros.map((macro) => macro.slot).filter((slot) => slot != null))
  return Array.from({ length: MACRO_SLOT_COUNT }, (_, slot) => slot).filter(
    (slot) => !taken.has(slot),
  )
}

export const MENU_WIDTH = 160
export const MENU_HEIGHT = 104
const EDGE = 8

// Меню строки рисуется порталом с position:fixed, поэтому место считаем сами:
// прижимаем к правому краю кнопки, а у нижних строк раскрываем ВВЕРХ — иначе
// список упирался в край прокручиваемой панели и обрезался.
export function menuPosition(
  rect: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.min(
    Math.max(EDGE, rect.right - MENU_WIDTH),
    Math.max(EDGE, viewport.width - MENU_WIDTH - EDGE),
  )
  const below = rect.bottom + 4
  const flip = below + MENU_HEIGHT > viewport.height - EDGE
  const top = flip
    ? Math.max(EDGE, rect.top - MENU_HEIGHT - 4)
    : below
  return { left, top }
}

export function describeMacro(input: {
  orphan: boolean
  ready: boolean
  nodeCount: number
  unit: [string, string, string]
  /** Макрос из области, которой в приложении больше нет (цепочки помощника). */
  legacy?: boolean
}): string {
  // ⚠️ Такой макрос НЕЛЬЗЯ просто не показывать. У пользователя в macros.json
  // лежала «Сценарий» с scope: 'assistant' — цепочек помощника давно нет, и
  // макрос стал невидимым: ни открыть, ни удалить, а ссылки на медиа он держит
  // и уборке мешает (найдено 20.08.2026). Показываем и даём убрать.
  if (input.legacy) return "Remains from the previous version - there are no more assistant chains"
  if (input.orphan) return "All nine buttons are occupied - macro without button"
  return `${pluralWithCount(input.nodeCount, input.unit)} · ${input.ready ? "ready" : "draft"}`
}
