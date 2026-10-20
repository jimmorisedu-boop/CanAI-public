import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenerationGate,
  GenerationRouteError,
  GenerationShuttingDownError,
  selectGenerationRoute,
  withGenerationAdmission,
} from './generationGate.js'
import { persistUntilDurableForShutdown } from './runner.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('a closed gate does not admit a new durable job', async () => {
  const gate = new GenerationGate()
  gate.close()
  let called = false
  await assert.rejects(withGenerationAdmission(gate, async () => { called = true }), GenerationShuttingDownError)
  assert.equal(called, false)
})

test('shutdown waits for delayed onEnqueue persistence, but not the whole provider job', async () => {
  const gate = new GenerationGate()
  const lease = gate.tryEnter()
  assert.ok(lease)
  const submitted = deferred()
  const requestIdPersisted = deferred()
  const resultFinished = deferred()

  const providerJob = (async () => {
    await submitted.promise
    await requestIdPersisted.promise
    lease.release()
    await resultFinished.promise
  })()

  let shutdownFinished = false
  const shutdown = gate.closeAndWait().then(() => { shutdownFinished = true })
  await Promise.resolve()
  assert.equal(shutdownFinished, false)
  submitted.resolve()
  await Promise.resolve()
  assert.equal(shutdownFinished, false)
  requestIdPersisted.resolve()
  await shutdown
  assert.equal(shutdownFinished, true)

  let resultSettled = false
  void providerJob.then(() => { resultSettled = true })
  await Promise.resolve()
  assert.equal(resultSettled, false)
  resultFinished.resolve()
  await providerJob
})

test('runner fail-closed retries durable persistence and keeps the shutdown barrier', async () => {
  const gate = new GenerationGate()
  const lease = gate.tryEnter()
  assert.ok(lease)
  const retries = [deferred(), deferred()]
  let attempts = 0
  const errors: unknown[] = []
  const retry = persistUntilDurableForShutdown(
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error(`disk failure ${attempts}`)
    },
    lease,
    (error) => errors.push(error),
    () => retries[attempts - 1].promise,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(attempts, 1)

  let shutdownFinished = false
  const shutdown = gate.closeAndWait().then(() => { shutdownFinished = true })
  await Promise.resolve()
  assert.equal(shutdownFinished, false)
  retries[0].resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.equal(shutdownFinished, false)
  retries[1].resolve()
  await retry
  await shutdown
  assert.equal(attempts, 3)
  assert.equal(errors.length, 2)
  assert.equal(shutdownFinished, true)
})

test('local generation uses the local fal route', () => {
  assert.equal(selectGenerationRoute({ projectSource: 'local', localConfigured: true, mockMode: false }), 'local')
})

test('local generation without a provider key fails clearly', () => {
  assert.throws(
    () => selectGenerationRoute({ projectSource: 'local', localConfigured: false, mockMode: false }),
    (error: unknown) => error instanceof GenerationRouteError
      && error.code === 'local-provider-required'
      && /Add key fal\.ai in settings/u.test(error.message),
  )
})

test('mock mode remains the first route and does not call the provider', () => {
  assert.equal(selectGenerationRoute({ projectSource: 'local', localConfigured: false, mockMode: true }), 'mock')
})
