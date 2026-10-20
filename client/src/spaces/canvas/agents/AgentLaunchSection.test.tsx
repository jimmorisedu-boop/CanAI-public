import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import type { ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { AgentLaunchSection } from './AgentLaunchSection'
import { AgentSpendBudgetSection } from './AgentSpendBudgetSection'
import type { AgentPanelController } from './agentPanelController'
import type { AgentPresentationCapability } from './agentCapabilities'

function sameDeps(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * Exercise the real function component and React hook state without adding a
 * browser/DOM dependency to the client test runner. Child props are inspected
 * after each state update, so this catches parent rerender regressions rather
 * than only testing the pure consent model.
 */
function renderLaunch(props: React.ComponentProps<typeof AgentLaunchSection>) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const slots: any[] = []
  const effects: Array<{ deps?: unknown[]; cleanup?: (() => void) | void }> = []
  let pending: Array<{ index: number; effect: () => void | (() => void) }> = []
  let cursor = 0
  let dirty = true
  let tree: React.ReactElement

  const render = () => {
    cursor = 0
    pending = []
    dirty = false
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = {
      useRef: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index]
      },
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        return [slots[index], (next: unknown) => {
          slots[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(slots[index]) : next
          dirty = true
        }]
      },
      useMemo: (factory: () => unknown, deps: unknown[]) => {
        const index = cursor++
        const previousValue = slots[index] as { deps?: unknown[]; value: unknown } | undefined
        if (!previousValue || !sameDeps(previousValue.deps, deps)) slots[index] = { deps, value: factory() }
        return (slots[index] as { value: unknown }).value
      },
      useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
        const index = cursor++
        if (!sameDeps(effects[index]?.deps, deps)) pending.push({ index, effect })
        effects[index] = { deps }
      },
    }
    try { tree = AgentLaunchSection(props) } finally { internals.ReactCurrentDispatcher.current = previous }
    return tree!
  }

  const flush = () => {
    for (let pass = 0; pass < 12; pass += 1) {
      const current = pending
      pending = []
      for (const entry of current) {
        effects[entry.index]?.cleanup?.()
        effects[entry.index]!.cleanup = entry.effect()
      }
      if (!dirty) return
      render()
    }
    throw new Error('React launch harness did not settle')
  }

  const spendSection = () => {
    const visit = (value: unknown): React.ReactElement | null => {
      if (!React.isValidElement(value)) return null
      if (value.type === AgentSpendBudgetSection) return value
      const children = (value.props as { children?: unknown }).children
      for (const child of React.Children.toArray(children as React.ReactNode)) {
        const found = visit(child)
        if (found) return found
      }
      return null
    }
    const found = visit(tree!)
    assert.ok(found, 'launch section must render its spend/consent section')
    return found
  }

  render()
  flush()
  return {
    spendSection,
    rerender: () => { render(); flush() },
    unmount: () => { for (const entry of effects) entry?.cleanup?.() },
  }
}

function creatorPackage() {
  return {
    id: 'canai.creator', name: 'Creator', description: 'Creator', version: '1.0.0', packageSha: 'creator-sha',
    protocolVersion: '1.0', taskTypes: [{ id: 'creator-image', label: 'Картинка', description: 'Картинка', outputKinds: ['image'] }],
    permissions: [], lifecycle: { pause: 'checkpoint' as const, resume: true as const, cancel: true as const },
    handshake: 'ready' as const, status: 'ready' as const, active: true,
  }
}

function localPackage() {
  return {
    ...creatorPackage(), permissions: ['llm.request', 'generation.request'],
  }
}

function localLlmCatalog() {
  return {
    revision: 7, connection: { id: 'local-fal' as const, kind: 'llm' as const, status: 'ready' as const }, defaultModelId: 'local-text',
    models: [{ id: 'local-text', name: 'fal.ai текст', active: true }],
  }
}

function localGenerationCatalog() {
  return {
    revision: 7, connection: { id: 'local-fal' as const, kind: 'generation' as const, status: 'ready' as const },
    models: [{ id: 'local-image', name: 'fal.ai картинка', kind: 'image' as const, refs: true, params: [], lifecycle: 'active' as const }],
  }
}

function controller(): AgentPanelController {
  return {
    state: {} as AgentPanelController['state'], collapsed: false, setCollapsed() {}, instruction: 'Ночная сцена', setInstruction() {},
    selectedTaskId: null, setSelectedTaskId() {}, selectedTask: undefined, llmCatalog: null, generationCatalog: null,
    demoPackage: undefined, packageRevision: 1,
    captureGenerationInputs: async () => [],
    start: async () => {}, command: async () => {}, decide: async () => {}, refresh: async () => {},
  }
}

const capability: AgentPresentationCapability = {
  transport: 'host', catalog: 'host-installed', billing: 'local-fal', canControl: true, canLaunch: true, canObserve: true, label: 'This computer',
}

test('local text and media consent survive each other across real AgentLaunchSection rerenders', () => {
  const projectRef: ProjectRef = { source: 'local', id: `consent-local-regression-${Date.now()}` }
  const pkg = localPackage()
  const props = {
    controller: controller(), projectRef, llmCatalog: localLlmCatalog(), generationCatalog: localGenerationCatalog(),
    packages: [pkg], readyPackages: [pkg], selectedPackage: pkg, selectedType: pkg.taskTypes[0], taskInput: {}, inputErrors: {}, canLaunch: true,
    store: { getSelectedItems: () => [] } as unknown as CanvasStore, onPackageChange() {}, onTaskTypeChange() {}, onInputChange() {},
    capability, compact: false,
  } as React.ComponentProps<typeof AgentLaunchSection>
  const launch = renderLaunch(props)
  try {
    let spend = launch.spendSection()
    assert.equal('cloudMode' in spend.props, false)
    assert.equal('cloudTextConsentGranted' in spend.props, false)
    spend.props.onGenerationConsent(true)
    launch.rerender()
    spend = launch.spendSection()
    assert.equal(spend.props.generationMediaConsentGranted, true)
    assert.equal(spend.props.consentGranted, false)

    spend.props.onLlmConsent(true)
    launch.rerender()
    spend = launch.spendSection()
    assert.equal(spend.props.generationMediaConsentGranted, true)
    assert.equal(spend.props.consentGranted, true)

    spend.props.onLlmConsent(false)
    launch.rerender()
    spend = launch.spendSection()
    assert.equal(spend.props.generationMediaConsentGranted, true)
    assert.equal(spend.props.consentGranted, false)
  } finally {
    launch.unmount()
  }
})
