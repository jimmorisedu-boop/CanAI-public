export class GenerationShuttingDownError extends Error {
  constructor() {
    super('CanAI is shutting down — try again after restart')
    this.name = 'GenerationShuttingDownError'
  }
}

export interface GenerationLease {
  release(): void
}

export class GenerationGate {
  private closed = false
  private activeLeases = 0
  private readonly drainWaiters = new Set<() => void>()

  get shuttingDown(): boolean {
    return this.closed
  }

  tryEnter(): GenerationLease | null {
    if (this.closed) return null
    this.activeLeases += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.activeLeases -= 1
        if (this.activeLeases !== 0) return
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      },
    }
  }

  close(): void {
    this.closed = true
  }

  waitForDrained(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve)
    })
  }

  async closeAndWait(): Promise<void> {
    this.close()
    await this.waitForDrained()
  }
}

export async function withGenerationAdmission<T>(
  gate: GenerationGate,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = gate.tryEnter()
  if (!lease) throw new GenerationShuttingDownError()
  try {
    return await operation()
  } finally {
    lease.release()
  }
}

export const generationGate = new GenerationGate()

// ⚠️ 'legacy-cloud' остаётся ЗНАЧЕНИЕМ ради старых jobs.json: такие задачи
// давно завершены, но выбросить значение — значит не прочитать файл целиком.
export type GenerationRoute = 'mock' | 'local'

export class GenerationRouteError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'GenerationRouteError'
  }
}

export function selectGenerationRoute(input: {
  projectSource: 'local'
  localConfigured: boolean
  mockMode: boolean
}): GenerationRoute {
  if (input.mockMode) return 'mock'
  if (!input.localConfigured) throw new GenerationRouteError('Add key fal.ai in settings', 'local-provider-required')
  return 'local'
}
