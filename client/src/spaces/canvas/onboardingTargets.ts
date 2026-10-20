import { announce } from '../../ui/announce'
import { registerOnboardingTarget, type OnboardingTarget } from './onboardingEvents'

export interface OnboardingTargetDeps {
  announce(message: string): void
  schedule(run: () => void, delayMs: number): number
  cancel(timer: number): void
}

export interface TargetProductActions {
  generate(): void
  undo(): void
  restore(): void
  archive(): void
  pin(): void
  export(): void
}

type Defer = (run: () => void) => void
type OnboardingRegistrar = (target: OnboardingTarget, handler: () => void) => () => void

const browserDeps: OnboardingTargetDeps = {
  announce,
  schedule: (run, delayMs) => window.setTimeout(run, delayMs),
  cancel: (timer) => window.clearTimeout(timer),
}

const activePulses = new WeakMap<HTMLElement, () => void>()

export function registerPromptOnboardingTargets(
  handlers: ReturnType<typeof createPromptTargetHandlers>,
  register: OnboardingRegistrar = registerOnboardingTarget,
): () => void {
  const unregisterFirst = register('first-generation', handlers.firstGeneration)
  const unregisterReference = register('reference-generation', handlers.referenceGeneration)
  return () => {
    unregisterFirst()
    unregisterReference()
  }
}

export function registerRecoveryOnboardingTarget(
  handler: () => void,
  register: OnboardingRegistrar = registerOnboardingTarget,
): () => void {
  return register('recovery', handler)
}

export function registerSaveForLaterOnboardingTarget(
  handler: () => void,
  register: OnboardingRegistrar = registerOnboardingTarget,
): () => void {
  return register('save-for-later', handler)
}

export function registerExportOnboardingTarget(
  handler: () => void,
  register: OnboardingRegistrar = registerOnboardingTarget,
): () => void {
  return register('export', handler)
}

export function registerCardOnboardingTarget(
  handler: () => void,
  register: OnboardingRegistrar = registerOnboardingTarget,
): () => void {
  return register('card', handler)
}

export function showOnboardingTarget(
  element: HTMLElement | null,
  options: { focus?: boolean; message: string; durationMs?: number },
  deps: OnboardingTargetDeps = browserDeps,
): () => void {
  if (!element) return () => {}

  activePulses.get(element)?.()
  element.classList.add('onboarding-target-pulse')
  if (options.focus) element.focus({ preventScroll: true })
  deps.announce(options.message)

  let disposed = false
  let timer: number | null = null
  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (timer !== null) deps.cancel(timer)
    element.classList.remove('onboarding-target-pulse')
    if (activePulses.get(element) === cleanup) activePulses.delete(element)
  }
  activePulses.set(element, cleanup)
  timer = deps.schedule(cleanup, options.durationMs ?? 2200)
  return cleanup
}

export function createPromptTargetHandlers<T extends { id: string }>(deps: {
  switchToPrompt(): void
  defer: Defer
  focusPrompt(): void
  pulsePrompt(): void
  firstCanvasReference(): T | null
  focusCanvasReference(reference: T): void
  pulseReferences(): void
  announce(message: string): void
  product?: Pick<TargetProductActions, 'generate'>
}) {
  return {
    firstGeneration: () => {
      deps.switchToPrompt()
      deps.defer(() => {
        deps.focusPrompt()
        deps.pulsePrompt()
      })
    },
    referenceGeneration: () => {
      deps.switchToPrompt()
      deps.defer(() => {
        const reference = deps.firstCanvasReference()
        if (!reference) {
          deps.announce("Create your first result first.")
          return
        }
        deps.focusCanvasReference(reference)
        deps.pulseReferences()
      })
    },
  }
}

export function createRecoveryTarget(deps: {
  pulseUndoRow(): void
  focusModalAction(): void
  product?: Pick<TargetProductActions, 'undo' | 'restore'>
}): () => void {
  return () => {
    deps.pulseUndoRow()
    deps.focusModalAction()
  }
}

export function createRecoveryHelpTarget(deps: {
  openHelp(): void
  product?: Pick<TargetProductActions, 'undo' | 'restore'>
}): () => void {
  return () => deps.openHelp()
}

export function createArchiveTarget(deps: {
  focus(): void
  pulse(): void
  product?: Pick<TargetProductActions, 'archive'>
}): () => void {
  return () => {
    deps.focus()
    deps.pulse()
  }
}

export function createAssetShelfTarget(deps: {
  pulse(): void
  product?: Pick<TargetProductActions, 'pin'>
}): () => void {
  return () => deps.pulse()
}

export function createExportTarget(deps: {
  focus(): void
  pulse(): void
  product?: Pick<TargetProductActions, 'export'>
}): () => void {
  return () => {
    deps.focus()
    deps.pulse()
  }
}

export function createCardTarget(deps: {
  expand(): void
  defer: Defer
  focusAction(): void
  pulse(): void
  product?: Partial<TargetProductActions>
}): () => void {
  return () => {
    deps.expand()
    deps.defer(() => {
      deps.focusAction()
      deps.pulse()
    })
  }
}

export function createHelpCardTarget(deps: {
  closeHelp(): void
  defer: Defer
  requestCard(): void
  product?: Partial<TargetProductActions>
}): () => void {
  return () => {
    deps.closeHelp()
    deps.defer(deps.requestCard)
  }
}
