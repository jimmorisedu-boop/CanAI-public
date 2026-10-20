export const ONBOARDING_STEPS = [
  { id: 'first-generation', title: "Create your first result" },
  { id: 'reference-generation', title: "Make a version with a reference" },
  { id: 'recovery', title: "Restore edit" },
  { id: 'save-for-later', title: "Save this for later" },
  { id: 'export', title: "Export result" },
] as const

export type OnboardingStepId = typeof ONBOARDING_STEPS[number]['id']
export type OnboardingStepState = 'pending' | 'done' | 'skipped'
export type OnboardingView = 'expanded' | 'compact' | 'collapsed' | 'dismissed'

export interface OnboardingDocument {
  version: 1
  steps: Record<OnboardingStepId, OnboardingStepState>
  view: OnboardingView
  completedAt: number | null
}

export type OnboardingPatch =
  | { step: { id: OnboardingStepId; state: Exclude<OnboardingStepState, 'pending'> } }
  | { view: OnboardingView }
  | { reset: true }

export function onboardingProgress(document: OnboardingDocument): number {
  return ONBOARDING_STEPS.filter(({ id }) => document.steps[id] !== 'pending').length
}

export function emptyOnboardingDocument(): OnboardingDocument {
  return {
    version: 1,
    steps: {
      'first-generation': 'pending',
      'reference-generation': 'pending',
      recovery: 'pending',
      'save-for-later': 'pending',
      export: 'pending',
    },
    view: 'expanded',
    completedAt: null,
  }
}
