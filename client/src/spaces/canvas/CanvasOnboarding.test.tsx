import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasOnboardingView,
  createOnboardingActionModel,
  onboardingCanvasMode,
  onboardingProgressLabel,
} from './CanvasOnboarding.js'
import { emptyOnboardingDocument, type OnboardingDocument } from './onboardingModel.js'
import { OnboardingHelpSection } from '../../ShortcutsModal.js'

function documentWith(
  steps: Partial<OnboardingDocument['steps']>,
  view: OnboardingDocument['view'] = 'expanded',
): OnboardingDocument {
  return { ...emptyOnboardingDocument(), steps: { ...emptyOnboardingDocument().steps, ...steps }, view }
}

const actions = createOnboardingActionModel({ onSetView: () => {}, onSkip: () => {}, onRequestTarget: () => {} })

test('first-run guide presents one step without a checklist or guilt states', () => {
  const html = renderToStaticMarkup(
    <CanvasOnboardingView document={documentWith({})} status="ready" isEmpty actions={actions} />,
  )
  assert.match(html, /aria-label="CanAI first steps"/)
  assert.match(html, /Step 1 of 4/)
  assert.doesNotMatch(html, /Learn more/)
  assert.match(html, />Next</)
  assert.match(html, />Skip</)
  assert.doesNotMatch(html, /<ol|missed|not completed|completed/)
})

test('collapsed and compact modes keep one close and one view control', () => {
  const document = documentWith({})
  const expandedHtml = renderToStaticMarkup(<CanvasOnboardingView document={document} status="ready" isEmpty actions={actions} />)
  const compactHtml = renderToStaticMarkup(<CanvasOnboardingView document={{ ...document, view: 'compact' }} status="ready" isEmpty actions={actions} />)
  const collapsedHtml = renderToStaticMarkup(<CanvasOnboardingView document={{ ...document, view: 'collapsed' }} status="ready" isEmpty actions={actions} />)
  assert.equal((expandedHtml.match(/aria-label="Close first steps"/g) ?? []).length, 1)
  assert.equal((compactHtml.match(/aria-label="Close first steps"/g) ?? []).length, 1)
  assert.match(expandedHtml, /aria-label="Collapse first steps"/)
  assert.match(compactHtml, /aria-label="Expand first steps"/)
  assert.match(collapsedHtml, />First steps</)
})

test('completed and dismissed server views stay hidden, while progress remains readable in Help', () => {
  const completed = documentWith({
    'first-generation': 'done',
    'reference-generation': 'skipped',
    recovery: 'done',
    'save-for-later': 'done',
    export: 'skipped',
  })
  const dismissed = documentWith({ 'first-generation': 'done' }, 'dismissed')
  assert.equal(onboardingCanvasMode(completed), 'hidden')
  assert.equal(onboardingProgressLabel(completed), 'First steps: 5 of 5')
  assert.equal(onboardingCanvasMode(dismissed), 'hidden')
  assert.equal(onboardingProgressLabel(dismissed), 'First steps: 1 of 5')
})

test('load failure on an empty canvas offers Help without requiring generation', () => {
  const html = renderToStaticMarkup(<CanvasOnboardingView document={null} status="error" isEmpty actions={actions} />)
  assert.match(html, /Start here/)
  assert.match(html, /Open Help/)
  assert.doesNotMatch(html, /Generate|completed|missed|not completed/)
  assert.equal(renderToStaticMarkup(<CanvasOnboardingView document={null} status="error" isEmpty={false} actions={actions} />), '')
})

test('the final tour screen offers a durable Done action and Help reopen link', () => {
  const html = renderToStaticMarkup(
    <CanvasOnboardingView document={documentWith({})} status="ready" isEmpty actions={actions} tutorialIndex={4} />,
  )
  assert.match(html, /You’re ready to explore/)
  assert.match(html, />Done</)
  assert.match(html, />Open Help</)
})

test('assistant photo step explains drag attachment and uses the attachment illustration', () => {
  const html = renderToStaticMarkup(
    <CanvasOnboardingView document={documentWith({})} status="ready" isEmpty actions={actions} tutorialIndex={2} />,
  )
  assert.match(html, /Drag into Assistant/)
  assert.match(html, /drag a photo from Canvas into Assistant|Drag a photo from Canvas into Assistant/)
  assert.match(html, /assistant-photos-2\.svg/)
})

test('action model keeps target, skip, and view callbacks independent', () => {
  const calls: string[] = []
  const model = createOnboardingActionModel({
    onSetView: (view) => calls.push(`view:${view}`),
    onSkip: (id) => calls.push(`skip:${id}`),
    onRequestTarget: (id) => calls.push(`target:${id}`),
  })
  model.show('first-generation')
  model.skip('first-generation')
  model.setView('dismissed')
  assert.deepEqual(calls, ['target:first-generation', 'skip:first-generation', 'view:dismissed'])
})

test('Help offers a reopenable first-steps action without exposing a checklist', () => {
  const html = renderToStaticMarkup(
    <OnboardingHelpSection
      status="ready"
      document={documentWith({ 'first-generation': 'done' })}
      editorMounted
      onShow={() => {}}
      onReset={() => {}}
    />,
  )
  assert.match(html, /First steps/)
  assert.match(html, /Open first steps/)
  assert.match(html, /Open first steps/)
  assert.doesNotMatch(html, /Show on canvas|missed|not completed/)
})

test('Help keeps the reopen action after all legacy progress is complete', () => {
  const html = renderToStaticMarkup(
    <OnboardingHelpSection
      status="ready"
      document={documentWith({
        'first-generation': 'done',
        'reference-generation': 'done',
        recovery: 'done',
        'save-for-later': 'done',
        export: 'done',
      })}
      editorMounted
      onShow={() => {}}
    />,
  )
  assert.match(html, /Open first steps/)
  assert.doesNotMatch(html, /of 5/)
})
