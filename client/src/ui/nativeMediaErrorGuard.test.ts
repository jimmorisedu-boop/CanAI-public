import assert from 'node:assert/strict'
import test from 'node:test'
import { installNativeMediaErrorGuard, NATIVE_MEDIA_ERROR_ATTRIBUTE } from './nativeMediaErrorGuard'

type Listener = (event: Event) => void

class FakeMedia {
  readonly tagName: 'VIDEO' | 'AUDIO'
  error: object | null = null
  private readonly attributes = new Set<string>()

  constructor(tagName: 'VIDEO' | 'AUDIO') {
    this.tagName = tagName
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  setAttribute(name: string): void {
    this.attributes.add(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
}

class FakeDocument {
  readonly media: FakeMedia[] = []
  readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  querySelectorAll(): FakeMedia[] {
    return this.media
  }

  dispatch(type: string, target: unknown): void {
    const event = { target } as Event
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

test('document media guard hides failed video/audio, restores on load, and ignores images', () => {
  const document = new FakeDocument()
  const failedVideo = new FakeMedia('VIDEO')
  failedVideo.error = {}
  const healthyAudio = new FakeMedia('AUDIO')
  const image = { tagName: 'IMG' }
  document.media.push(failedVideo, healthyAudio)

  const cleanup = installNativeMediaErrorGuard(document as unknown as Document)
  assert.equal(failedVideo.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), true)
  assert.equal(healthyAudio.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), false)
  assert.equal(document.listeners.get('error')?.size, 1)
  assert.equal(document.listeners.get('loadstart')?.size, 1)

  healthyAudio.error = {}
  document.dispatch('error', healthyAudio)
  assert.equal(healthyAudio.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), true)

  document.dispatch('error', image)
  assert.equal((image as { tagName: string }).tagName, 'IMG')
  document.dispatch('loadstart', healthyAudio)
  assert.equal(healthyAudio.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), false)

  const sameCleanup = installNativeMediaErrorGuard(document as unknown as Document)
  assert.equal(sameCleanup, cleanup)
  cleanup()
  assert.equal(failedVideo.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), false)
  assert.equal(document.listeners.get('error')?.size, 0)
  assert.equal(document.listeners.get('loadstart')?.size, 0)
})

test('document media guard can be installed again after cleanup', () => {
  const document = new FakeDocument()
  const audio = new FakeMedia('AUDIO')
  audio.error = {}
  document.media.push(audio)

  const cleanup = installNativeMediaErrorGuard(document as unknown as Document)
  cleanup()
  const secondCleanup = installNativeMediaErrorGuard(document as unknown as Document)
  assert.notEqual(secondCleanup, cleanup)
  assert.equal(audio.hasAttribute(NATIVE_MEDIA_ERROR_ATTRIBUTE), true)
  secondCleanup()
})
