import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import type { AgentPythonRuntimeStatus } from './agentHostClient'
import type { AgentPanelController } from './agentPanelController'
import { useAgentPythonRuntime } from './useAgentPythonRuntime'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function sameDeps(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function renderRuntimeHook(
  controller: AgentPanelController,
  projectRef: { source: 'local' | 'cloud'; id: string },
) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const slots: any[] = []
  const effects: Array<{ deps?: unknown[]; cleanup?: (() => void) | void }> = []
  let pending: Array<{ index: number; effect: () => void | (() => void) }> = []
  let cursor = 0
  let value: ReturnType<typeof useAgentPythonRuntime>
  const render = () => {
    cursor = 0
    pending = []
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = {
      useRef: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index]
      },
      useState: (initial: any) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
      },
      useCallback: (fn: unknown) => { cursor++; return fn },
      useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
        const index = cursor++
        if (!sameDeps(effects[index]?.deps, deps)) pending.push({ index, effect })
        effects[index] = { deps }
      },
    }
    try { value = useAgentPythonRuntime(controller, projectRef) } finally { internals.ReactCurrentDispatcher.current = previous }
    return value
  }
  const flushEffects = () => {
    const current = pending
    pending = []
    for (const entry of current) {
      effects[entry.index]?.cleanup?.()
      effects[entry.index]!.cleanup = entry.effect()
    }
  }
  const unmount = () => {
    for (const entry of effects) entry?.cleanup?.()
  }
  return { render, flushEffects, unmount, get value() { return value! } }
}

function status(ready: boolean): AgentPythonRuntimeStatus {
  return { supported: true, ready, version: '3.13.16', rootRelative: 'python', ...(ready ? {} : { reason: 'RUNTIME_BASELINE_REQUIRED' }) }
}

function controllerFor(
  statuses: Array<Deferred<AgentPythonRuntimeStatus>>,
  installs: Array<Deferred<AgentPythonRuntimeStatus>>,
): AgentPanelController {
  return {
    getPythonRuntime: () => { const request = deferred<AgentPythonRuntimeStatus>(); statuses.push(request); return request.promise },
    installPythonRuntime: () => { const request = deferred<AgentPythonRuntimeStatus>(); installs.push(request); return request.promise },
  } as unknown as AgentPanelController
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

test('late status cannot overwrite successful install and install is serialized', async () => {
  const statuses: Array<Deferred<AgentPythonRuntimeStatus>> = []
  const installs: Array<Deferred<AgentPythonRuntimeStatus>> = []
  const hook = renderRuntimeHook(controllerFor(statuses, installs), { source: 'cloud', id: 'board' })
  hook.render(); hook.flushEffects()
  hook.value.retryRuntimeStatus()
  await settle()
  statuses[1]!.resolve(status(false))
  await settle()
  hook.render(); hook.flushEffects()
  hook.value.setRuntimeConsent(true)
  hook.render(); hook.flushEffects()
  hook.value.installRuntime()
  hook.value.installRuntime()
  assert.equal(installs.length, 1, 'double click cannot start two runtime installs')
  installs[0]!.resolve(status(true))
  statuses[0]!.resolve(status(false))
  await settle()
  hook.render(); hook.flushEffects()
  assert.equal(hook.value.runtime?.ready, true)
  assert.equal(hook.value.runtimeBusy, false)
  assert.equal(hook.value.runtimeConsent, false)
})

test('out-of-order status retries keep only the newest receipt', async () => {
  const statuses: Array<Deferred<AgentPythonRuntimeStatus>> = []
  const hook = renderRuntimeHook(controllerFor(statuses, []), { source: 'local', id: 'board' })
  hook.render(); hook.flushEffects()
  hook.value.retryRuntimeStatus()
  hook.value.retryRuntimeStatus()
  statuses[2]!.resolve(status(true))
  statuses[1]!.resolve(status(false))
  statuses[0]!.resolve(status(false))
  await settle()
  hook.render(); hook.flushEffects()
  assert.equal(hook.value.runtime?.ready, true)
  assert.equal(hook.value.runtimeBusy, false)
})

test('status and install receipts from the old board are ignored after source switch and unmount', async () => {
  const statuses: Array<Deferred<AgentPythonRuntimeStatus>> = []
  const installs: Array<Deferred<AgentPythonRuntimeStatus>> = []
  const controller = controllerFor(statuses, installs)
  const projectRef: { source: 'local' | 'cloud'; id: string } = { source: 'local', id: 'before' }
  const hook = renderRuntimeHook(controller, projectRef)
  hook.render(); hook.flushEffects()
  projectRef.source = 'cloud'
  projectRef.id = 'after'
  hook.render(); hook.flushEffects()
  statuses[0]!.resolve(status(true))
  statuses[1]!.resolve(status(false))
  await settle()
  hook.render(); hook.flushEffects()
  assert.equal(hook.value.runtime?.ready, false)
  hook.value.setRuntimeConsent(true)
  hook.render(); hook.flushEffects()
  hook.value.installRuntime()
  hook.unmount()
  installs[0]!.resolve(status(true))
  await settle()
  assert.equal(hook.value.runtime?.ready, false, 'unmounted install cannot mutate a later snapshot')
})
