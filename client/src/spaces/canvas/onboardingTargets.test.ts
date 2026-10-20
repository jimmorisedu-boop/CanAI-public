import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createArchiveTarget,
  createAssetShelfTarget,
  createCardTarget,
  createExportTarget,
  createHelpCardTarget,
  createPromptTargetHandlers,
  createRecoveryHelpTarget,
  createRecoveryTarget,
  registerCardOnboardingTarget,
  registerExportOnboardingTarget,
  registerPromptOnboardingTargets,
  registerRecoveryOnboardingTarget,
  registerSaveForLaterOnboardingTarget,
  showOnboardingTarget,
  type OnboardingTargetDeps,
} from './onboardingTargets.js'
import { requestOnboardingTarget } from './onboardingEvents.js'

function fakeElement() {
  const classes = new Set<string>()
  let focusCalls = 0
  return {
    classes,
    get focusCalls() { return focusCalls },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    focus: () => { focusCalls++ },
  }
}

function productSpies() {
  const calls = { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 }
  return {
    calls,
    actions: {
      generate: () => { calls.generation++ },
      undo: () => { calls.undo++ },
      restore: () => { calls.restore++ },
      archive: () => { calls.archive++ },
      pin: () => { calls.pin++ },
      export: () => { calls.export++ },
    },
  }
}

test('overlapping pulses cancel the stale timer and retain the newest highlight', () => {
  const element = fakeElement()
  const scheduled: Array<() => void> = []
  const cancelled: number[] = []
  const deps: OnboardingTargetDeps = {
    announce: () => {},
    schedule: (run) => {
      scheduled.push(run)
      return scheduled.length
    },
    cancel: (timer) => cancelled.push(timer),
  }

  showOnboardingTarget(element as unknown as HTMLElement, { message: 'Первое' }, deps)
  const disposeNewest = showOnboardingTarget(element as unknown as HTMLElement, { message: 'Второе' }, deps)

  assert.deepEqual(cancelled, [1])
  scheduled[0]()
  assert.equal(element.classes.has('onboarding-target-pulse'), true)
  disposeNewest()
  assert.equal(element.classes.has('onboarding-target-pulse'), false)
})

test('prompt targets switch to generation UI before focusing its input or canvas references', () => {
  const deferred: Array<() => void> = []
  const product = productSpies()
  const calls: string[] = []
  const handlers = createPromptTargetHandlers({
    switchToPrompt: () => calls.push('prompt'),
    defer: (run) => deferred.push(run),
    focusPrompt: () => calls.push('focus-input'),
    pulsePrompt: () => calls.push('pulse-prompt'),
    firstCanvasReference: () => ({ id: 'canvas-image' }),
    focusCanvasReference: (reference) => calls.push(`focus:${reference.id}`),
    pulseReferences: () => calls.push('pulse-refs'),
    announce: (message) => calls.push(message),
    product: product.actions,
  })

  handlers.firstGeneration()
  handlers.referenceGeneration()
  assert.deepEqual(calls, ['prompt', 'prompt'])

  deferred.splice(0).forEach((run) => run())
  assert.deepEqual(calls, [
    'prompt', 'prompt', 'focus-input', 'pulse-prompt', 'focus:canvas-image', 'pulse-refs',
  ])
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })
})

test('reference guidance announces the missing canvas result without selecting or generating', () => {
  const product = productSpies()
  let announced = ''
  const handlers = createPromptTargetHandlers({
    switchToPrompt: () => {},
    defer: (run) => run(),
    focusPrompt: () => assert.fail('input is unrelated'),
    pulsePrompt: () => assert.fail('prompt is unrelated'),
    firstCanvasReference: () => null,
    focusCanvasReference: () => assert.fail('there is no canvas result'),
    pulseReferences: () => assert.fail('there is no reference region to show'),
    announce: (message) => { announced = message },
    product: product.actions,
  })

  handlers.referenceGeneration()

  assert.equal(announced, 'Create your first result first.')
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })
})

test('recovery pulses Ctrl+Z guidance but focuses an actionable modal control', () => {
  const product = productSpies()
  const undoRow = fakeElement()
  const closeButton = fakeElement()
  const deps: OnboardingTargetDeps = {
    announce: () => {},
    schedule: () => 1,
    cancel: () => {},
  }
  createRecoveryTarget({
    pulseUndoRow: () => showOnboardingTarget(undoRow as unknown as HTMLElement, { message: 'Восстановление' }, deps),
    focusModalAction: () => closeButton.focus(),
    product: product.actions,
  })()

  assert.equal(undoRow.classes.has('onboarding-target-pulse'), true)
  assert.equal(undoRow.focusCalls, 0, 'informational Ctrl+Z row stays out of focus order')
  assert.equal(closeButton.focusCalls, 1, 'modal focus remains on an actionable control')
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })
})

test('recovery routing opens Help without undoing or restoring the board', () => {
  const product = productSpies()
  let opened = 0
  createRecoveryHelpTarget({
    openHelp: () => { opened++ },
    product: product.actions,
  })()

  assert.equal(opened, 1)
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })
})

test('registered owners route every onboarding request without running product actions', () => {
  const product = productSpies()
  const calls: string[] = []
  const deferred: Array<() => void> = []
  const prompt = createPromptTargetHandlers({
    switchToPrompt: () => calls.push('prompt'),
    defer: (run) => deferred.push(run),
    focusPrompt: () => calls.push('focus-input'),
    pulsePrompt: () => calls.push('pulse-prompt'),
    firstCanvasReference: () => ({ id: 'canvas-image' }),
    focusCanvasReference: (reference) => calls.push(`focus:${reference.id}`),
    pulseReferences: () => calls.push('pulse-refs'),
    announce: (message) => calls.push(message),
    product: product.actions,
  })
  const unregisterPrompt = registerPromptOnboardingTargets(prompt)
  const unregisterRecovery = registerRecoveryOnboardingTarget(createRecoveryHelpTarget({
    openHelp: () => calls.push('open-help'),
    product: product.actions,
  }))
  const unregisterArchive = registerSaveForLaterOnboardingTarget(createArchiveTarget({
    focus: () => calls.push('archive-focus'),
    pulse: () => calls.push('archive-pulse'),
    product: product.actions,
  }))
  const unregisterAssets = registerSaveForLaterOnboardingTarget(createAssetShelfTarget({
    pulse: () => calls.push('assets-pulse'),
    product: product.actions,
  }))
  const unregisterExport = registerExportOnboardingTarget(createExportTarget({
    focus: () => calls.push('export-focus'),
    pulse: () => calls.push('export-pulse'),
    product: product.actions,
  }))
  const cardAction = fakeElement()
  requestOnboardingTarget('card')
  const unregisterCard = registerCardOnboardingTarget(createCardTarget({
    expand: () => calls.push('expand'),
    defer: (run) => deferred.push(run),
    focusAction: () => {
      cardAction.focus()
      calls.push('card-action')
    },
    pulse: () => calls.push('card-pulse'),
    product: product.actions,
  }))

  requestOnboardingTarget('first-generation')
  requestOnboardingTarget('reference-generation')
  requestOnboardingTarget('recovery')
  requestOnboardingTarget('save-for-later')
  requestOnboardingTarget('export')
  deferred.splice(0).forEach((run) => run())

  assert.deepEqual(calls, [
    'expand', 'prompt', 'prompt', 'open-help', 'archive-focus', 'archive-pulse',
    'assets-pulse', 'export-focus', 'export-pulse', 'card-action', 'card-pulse',
    'focus-input', 'pulse-prompt', 'focus:canvas-image', 'pulse-refs',
  ])
  assert.equal(cardAction.focusCalls, 1, 'expanded card receives focus on a real action')
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })

  unregisterPrompt()
  unregisterRecovery()
  unregisterArchive()
  unregisterAssets()
  unregisterExport()
  unregisterCard()

  requestOnboardingTarget('export')
  const unregisterParkedExport = registerExportOnboardingTarget(createExportTarget({
    focus: () => calls.push('parked-export-focus'),
    pulse: () => calls.push('parked-export-pulse'),
    product: product.actions,
  }))
  assert.deepEqual(calls.slice(-2), ['parked-export-focus', 'parked-export-pulse'])
  unregisterParkedExport()
  assert.deepEqual(product.calls, { generation: 0, undo: 0, restore: 0, archive: 0, pin: 0, export: 0 })
})
