import assert from 'node:assert/strict'
import test from 'node:test'
import { frameBlob } from './videoFrameReader'

class Video extends EventTarget {
  muted = false; crossOrigin = ''; preload = ''; playsInline = false
  duration = 2; videoWidth = 320; videoHeight = 180; readyState = 2; seeking = false
  private time = 0
  get currentTime() { return this.time }
  set currentTime(value: number) {
    if (this.time === value) return // Safari может не прислать seeked для того же времени.
    this.time = value
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')))
  }
  set src(_value: string) { queueMicrotask(() => this.dispatchEvent(new Event('loadeddata'))) }
  pauses = 0
  pause() { this.pauses++ }
  load() {}
  removeAttribute(_name: string) {}
}

test('снимает нулевой кадр без ожидания отсутствующего seeked', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const video = new Video()
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => tag === 'video' ? video : {
      width: 0, height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (done: (blob: Blob) => void) => done(new Blob(['frame'], { type: 'image/png' })),
    },
  } })
  try {
    const result = await Promise.race([
      frameBlob('/media/clip.mp4', 0),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ])
    assert.ok(result, 'Чтение зависло в ожидании seeked на нулевой позиции')
    assert.equal(result.width, 320)
    assert.equal(result.blob.type, 'image/png')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

for (const scenario of ['timeout', 'canvas-error', 'visible-frame'] as const) {
  test(`освобождение декодера и конечное ожидание: ${scenario}`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const video = new Video()
    let createdVideos = 0
    if (scenario === 'timeout') video.readyState = 0
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement: (tag: string) => {
        if (tag === 'video') { createdVideos++; return video }
        return {
          width: 0, height: 0,
          getContext: () => ({ drawImage() { if (scenario === 'canvas-error') throw new Error('Canvas denied') } }),
          toBlob: (done: (blob: Blob) => void) => done(new Blob(['frame'], { type: 'image/png' })),
        }
      },
    } })
    try {
      const read = frameBlob('/media/clip.mp4', 0, {
        timeoutMs: 10,
        video: scenario === 'visible-frame' ? video as unknown as HTMLVideoElement : undefined,
      })
      if (scenario === 'visible-frame') {
        assert.equal((await read).width, 320)
        assert.equal(createdVideos, 0)
        assert.equal(video.pauses, 0, 'Видимый плеер нельзя останавливать')
      } else {
        await assert.rejects(read, scenario === 'timeout' ? /in time/ : /Canvas denied/)
        assert.equal(video.pauses, 1)
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
}
