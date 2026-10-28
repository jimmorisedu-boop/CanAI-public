import { askConfirm } from '../../../ui/confirmBus'
import { notifyInTimeline } from './timelineNotice'

interface TimelineLeaveGuard {
  active(): boolean
  dirty(): boolean
  busy(): boolean
  discard(): void
}

let current: TimelineLeaveGuard | null = null
let pending: { owner: TimelineLeaveGuard; promise: Promise<boolean> } | null = null

export function registerTimelineLeaveGuard(guard: TimelineLeaveGuard): () => void {
  current = guard
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (current !== guard || !guard.active() || (!guard.dirty() && !guard.busy())) return
    event.preventDefault()
    event.returnValue = ''
  }
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload)
  return () => {
    if (current === guard) current = null
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload)
  }
}

/** Общая защита выхода из редактора, с доски и смены доски. */
export function requestTimelineLeave(): Promise<boolean> {
  const guard = current
  if (!guard || !guard.active()) return Promise.resolve(true)
  if (guard.busy()) {
    notifyInTimeline({ kind: 'info', tone: 'warn', message: 'Wait for video processing to finish before leaving.', replaceKey: 'timeline-leave' })
    return Promise.resolve(false)
  }
  if (!guard.dirty()) {
    guard.discard()
    return Promise.resolve(true)
  }
  if (pending?.owner === guard) return pending.promise
  const promise = askConfirm({
    title: 'Unapplied video edits',
    detail: 'Video edits have not been applied. Apply them before leaving to keep the edited clips on the board.',
    confirmLabel: 'Leave without applying',
    cancelLabel: 'Continue editing',
    danger: true,
  }).then(confirmed => {
    if (!confirmed || current !== guard || guard.busy()) return false
    guard.discard()
    return true
  }).finally(() => {
    if (pending?.promise === promise) pending = null
  })
  pending = { owner: guard, promise }
  return promise
}
