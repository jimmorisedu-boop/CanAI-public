import { newId } from '../../ui/ids'
import { systemMessage } from '../../ui/systemMessage'
export interface ToastMessage {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
  action?: { label: string; run(): void }
  // Сообщение о повторяемом действии: новое ВЫТЕСНЯЕТ предыдущее с тем же
  // ключом, а не встаёт под ним. Удержанный Ctrl+Z иначе навалил бы стопку
  // почти одинаковых реплик — шум вместо ответа на вопрос «что отменилось».
  replaceKey?: string
}

export type ToastEvent =
  | { type: 'show'; toast: ToastMessage }
  | { type: 'dismiss'; replaceKey: string }

type ToastListener = (event: ToastEvent) => void
const listeners = new Set<ToastListener>()

export function onToast(fn: ToastListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notify(input: Omit<ToastMessage, 'id'>): void {
  // Error toasts are an application-owned presentation boundary. Older
  // servers can still send Russian text here; translate that field while
  // leaving ordinary info/success text (which may contain user content)
  // untouched.
  const toast = {
    ...input,
    message: input.kind === 'error' ? systemMessage(input.message) : input.message,
    id: newId(),
  }
  listeners.forEach((fn) => fn({ type: 'show', toast }))
}

export function dismissToast(replaceKey: string): void {
  listeners.forEach((fn) => fn({ type: 'dismiss', replaceKey }))
}

export function showToast(message: string): void {
  notify({ kind: 'info', message })
}

export function showErrorToast(message: string): void {
  notify({ kind: 'error', message })
}
