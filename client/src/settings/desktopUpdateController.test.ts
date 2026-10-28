import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DesktopUpdateStatus,
} from '../../../packages/desktop-updates/protocol'
import {
  DesktopUpdateControllerImpl,
} from './desktopUpdateController'
import type { DesktopUpdateTransport } from './desktopUpdateApi'

const current = (version = '1.0.0') => ({ version, commit: 'abc', date: '2026-10-01' })

function transportOf(overrides: Partial<DesktopUpdateTransport> = {}): DesktopUpdateTransport {
  const base: DesktopUpdateTransport = {
    status: async () => ({ phase: 'idle', edition: 'full', current: current() }),
    check: async () => ({ phase: 'available', edition: 'full', current: current(), latest: { version: '1.1.0', commit: 'def', date: '2026-10-20', notes: ['Faster startup'], target: '1.1.0' } }),
    prepare: async () => ({ phase: 'preparing', edition: 'full', current: current(), jobId: 'job-1' }),
    apply: async () => ({ phase: 'restarting', edition: 'full', current: current(), jobId: 'job-1' }),
  }
  return { ...base, ...overrides }
}

test('check, prepare and apply share one status trace and stop at terminal phases', async () => {
  const trace: string[] = []
  let statusReads = 0
  const controller = new DesktopUpdateControllerImpl(transportOf({
    check: async () => { trace.push('check'); return { phase: 'available', edition: 'full', current: current(), latest: { version: '1.1.0', commit: 'def', date: null, notes: [], target: '1.1.0' } } },
    prepare: async () => { trace.push('prepare'); return { phase: 'preparing', edition: 'full', current: current(), jobId: 'job-1' } },
    apply: async () => { trace.push('apply'); return { phase: 'restarting', edition: 'full', current: current(), jobId: 'job-1' } },
    status: async () => {
      statusReads += 1
      if (statusReads === 1) return { phase: 'ready', edition: 'full', current: current(), jobId: 'job-1' }
      return { phase: 'complete', edition: 'full', current: current('1.1.0'), jobId: 'job-1' }
    },
  }), { pollIntervalMs: 0, sleep: async () => {}, maxWaitMs: 100 })

  const checked = await controller.check()
  assert.equal(checked.phase, 'available')
  const prepared = await controller.prepare('1.1.0')
  assert.equal(prepared.phase, 'ready')
  const applied = await controller.apply('job-1')
  assert.equal(applied.phase, 'complete')
  assert.deepEqual(trace, ['check', 'prepare', 'apply'])
  assert.equal(controller.getSnapshot()?.current.version, '1.1.0')
})

test('an ambiguous apply disconnect is recovered by status polling', async () => {
  let reads = 0
  const controller = new DesktopUpdateControllerImpl(transportOf({
    apply: async () => { throw Object.assign(new Error('gateway closed'), { status: 503 }) },
    status: async () => {
      reads += 1
      return reads === 1
        ? { phase: 'restarting', edition: 'local', current: current(), jobId: 'job-2' }
        : { phase: 'complete', edition: 'local', current: current('1.1.0'), jobId: 'job-2' }
    },
  }), { pollIntervalMs: 0, sleep: async () => {}, maxWaitMs: 100 })

  const result = await controller.apply('job-2')
  assert.equal(result.phase, 'complete')
  assert.equal(reads, 2)
})

test('cancel aborts a pending operation without turning it into a false success', async () => {
  let resolveStatus: ((status: DesktopUpdateStatus) => void) | undefined
  const controller = new DesktopUpdateControllerImpl(transportOf({
    check: (signal) => new Promise((resolve, reject) => {
      resolveStatus = resolve
      signal?.addEventListener('abort', () => reject(new DOMException('Update cancelled', 'AbortError')), { once: true })
    }),
  }), { maxWaitMs: 100 })
  const pending = controller.check()
  controller.cancel()
  resolveStatus?.({ phase: 'available', edition: 'full', current: current(), latest: { version: '1.1.0', commit: null, date: null, notes: [], target: '1.1.0' } })
  await assert.rejects(pending, /Abort|cancel/i)
})
