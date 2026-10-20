export type NoticeTimingTone = 'info' | 'success' | 'warning' | 'error'
// Две секунды: сообщение читается за миг, а висящая плашка загораживает
// работу (просьба пользователя 18.08.2026 — «буквально секунды две»).
// Дольше живёт только то, где есть кнопка: её надо успеть нажать.
export const AUTO_DISMISS_MS = 2000
export const AUTO_DISMISS_WITH_ACTION_MS = 6000

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export function autoDismissDelay(
  tone: NoticeTimingTone,
  requestedMs: number | undefined,
  hasAction = false,
): number | null {
  if (tone !== 'info' && tone !== 'success') return null
  if (!Number.isFinite(requestedMs) || Number(requestedMs) <= 0) return null
  // С кнопкой держим дольше запрошенного: две секунды на «Отменить» — это
  // приглашение промахнуться, а гасить сообщение раньше его же действия
  // бессмысленно.
  return hasAction ? Math.max(Number(requestedMs), AUTO_DISMISS_WITH_ACTION_MS) : Number(requestedMs)
}

export function scheduleAutoDismiss({
  tone,
  requestedMs,
  onDismiss,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}: {
  tone: NoticeTimingTone
  requestedMs: number | undefined
  onDismiss: (() => void) | undefined
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}): () => void {
  const delay = autoDismissDelay(tone, requestedMs)
  if (delay === null || !onDismiss) return () => {}
  const handle = setTimer(onDismiss, delay)
  return () => clearTimer(handle)
}
