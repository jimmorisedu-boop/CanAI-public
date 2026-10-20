import type { SelectionRef } from './konva/selection'

// Мостик «добавить ассет в промпт»: полка ассетов (AssetBar) → промпт-бар.
// Клик по закреплённому ассету шлёт готовый референс, промпт-бар добавляет
// его чипом (вручную, поверх выделения канваса).
type Handler = (ref: SelectionRef) => void

let handler: Handler | null = null

export function onAddPromptAsset(h: Handler | null): void {
  handler = h
}

export function requestAddPromptAsset(ref: SelectionRef): void {
  handler?.(ref)
}
