// Мостик для сигнала «заполни промпт-бар данными этого объекта»:
// двойной клик по картинке/видео → запрос здесь → PromptBar подставляет prompt+modelId.
// Аналог editorBus, но без открытия редактора.

export interface PromptFillRequest {
  shapeId: string
  prompt?: string
  modelId?: string
  referenceIds?: string[]
}

type Handler = (request: PromptFillRequest) => void

let handler: Handler | null = null

export function onPromptFill(h: Handler | null): void {
  handler = h
}

export function requestPromptFill(request: PromptFillRequest): void {
  handler?.(request)
}
