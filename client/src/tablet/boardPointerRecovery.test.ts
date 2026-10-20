// @ts-expect-error Node test runtime
import test from 'node:test'
// @ts-expect-error Node test runtime
import assert from 'node:assert/strict'
import { bindBoardPointerRecovery, releaseBoardPointers } from './boardPointerRecovery'

test('отпускание вне холста завершает жест, потеря capture отменяет, обычное отпускание не дублируется', () => {
  const scope = new EventTarget()
  const host = Object.assign(new EventTarget(), { contains: (target: unknown) => target === host })
  const tracked = new Set([1])
  let finished = 0, cancelled = 0
  const cleanup = bindBoardPointerRecovery(host as any, {
    has: id => tracked.has(id), any: () => tracked.size > 0,
    finish: event => { tracked.delete(event.pointerId); finished++ },
    cancel: () => { tracked.clear(); cancelled++ },
  }, scope as any)
  const pointer = (name: string, id: number) => Object.assign(new Event(name), { pointerId: id })
  scope.dispatchEvent(pointer('pointerup', 1))
  scope.dispatchEvent(pointer('pointerup', 1))
  assert.equal(finished, 1)
  tracked.add(2)
  host.dispatchEvent(pointer('lostpointercapture', 2))
  assert.equal(cancelled, 1)
  tracked.add(3)
  scope.dispatchEvent(pointer('pointerdown', 4))
  assert.equal(cancelled, 2, 'касание меню не продолжает потерянный жест холста')
  cleanup()
  tracked.add(5)
  scope.dispatchEvent(pointer('pointerup', 5))
  assert.equal(finished, 1)
})
test('снятие capture очищает указатели до синхронного lostpointercapture', () => {
  const pointers = new Map([[1, {}], [2, {}]])
  let released = 0
  releaseBoardPointers(pointers, { releasePointerCapture() { assert.equal(pointers.size, 0); released++ } })
  assert.equal(released, 2)
})
