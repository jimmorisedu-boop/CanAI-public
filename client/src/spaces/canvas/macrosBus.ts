// Мини-шина: после сохранения макроса в нодовом пространстве панель
// макросов на канвасе должна обновить список.
type Handler = () => void

const handlers = new Set<Handler>()

export function onMacrosChanged(h: Handler): () => void {
  handlers.add(h)
  return () => handlers.delete(h)
}

export function notifyMacrosChanged(): void {
  handlers.forEach((h) => h())
}
