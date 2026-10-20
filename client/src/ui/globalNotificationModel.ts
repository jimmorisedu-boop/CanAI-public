import type { ToastEvent, ToastMessage } from '../spaces/canvas/toastBus'

export function applyToastEvent(
  current: readonly ToastMessage[],
  event: ToastEvent,
): ToastMessage[] {
  if (event.type === 'dismiss') {
    return current.filter((item) => item.replaceKey !== event.replaceKey)
  }

  const { toast } = event
  const kept = toast.replaceKey
    ? current.filter((item) => item.replaceKey !== toast.replaceKey)
    : current
  return [...kept.slice(-3), toast]
}
