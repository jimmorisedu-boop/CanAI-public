import assert from 'node:assert/strict'
import test from 'node:test'
import { bindClipMediaGuards, type ClipMediaEventTarget, type ClipPlaybackSession } from './clipPlaybackBounds'

class FakeMedia implements ClipMediaEventTarget {
  currentTime = 0
  paused = true
  pauseCalls = 0
  private listeners = new Map<string, Set<EventListener>>()

  pause(): void {
    this.paused = true
    this.pauseCalls += 1
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
}

function session(patch: Partial<ClipPlaybackSession> = {}): ClipPlaybackSession {
  return {
    inPoint: 2,
    outPoint: 6,
    head: 2,
    setHead() {},
    ...patch,
  }
}

test('media guard pauses at trim end even when React head already equals outPoint', () => {
  const media = new FakeMedia()
  const heads: number[] = []
  const target = session({ head: 6, setHead: (time) => heads.push(time) })
  const stop = bindClipMediaGuards(media, () => target)
  media.paused = false
  media.currentTime = 6.3
  media.emit('timeupdate')
  assert.equal(media.currentTime, 6)
  assert.equal(media.pauseCalls, 1)
  assert.deepEqual(heads, [])
  stop()
})

test('media guard restarts from inPoint when Play is pressed at trim end', () => {
  const media = new FakeMedia()
  media.currentTime = 6
  const heads: number[] = []
  const target = session({ head: 6, setHead: (time) => heads.push(time) })
  const stop = bindClipMediaGuards(media, () => target)
  media.paused = false
  media.emit('play')
  assert.equal(media.currentTime, 2)
  assert.deepEqual(heads, [2])
  assert.equal(media.pauseCalls, 0)
  stop()
})
