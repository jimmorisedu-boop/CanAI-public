import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearDesktopUpdateGuardsForTests,
  registerDesktopUpdateGuard,
  runDesktopUpdateGuards,
} from './desktopUpdateGuards'
import { flushLocalUpdateSave, waitForCloudUpdateSave, type DesktopUpdateCloudSaveHandle } from './desktopUpdateSaveGuards'

test.afterEach(() => clearDesktopUpdateGuardsForTests())

test('guards run in registration order and stop at the first refusal', async () => {
  const trace: string[] = []
  registerDesktopUpdateGuard('timeline', async () => { trace.push('timeline'); return { ok: true } })
  registerDesktopUpdateGuard('board', async () => { trace.push('board'); return { ok: false, message: 'offline' } })
  registerDesktopUpdateGuard('never', async () => { trace.push('never'); return { ok: true } })
  assert.deepEqual(await runDesktopUpdateGuards(), { ok: false, message: 'offline' })
  assert.deepEqual(trace, ['timeline', 'board'])
})

test('re-registering a guard key replaces only that owner', async () => {
  registerDesktopUpdateGuard('board', async () => ({ ok: false, message: 'old' }))
  registerDesktopUpdateGuard('board', async () => ({ ok: true }))
  assert.deepEqual(await runDesktopUpdateGuards(), { ok: true })
})

test('a guard exception becomes an explicit refusal', async () => {
  registerDesktopUpdateGuard('save', async () => { throw new Error('save failed') })
  assert.deepEqual(await runDesktopUpdateGuards(), { ok: false, message: 'save failed' })
})

test('editor finalizers run before board saves regardless of effect registration order', async () => {
  const trace: string[] = []
  registerDesktopUpdateGuard('board', async () => { trace.push('save'); return { ok: true } }, 'save')
  registerDesktopUpdateGuard('app-leave', async () => { trace.push('finalize'); return { ok: true } }, 'finalize')
  assert.deepEqual(await runDesktopUpdateGuards(), { ok: true })
  assert.deepEqual(trace, ['finalize', 'save'])
})

function cloudHandle(overrides: Partial<DesktopUpdateCloudSaveHandle> = {}): DesktopUpdateCloudSaveHandle {
  return {
    isWritable: () => true,
    getPendingCount: () => 0,
    getOfflineReason: () => null,
    getRecoveryDrafts: () => [],
    subscribeHistory: () => () => {},
    subscribeRecoveryDrafts: () => () => {},
    ...overrides,
  }
}

test('cloud save guard waits for pending acknowledgement and unsubscribes', async () => {
  let pending = 1
  const listeners = new Set<() => void>()
  const handle = cloudHandle({
    getPendingCount: () => pending,
    subscribeHistory: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  const waiting = waitForCloudUpdateSave(handle, { timeoutMs: 100 })
  assert.equal(listeners.size, 1)
  pending = 0
  for (const listener of listeners) listener()
  assert.deepEqual(await waiting, { ok: true })
  assert.equal(listeners.size, 0)
})

test('cloud save guard refuses offline and recovery states', async () => {
  assert.deepEqual(await waitForCloudUpdateSave(cloudHandle({ isWritable: () => false })), {
    ok: false,
    message: 'The cloud board is offline. Reconnect before updating.',
  })
  assert.deepEqual(await waitForCloudUpdateSave(cloudHandle({ getRecoveryDrafts: () => [{ id: 'draft' }] })), {
    ok: false,
    message: 'The cloud board has a rejected recovery draft. Resolve it before updating.',
  })
})

test('local save guard reports flush failures instead of allowing restart', async () => {
  const result = await flushLocalUpdateSave({ flushAndWait: async () => { throw new Error('write failed') } }, 'save refused')
  assert.deepEqual(result, { ok: false, message: 'save refused' })
})
