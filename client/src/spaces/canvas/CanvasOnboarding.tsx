import { type RefObject, useEffect, useRef, useState } from 'react'
import { HELP_TOPICS, type HelpTopic } from '../../help/content/index'
import { openHelp } from '../../help/helpBus'
import { IconClose, IconFit, IconMinus } from '../../ui/icons'
import type { CanvasStore } from './konva/canvasStore'
import { useContentVersion } from './konva/useStore'
import { requestOnboardingTarget, type OnboardingTarget } from './onboardingEvents'
import { createCardTarget, registerCardOnboardingTarget, showOnboardingTarget } from './onboardingTargets'
import {
  ONBOARDING_STEPS,
  onboardingProgress,
  type OnboardingDocument,
  type OnboardingStepId,
  type OnboardingView,
} from './onboardingModel'
import { onboardingStore, useOnboardingSnapshot } from './onboardingStore'

type CanvasOnboardingMode = 'hidden' | OnboardingView

const TOUR_IDS = ['import', 'references', 'assistant-photos', 'assets'] as const
type TourId = typeof TOUR_IDS[number]

const TOUR_FALLBACKS: Record<TourId, HelpTopic> = {
  import: {
    id: 'import', category: 'Getting started', title: 'Import an image or video',
    summary: 'Bring existing work onto the board before you start.', keywords: ['import', 'upload'],
    steps: [{ title: 'Drop or paste media', body: 'Drop a file on the board, paste an image, or use the import action.', image: '', alt: 'Import media onto the board' }],
  },
  references: {
    id: 'references', category: 'Getting started', title: 'Add a reference',
    summary: 'Use an image or a selected board item to guide a result.', keywords: ['reference', 'image'],
    steps: [{ title: 'Select a reference', body: 'Choose a board item or add an image in the prompt panel.', image: '', alt: 'Add a reference to a prompt' }],
  },
  'assistant-photos': {
    id: 'assistant-photos', category: 'Getting started', title: 'Ask the assistant about photos',
    summary: 'Use the assistant to inspect, compare, or describe a visual.', keywords: ['assistant', 'photo', 'image'],
    steps: [{ title: 'Attach a photo', body: 'Drag a photo from the Canvas into Assistant, then check its thumbnail in the composer.', image: '', alt: 'Attach a photo to Assistant' }],
  },
  assets: {
    id: 'assets', category: 'Getting started', title: 'Keep assets close',
    summary: 'Save useful references and results so they are easy to find later.', keywords: ['assets', 'save'],
    steps: [{ title: 'Save for later', body: 'Pin an item or open Assets to keep useful work nearby.', image: '', alt: 'Save an asset for later' }],
  },
}

function tourTopic(id: TourId): HelpTopic {
  return HELP_TOPICS.find((topic) => topic.id === id) ?? TOUR_FALLBACKS[id]
}

export interface OnboardingActionCallbacks {
  onSetView(view: OnboardingView): void
  onSkip(id: OnboardingStepId): void
  onRequestTarget(target: OnboardingTarget): void
  onComplete?(id: OnboardingStepId): void
}

export interface OnboardingActionModel {
  show(id: OnboardingStepId): void
  skip(id: OnboardingStepId): void
  setView(view: OnboardingView): void
}

export function createOnboardingActionModel(callbacks: OnboardingActionCallbacks): OnboardingActionModel {
  return {
    show: (id) => callbacks.onRequestTarget(id),
    skip: (id) => callbacks.onSkip(id),
    setView: (view) => callbacks.onSetView(view),
  }
}

export function onboardingCanvasMode(document: OnboardingDocument): CanvasOnboardingMode {
  return onboardingProgress(document) === ONBOARDING_STEPS.length || document.view === 'dismissed'
    ? 'hidden'
    : document.view
}

export function onboardingProgressLabel(document: OnboardingDocument): string {
  return `First steps: ${onboardingProgress(document)} of ${ONBOARDING_STEPS.length}`
}

function OnboardingHeader({
  expanded,
  targetActionRef,
  actions,
}: {
  expanded: boolean
  targetActionRef?: RefObject<HTMLButtonElement>
  actions: OnboardingActionModel
}) {
  const viewLabel = expanded ? 'Collapse first steps' : 'Expand first steps'
  return (
    <div className="onboarding-heading">
      <div>
        <strong>First steps</strong>
        <span className="onboarding-heading-subtitle">A quick, optional tour</span>
      </div>
      <div className="onboarding-heading-actions">
        <button
          ref={targetActionRef}
          type="button"
          className="onboarding-icon-action"
          aria-label={viewLabel}
          title={viewLabel}
          onClick={() => actions.setView(expanded ? 'compact' : 'expanded')}
        >
          {expanded ? <IconMinus aria-hidden="true" /> : <IconFit aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="onboarding-icon-action onboarding-close"
          aria-label="Close first steps"
          title="Close first steps"
          onClick={() => actions.setView('dismissed')}
        >
          <IconClose aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function CanvasOnboardingView({
  document,
  status,
  isEmpty,
  targetActionRef,
  actions,
  tutorialIndex,
  onTutorialIndexChange,
}: {
  document: OnboardingDocument | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  isEmpty: boolean
  targetActionRef?: RefObject<HTMLButtonElement>
  actions: OnboardingActionModel
  tutorialIndex?: number
  onTutorialIndexChange?: (index: number) => void
}) {
  const [localIndex, setLocalIndex] = useState(0)
  if (status === 'loading') return null

  if (status === 'error') {
    if (!isEmpty) return null
    return (
      <aside className="canvas-onboarding canvas-onboarding-fallback" aria-label="Getting started in CanAI">
        <strong>Start here</strong>
        <p>Take a short tour of importing, references, the assistant, and saved assets.</p>
        <button type="button" className="onboarding-primary-action" onClick={() => openHelp('quick-start')}>Open Help</button>
      </aside>
    )
  }

  if (!document) return null
  const mode = onboardingCanvasMode(document)
  if (mode === 'hidden') return null

  const index = Math.max(0, Math.min(tutorialIndex ?? localIndex, TOUR_IDS.length))
  const setIndex = (next: number): void => {
    const bounded = Math.max(0, Math.min(next, TOUR_IDS.length))
    onTutorialIndexChange?.(bounded)
    if (!onTutorialIndexChange) setLocalIndex(bounded)
  }

  if (mode === 'collapsed') {
    return (
      <button ref={targetActionRef} type="button" className="canvas-onboarding onboarding-collapsed" onClick={() => actions.setView('expanded')}>
        First steps
      </button>
    )
  }

  const done = index >= TOUR_IDS.length
  const topic = done ? null : tourTopic(TOUR_IDS[index])
  const activeTopic = topic ?? TOUR_FALLBACKS[TOUR_IDS[0]]
  const activeStep = activeTopic.id === 'assistant-photos'
    ? (activeTopic.steps[1] ?? activeTopic.steps[0])
    : activeTopic.steps[0]
  const activeBody = activeTopic.id === 'assistant-photos'
    ? 'Drag a photo from Canvas into Assistant. Check the thumbnail in the composer.'
    : (activeStep?.body || activeTopic.summary)
  const image = activeStep?.image

  return (
    <section
      className={`canvas-onboarding onboarding-tour onboarding-${mode}`}
      aria-label="CanAI first steps"
      data-view={mode}
      data-step={done ? 'done' : activeTopic.id}
    >
      <OnboardingHeader expanded={mode === 'expanded'} targetActionRef={targetActionRef} actions={actions} />
      {done ? (
        <div className="onboarding-tour-done">
          <div className="onboarding-done-mark" aria-hidden="true">✓</div>
          <div>
            <h3>You’re ready to explore</h3>
            <p>Come back to Help whenever you want a quick reminder.</p>
          </div>
          <div className="onboarding-tour-done-actions">
            <button type="button" className="onboarding-secondary-action" onClick={() => actions.setView('dismissed')}>Done</button>
            <button type="button" className="onboarding-primary-action" onClick={() => { actions.setView('dismissed'); openHelp('quick-start') }}>Open Help</button>
          </div>
        </div>
      ) : (
        <>
          <div className="onboarding-tour-progress" aria-label={`Step ${index + 1} of ${TOUR_IDS.length}`}>
            <span>Step {index + 1} of {TOUR_IDS.length}</span>
            <span className="onboarding-tour-dots" aria-hidden="true">
              {TOUR_IDS.map((id, dotIndex) => <i key={id} className={dotIndex === index ? 'active' : dotIndex < index ? 'past' : ''} />)}
            </span>
          </div>
          <div className="onboarding-tour-main">
            {image && <img className="onboarding-tour-image" src={image} alt={activeStep?.alt || activeTopic.title} />}
            <div className="onboarding-tour-copy">
              <h3>{activeTopic.id === 'assistant-photos' ? activeStep?.title : activeTopic.title}</h3>
              <p>{activeBody}</p>
            </div>
          </div>
          <div className="onboarding-tour-actions">
            <button type="button" className="onboarding-secondary-action" disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
            <button type="button" className="onboarding-secondary-action" onClick={() => actions.setView('dismissed')}>Skip</button>
            <button type="button" className="onboarding-primary-action" onClick={() => setIndex(index + 1)}>{index === TOUR_IDS.length - 1 ? 'Finish' : 'Next'}</button>
          </div>
        </>
      )}
    </section>
  )
}

export function CanvasOnboarding({ store }: { store: CanvasStore }) {
  const { status, document } = useOnboardingSnapshot()
  const cardRef = useRef<HTMLDivElement>(null)
  const targetActionRef = useRef<HTMLButtonElement>(null)
  const [tutorialIndex, setTutorialIndex] = useState(0)
  const previousView = useRef<OnboardingView | null>(null)
  useContentVersion(store)

  useEffect(() => registerCardOnboardingTarget(createCardTarget({
    expand: () => {
      void onboardingStore.setView('expanded')
    },
    defer: (run) => window.requestAnimationFrame(run),
    focusAction: () => targetActionRef.current?.focus({ preventScroll: true }),
    pulse: () => showOnboardingTarget(cardRef.current, {
      message: 'This is the first-steps guide.',
    }),
  })), [])

  useEffect(() => {
    const nextView = document?.view ?? null
    if (nextView === 'expanded' && previousView.current === 'dismissed') setTutorialIndex(0)
    previousView.current = nextView
  }, [document?.view])

  const actions = createOnboardingActionModel({
    onSetView: (view) => { void onboardingStore.setView(view) },
    onSkip: (id) => { void onboardingStore.skip(id) },
    onRequestTarget: requestOnboardingTarget,
  })

  return (
    <div ref={cardRef} className="onboarding-card-target">
      <CanvasOnboardingView
        document={document}
        status={status}
        isEmpty={store.isEmpty()}
        targetActionRef={targetActionRef}
        actions={actions}
        tutorialIndex={tutorialIndex}
        onTutorialIndexChange={setTutorialIndex}
      />
    </div>
  )
}
