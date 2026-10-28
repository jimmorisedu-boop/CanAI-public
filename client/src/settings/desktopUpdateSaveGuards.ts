import type { DesktopUpdateGuardResult } from './desktopUpdateGuards'

export interface DesktopUpdateCloudSaveHandle {
  isWritable(): boolean
  getPendingCount(): number
  getOfflineReason(): string | null
  getRecoveryDrafts(): readonly unknown[]
  subscribeHistory(listener: () => void): () => void
  subscribeRecoveryDrafts(listener: () => void): () => void
}

export interface DesktopUpdateCloudSaveMessages {
  offline: string
  recovery: string
  wentOffline: string
  timeout: string
}

const DEFAULT_CLOUD_MESSAGES: DesktopUpdateCloudSaveMessages = {
  offline: 'The cloud board is offline. Reconnect before updating.',
  recovery: 'The cloud board has a rejected recovery draft. Resolve it before updating.',
  wentOffline: 'The cloud board went offline before its edits were confirmed.',
  timeout: 'The cloud board did not confirm its edits in time.',
}

type Timer = ReturnType<typeof setTimeout>

export interface DesktopUpdateCloudSaveOptions {
  timeoutMs?: number
  messages?: Partial<DesktopUpdateCloudSaveMessages>
  setTimeout?(callback: () => void, delayMs: number): Timer
  clearTimeout?(timer: Timer): void
}

/**
 * Wait for every queued cloud write to receive an acknowledgement before an
 * updater is allowed to restart the server. Offline and recovery states are
 * explicit refusals; a pending write is never treated as saved by a dirty bus
 * event alone.
 */
export function waitForCloudUpdateSave(
  handle: DesktopUpdateCloudSaveHandle,
  options: DesktopUpdateCloudSaveOptions = {},
): Promise<DesktopUpdateGuardResult> {
  const messages = { ...DEFAULT_CLOUD_MESSAGES, ...options.messages }
  if (!handle.isWritable() || handle.getOfflineReason()) {
    return Promise.resolve({ ok: false, message: messages.offline })
  }
  if (handle.getRecoveryDrafts().length > 0) {
    return Promise.resolve({ ok: false, message: messages.recovery })
  }
  if (handle.getPendingCount() === 0) return Promise.resolve({ ok: true })

  const setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer))
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000)

  return new Promise((resolve) => {
    let settled = false
    let timeout: Timer | undefined
    let stopHistory = () => {}
    let stopRecovery = () => {}
    const finish = (result: DesktopUpdateGuardResult) => {
      if (settled) return
      settled = true
      if (timeout != null) clearTimer(timeout)
      stopHistory()
      stopRecovery()
      resolve(result)
    }
    const check = () => {
      if (!handle.isWritable() || handle.getOfflineReason()) {
        finish({ ok: false, message: messages.wentOffline })
        return
      }
      if (handle.getRecoveryDrafts().length > 0) {
        finish({ ok: false, message: messages.recovery })
        return
      }
      if (handle.getPendingCount() === 0) finish({ ok: true })
    }
    stopHistory = handle.subscribeHistory(check)
    stopRecovery = handle.subscribeRecoveryDrafts(check)
    timeout = setTimer(() => finish({ ok: false, message: messages.timeout }), timeoutMs)
    check()
  })
}

export async function flushLocalUpdateSave(
  handle: { flushAndWait(): Promise<unknown> },
  failureMessage = 'The local board could not confirm its latest save. Try again before updating.',
): Promise<DesktopUpdateGuardResult> {
  try {
    await handle.flushAndWait()
    return { ok: true }
  } catch {
    return { ok: false, message: failureMessage }
  }
}
