import assert from 'node:assert/strict'
import test from 'node:test'
import { animateCamera, type CameraAnimationDeps } from './cameraAnimation'

function createScheduler() {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  const deps: CameraAnimationDeps = {
    now: () => now,
    requestFrame: (callback) => {
      const id = nextId++
      scheduled.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      cancelled.push(id)
      scheduled.delete(id)
    },
  }

  const fireNext = (at: number): void => {
    now = at
    const entry = scheduled.entries().next().value as [number, FrameRequestCallback] | undefined
    assert.ok(entry, `нет запланированного кадра для ${at} ms`)
    scheduled.delete(entry[0])
    entry[1](at)
  }

  return { deps, scheduled, cancelled, fireNext }
}

const from = { x: 0, y: 0, scale: 1 }
const to = { x: 80, y: -40, scale: 0.5 }

test('reduced motion сразу выдаёт ровно финальную камеру без RAF', () => {
  const scheduler = createScheduler()
  const frames: typeof from[] = []

  const cancel = animateCamera(
    from,
    to,
    { durationMs: 240, reducedMotion: true, onFrame: (camera) => frames.push(camera) },
    scheduler.deps,
  )

  assert.deepEqual(frames, [to])
  assert.equal(scheduler.scheduled.size, 0)
  cancel()
  cancel()
  assert.deepEqual(scheduler.cancelled, [])
})

test('ease-out интерполирует камеру в середине и завершает точным to', () => {
  const scheduler = createScheduler()
  const frames: typeof from[] = []

  animateCamera(
    from,
    to,
    { durationMs: 240, reducedMotion: false, onFrame: (camera) => frames.push(camera) },
    scheduler.deps,
  )

  scheduler.fireNext(120)
  assert.deepEqual(frames.at(-1), { x: 70, y: -35, scale: 0.5625 })
  scheduler.fireNext(240)
  assert.deepEqual(frames.at(-1), to)
  assert.equal(scheduler.scheduled.size, 0)
})

test('cancel идемпотентно запрещает даже уже извлечённому callback менять камеру', () => {
  const scheduler = createScheduler()
  const frames: typeof from[] = []
  const cancel = animateCamera(
    from,
    to,
    { durationMs: 240, reducedMotion: false, onFrame: (camera) => frames.push(camera) },
    scheduler.deps,
  )
  const entry = scheduler.scheduled.entries().next().value as [number, FrameRequestCallback] | undefined
  assert.ok(entry)

  cancel()
  cancel()
  entry[1](240)

  assert.deepEqual(frames, [])
  assert.deepEqual(scheduler.cancelled, [entry[0]])
})

test('ease-out движется монотонно и не выходит за границы from/to', () => {
  const scheduler = createScheduler()
  const frames: typeof from[] = []
  animateCamera(
    from,
    to,
    { durationMs: 240, reducedMotion: false, onFrame: (camera) => frames.push(camera) },
    scheduler.deps,
  )

  for (const at of [40, 80, 120, 160, 200, 240]) scheduler.fireNext(at)

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    assert.ok(frame.x >= from.x && frame.x <= to.x)
    assert.ok(frame.y <= from.y && frame.y >= to.y)
    assert.ok(frame.scale <= from.scale && frame.scale >= to.scale)
    if (index === 0) continue
    assert.ok(frame.x >= frames[index - 1].x)
    assert.ok(frame.y <= frames[index - 1].y)
    assert.ok(frame.scale <= frames[index - 1].scale)
  }
})
