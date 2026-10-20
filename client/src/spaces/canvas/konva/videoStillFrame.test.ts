import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import {
  cacheVideoStill,
  captureStillFrame,
  getCachedVideoStill,
  STILL_MAX_EDGE,
  stillFrameSize,
  VIDEO_STILL_CACHE_MAX_EDGE,
  VIDEO_STILL_CACHE_LIMIT,
  usePausedVideoStill,
} from './videoStillFrame.js'

/**
 * ⚠️ Стоящий ролик рисовался прямо из <video>, и браузер доставал из него кадр
 * на КАЖДОЙ перерисовке холста — то есть на каждом кадре прокрутки. В Firefox
 * два ролика 1920×1080 среди сотни картинок стоили 50 кадров в секунду против
 * 60 (замер 25.09.2026). Снимок кадра рисуется как обычная картинка.
 */

function fakeCanvas() {
  const calls: unknown[][] = []
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => ({ drawImage: (...args: unknown[]) => { calls.push(args) } }),
  }
  return { canvas: canvas as unknown as HTMLCanvasElement, calls }
}

function fakeVideo(over: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return { readyState: 4, videoWidth: 1920, videoHeight: 1080, paused: true, ...over } as HTMLVideoElement
}

type VideoWithEvents = HTMLVideoElement & { dispatch(name: string): void }

function eventVideo(over: Partial<HTMLVideoElement> = {}): VideoWithEvents {
  const listeners = new Map<string, Set<() => void>>()
  const video = {
    readyState: 1,
    videoWidth: 1920,
    videoHeight: 1080,
    paused: true,
    addEventListener(name: string, listener: () => void) {
      const set = listeners.get(name) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(name, set)
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.get(name)?.delete(listener)
    },
    dispatch(name: string) {
      for (const listener of listeners.get(name) ?? []) listener()
    },
    ...over,
  }
  return video as unknown as VideoWithEvents
}

function renderPausedHook(video: HTMLVideoElement | undefined, src: string) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previous = internals.ReactCurrentDispatcher.current
  const slots: any[] = []
  const effects: Array<() => void | (() => void)> = []
  let cursor = 0
  const dispatcher = {
    useRef: (value: unknown) => slots[cursor++] ??= ({ current: value }),
    useState: (value: any) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = typeof value === 'function' ? value() : value
      return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  }
  const render = () => {
    cursor = 0
    internals.ReactCurrentDispatcher.current = dispatcher
    try {
      return usePausedVideoStill(video, false, () => undefined, src)
    } finally {
      internals.ReactCurrentDispatcher.current = previous
    }
  }
  const value = render()
  return { value, render, effects }
}

function domCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
  } as unknown as HTMLCanvasElement
}

test('снимок не крупнее нужного: длинная сторона ограничена, пропорции целы', () => {
  assert.deepEqual(stillFrameSize(1920, 1080), { w: STILL_MAX_EDGE, h: 720 })
  assert.deepEqual(stillFrameSize(1080, 1920), { w: 720, h: STILL_MAX_EDGE })
  assert.deepEqual(stillFrameSize(640, 360), { w: 640, h: 360 }, 'маленький ролик не растягиваем')
  assert.equal(stillFrameSize(0, 1080), null)
  assert.equal(stillFrameSize(Number.NaN, 1080), null)
})

test('кадр снимается в холст размером снимка', () => {
  const { canvas, calls } = fakeCanvas()
  const video = fakeVideo()
  assert.equal(captureStillFrame(video, canvas), true)
  assert.equal(canvas.width, STILL_MAX_EDGE)
  assert.equal(canvas.height, 720)
  assert.deepEqual(calls, [[video, 0, 0, STILL_MAX_EDGE, 720]])
})

test('пока кадра нет, снимка нет: чёрный прямоугольник хуже самого ролика', () => {
  const { canvas, calls } = fakeCanvas()
  assert.equal(captureStillFrame(fakeVideo({ readyState: 1 }), canvas), false)
  assert.equal(captureStillFrame(fakeVideo({ videoWidth: 0 }), canvas), false)
  assert.deepEqual(calls, [])
})

test('отказ браузера рисовать кадр не ломает фигуру', () => {
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: () => { throw new Error('SecurityError') } }),
  } as unknown as HTMLCanvasElement
  assert.equal(captureStillFrame(fakeVideo(), canvas), false)
})

test('постер переживает culling, но кэш остаётся ограниченным', () => {
  assert.equal(VIDEO_STILL_CACHE_MAX_EDGE, 512)
  const canvas = (id: number) => ({ width: 2, height: 2, id } as unknown as HTMLCanvasElement)
  const first = canvas(0)
  cacheVideoStill('/api/cloud-assets/assets/poster-first', first)
  for (let index = 1; index <= VIDEO_STILL_CACHE_LIMIT; index += 1) {
    cacheVideoStill(`/api/cloud-assets/assets/poster-${index}`, canvas(index))
  }
  assert.equal(getCachedVideoStill('/api/cloud-assets/assets/poster-first'), null)
  assert.equal(getCachedVideoStill(`/api/cloud-assets/assets/poster-${VIDEO_STILL_CACHE_LIMIT}`)?.width, 2)
})

test('ремонтированный poster виден на повторном монтаже до loadeddata нового ролика', () => {
  const src = '/api/cloud-assets/assets/remount-poster-behavior'
  const previousDocument = (globalThis as any).document
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  ;(globalThis as any).document = { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
    return domCanvas()
  } }

  try {
    const firstVideo = eventVideo({ readyState: 1 })
    const firstMount = renderPausedHook(firstVideo, src)
    assert.equal(firstMount.value, null, 'до первого кадра poster отсутствует')
    const firstCleanups = firstMount.effects.map((effect) => effect())

    // The first mount reaches a usable frame and the paused hook captures it.
    ;(firstVideo as any).readyState = 4
    firstVideo.dispatch('loadeddata')
    const loadedStill = firstMount.render()
    assert.ok(loadedStill, 'loaded frame must produce a paused poster')
    assert.ok(getCachedVideoStill(src), 'loaded frame must be remembered across culling')
    for (const cleanup of firstCleanups) cleanup?.()

    // Culling unmounts the old video. A new decoder is still waiting for data,
    // but the remounted card already has the cached thumbnail to draw.
    const freshVideo = eventVideo({ readyState: 1 })
    const remount = renderPausedHook(freshVideo, src)
    assert.equal(freshVideo.readyState, 1)
    assert.equal(remount.value, getCachedVideoStill(src))
    const remountCleanups = remount.effects.map((effect) => effect())
    for (const cleanup of remountCleanups) cleanup?.()
  } finally {
    if (hadDocument) (globalThis as any).document = previousDocument
    else delete (globalThis as any).document
  }
})

test('холст рисует снимок, пока ролик стоит, и сам ролик, пока играет', async () => {
  const item = await readFile(new URL('./VideoItem.tsx', import.meta.url), 'utf8')
  assert.match(item, /usePausedVideoStill\(video, playing,/)
  assert.match(item, /image=\{still \?\? video\}/)
  const hook = await readFile(new URL('./videoStillFrame.ts', import.meta.url), 'utf8')
  assert.match(hook, /return playing \? null : still/, 'во время игры — только живой ролик')
  assert.match(hook, /if \(!alive \|\| !video\.paused\) return/, 'снимаем только стоящий ролик')
  assert.match(hook, /getCachedVideoStill\(src\)/, 'кэшированный poster сразу используется после culling')
  assert.match(hook, /cacheVideoStill\(src, canvas\)/, 'новый paused кадр обновляет кэш')
})

test('планшетный просмотр использует тот же poster после culling', async () => {
  const board = await readFile(new URL('../../../tablet/BoardItemView.tsx', import.meta.url), 'utf8')
  assert.match(board, /cachedVideoStillDataUrl\(videoSrc\)/)
  assert.match(board, /poster=\{videoPoster\}/)
  assert.match(board, /onPause=\{rememberPoster\}/)
})
