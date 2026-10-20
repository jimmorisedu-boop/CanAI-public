import assert from 'node:assert/strict'
import test from 'node:test'
import { createGestureAdmission } from './gestureAdmission'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('delayed lease ack resumes an active gesture once', async () => {
  const admission = createGestureAdmission()
  const request = deferred<boolean>()
  let granted = 0

  admission.begin(() => request.promise, () => { granted += 1 })
  assert.equal(admission.isPending(), true)
  assert.equal(granted, 0)

  request.resolve(true)
  await flush()

  assert.equal(admission.isPending(), false)
  assert.equal(granted, 1)
})

test('pointerup cancellation ignores a late lease ack', async () => {
  const admission = createGestureAdmission()
  const request = deferred<boolean>()
  let granted = 0

  admission.begin(() => request.promise, () => { granted += 1 })
  admission.cancel()
  request.resolve(true)
  await flush()

  assert.equal(admission.isPending(), false)
  assert.equal(granted, 0)
})

test('a rejected admission clears pending state and does not resume', async () => {
  const admission = createGestureAdmission()
  let rejected = 0
  let granted = 0

  admission.begin(async () => false, () => { granted += 1 }, () => { rejected += 1 })
  await flush()

  assert.equal(admission.isPending(), false)
  assert.equal(granted, 0)
  assert.equal(rejected, 1)
})
