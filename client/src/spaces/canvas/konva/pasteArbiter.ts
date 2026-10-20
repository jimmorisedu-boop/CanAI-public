export interface PasteTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const browserTimer: PasteTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class CanvasPasteArbiter {
  private pending: (() => void) | null = null
  private timerHandle: unknown = null

  constructor(
    private readonly timer: PasteTimer = browserTimer,
    private readonly fallbackDelayMs = 50,
  ) {}

  schedule(action: () => void): void {
    this.cancel()
    this.pending = action
    this.timerHandle = this.timer.set(() => this.flush(), this.fallbackDelayMs)
  }

  settle(hasMedia: boolean): boolean {
    const action = this.takePending()
    if (!action) return false
    if (!hasMedia) action()
    return true
  }

  cancel(): void {
    this.takePending()
  }

  private flush(): void {
    const action = this.pending
    this.pending = null
    this.timerHandle = null
    action?.()
  }

  private takePending(): (() => void) | null {
    const action = this.pending
    this.pending = null
    if (this.timerHandle !== null) {
      this.timer.clear(this.timerHandle)
      this.timerHandle = null
    }
    return action
  }
}

export const canvasPasteArbiter = new CanvasPasteArbiter()
