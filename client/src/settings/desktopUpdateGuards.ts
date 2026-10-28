export type DesktopUpdateGuardResult =
  | { ok: true }
  | { ok: false; message: string }

export type DesktopUpdateGuard = () => Promise<DesktopUpdateGuardResult>

export type DesktopUpdateGuardPhase = 'finalize' | 'save'

interface RegisteredGuard {
  guard: DesktopUpdateGuard
  phase: DesktopUpdateGuardPhase
  order: number
}

const guards = new Map<string, RegisteredGuard>()
let nextOrder = 0

export function registerDesktopUpdateGuard(
  key: string,
  guard: DesktopUpdateGuard,
  phase: DesktopUpdateGuardPhase = 'finalize',
): () => void {
  guards.set(key, { guard, phase, order: nextOrder++ })
  return () => {
    if (guards.get(key)?.guard === guard) guards.delete(key)
  }
}

export async function runDesktopUpdateGuards(): Promise<DesktopUpdateGuardResult> {
  const ordered = [...guards.values()].sort((left, right) => {
    const phaseOrder = (phase: DesktopUpdateGuardPhase) => phase === 'finalize' ? 0 : 1
    return phaseOrder(left.phase) - phaseOrder(right.phase) || left.order - right.order
  })
  for (const { guard } of ordered) {
    try {
      const result = await guard()
      if (!result.ok) return result
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not save work before updating',
      }
    }
  }
  return { ok: true }
}

export function clearDesktopUpdateGuardsForTests(): void {
  guards.clear()
  nextOrder = 0
}
