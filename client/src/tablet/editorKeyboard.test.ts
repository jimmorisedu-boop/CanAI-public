import assert from 'node:assert/strict'
import test from 'node:test'
import { handleTrackKey, type TrackHandle } from './clipKeyboard.js'
import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession.js'
import { editCropField } from './cropFieldModel.js'

function key(value: string, shiftKey = false) {
  return { key: value, shiftKey, ctrlKey: false, altKey: false, metaKey: false, handled: false,
    preventDefault() { this.handled = true }, stopPropagation() {} }
}
test('clip keyboard really moves in/out/cut/head at the probed fps and supports Home/End', () => {
  const calls: Array<[string, number]> = []
  const session = { facts: { fps: 24, duration: 12 }, busy: false, inPoint: 1, outPoint: 10,
    cuts: [{ time: 5, auto: false }],
    moveIn: (time: number) => calls.push(['in', time]), moveOut: (time: number) => calls.push(['out', time]),
    moveCut: (_from: number, time: number) => calls.push(['cut', time]),
  } as unknown as TimelineSession
  for (const kind of ['in', 'out', 'cut', 'head'] as TrackHandle[]) {
    const event = key('ArrowRight')
    handleTrackKey(event, session, kind, 5, time => calls.push(['head', time]))
    assert.equal(event.handled, true)
    assert.deepEqual(calls.at(-1), [kind, 5 + 1 / 24])
  }
  handleTrackKey(key('ArrowLeft', true), session, 'in', 5, () => {})
  assert.deepEqual(calls.at(-1), ['in', 5 - 10 / 24])
  handleTrackKey(key('Home'), session, 'in', 5, () => {})
  assert.deepEqual(calls.at(-1), ['in', 0])
  handleTrackKey(key('End'), session, 'out', 5, () => {})
  assert.deepEqual(calls.at(-1), ['out', 12])
})
test('Delete removes a cut; modified browser keys and busy processing do not edit', () => {
  let removed = 0
  const session = { facts: { duration: 12 }, busy: false, removeCut: (time: number) => { removed = time } } as TimelineSession
  handleTrackKey(key('Delete'), session, 'cut', 4, () => {})
  assert.equal(removed, 4)
  removed = 0
  handleTrackKey({ ...key('Delete'), metaKey: true }, session, 'cut', 4, () => {})
  handleTrackKey(key('Delete'), { ...session, busy: true }, 'cut', 4, () => {})
  assert.equal(removed, 0)
})

test('crop numeric controls move and resize within image bounds and keep the selected ratio', () => {
  const initial = { x: 20, y: 30, w: 80, h: 40 }
  const bounds = { w: 200, h: 100 }
  assert.deepEqual(editCropField(initial, 'x', 180, bounds), { ...initial, x: 120 })
  assert.deepEqual(editCropField(initial, 'y', -5, bounds), { ...initial, y: 0 })
  assert.deepEqual(editCropField(initial, 'w', 110, bounds, 24, 2), { ...initial, w: 110, h: 55 })
  assert.deepEqual(editCropField(initial, 'h', 60, bounds, 24, 2), { ...initial, w: 120, h: 60 })
  assert.deepEqual(editCropField(initial, 'h', 1000, bounds), { ...initial, h: 70 })
  assert.deepEqual(editCropField(initial, 'w', Number.NaN, bounds), initial)
})

test('video crop percentage controls preserve a nonzero frame near every edge', () => {
  const rect = { x: 95, y: 95, w: 5, h: 5 }
  assert.deepEqual(editCropField(rect, 'w', 0, { w: 100, h: 100 }, 1), { ...rect, w: 1 })
  assert.deepEqual(editCropField(rect, 'h', 100, { w: 100, h: 100 }, 1), rect)
})
