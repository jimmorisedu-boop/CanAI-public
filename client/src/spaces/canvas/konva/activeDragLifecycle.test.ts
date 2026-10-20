import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelActiveDrag, clearActiveDrag, registerActiveDrag } from './activeDragLifecycle'

test('blur/unmount cancels an admitted drag once and a late end stays harmless', () => {
  const owner = {}
  let cancellations = 0
  registerActiveDrag(owner, () => { cancellations += 1 })

  cancelActiveDrag(owner)
  cancelActiveDrag(owner)
  clearActiveDrag(owner)

  assert.equal(cancellations, 1)
})

test('normal drag completion disarms the cancellation path', () => {
  const owner = {}
  let cancellations = 0
  registerActiveDrag(owner, () => { cancellations += 1 })
  clearActiveDrag(owner)
  cancelActiveDrag(owner)
  assert.equal(cancellations, 0)
})
