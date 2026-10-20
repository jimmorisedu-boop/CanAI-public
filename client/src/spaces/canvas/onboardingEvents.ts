import type { OnboardingStepId } from './onboardingModel'

const successListeners = new Set<(id: OnboardingStepId) => void>()
const targetHandlers = new Map<OnboardingTarget, Set<() => void>>()
const parkedTargets = new Map<OnboardingTarget, true>()

export type OnboardingTarget = OnboardingStepId | 'card'

export function reportOnboardingSuccess(id: OnboardingStepId): void {
  for (const listener of successListeners) listener(id)
}

export function subscribeOnboardingSuccess(listener: (id: OnboardingStepId) => void): () => void {
  successListeners.add(listener)
  return () => successListeners.delete(listener)
}

export function requestOnboardingTarget(target: OnboardingTarget): void {
  const handlers = targetHandlers.get(target)
  if (handlers && handlers.size > 0) {
    handlers.forEach((handler) => handler())
    return
  }
  parkedTargets.set(target, true)
}

export function registerOnboardingTarget(target: OnboardingTarget, handler: () => void): () => void {
  const handlers = targetHandlers.get(target) ?? new Set<() => void>()
  handlers.add(handler)
  targetHandlers.set(target, handlers)
  if (parkedTargets.has(target)) {
    parkedTargets.delete(target)
    handler()
  }
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) targetHandlers.delete(target)
  }
}
