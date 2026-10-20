import type { MacroScope } from '../../api'
import type { ProjectSource } from '../../types'

// Мостик «открыть редактор макроса слота» (ряд слотов → App).
export interface MacroEditRequest {
  slot: number
  macroId: string | null // null = слот пуст, создаём новый макрос
  // 'assistant' — цепочка помощника: в палитре только LLM/Текст/Вход/Выход,
  // результат уходит сообщениями в разговор, а не на холст
  scope?: MacroScope
  source?: ProjectSource
  cloudScope?: 'team' | 'personal'
}

type Handler = (request: MacroEditRequest) => void

let handler: Handler | null = null

export function onMacroEdit(h: Handler | null): void {
  handler = h
}

export function requestMacroEdit(request: MacroEditRequest): void {
  handler?.(request)
}
