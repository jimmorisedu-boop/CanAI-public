// Экранный диктор произносит только то, что попало в aria-live-область.
// Результат генерации ложится на холст молча: зрячий видит, как заглушка
// сменилась картинкой, а незрячий не узнаёт об этом вовсе. Здесь одна общая
// точка объявлений — чтобы не заводить по aria-live-области на каждый случай
// и не спорить, какая из них «главная».

export interface Announcement {
  text: string
  priority: 'polite' | 'assertive'
  // порядковый номер: одно и то же слово подряд диктор повторит только если
  // узел в DOM реально сменился — по этому числу и ставится key
  seq: number
}

const EMPTY: Announcement = { text: '', priority: 'polite', seq: 0 }

let current: Announcement = EMPTY
const listeners = new Set<() => void>()

export function announce(text: string, priority: Announcement['priority'] = 'polite'): void {
  const next = text.trim()
  if (!next) return
  current = { text: next, priority, seq: current.seq + 1 }
  listeners.forEach((listener) => listener())
}

export function getAnnouncement(): Announcement {
  return current
}

export function subscribeAnnouncement(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// только для тестов: убрать след предыдущего сценария
export function resetAnnouncements(): void {
  current = EMPTY
  listeners.forEach((listener) => listener())
}
