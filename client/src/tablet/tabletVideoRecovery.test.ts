import assert from 'node:assert/strict'
import test from 'node:test'
import { watchTabletVideo } from './tabletVideoRecovery'

test('медленно поступающее видео не считается ошибкой через 15 секунд от открытия', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const video = Object.assign(new EventTarget(), { readyState: 0, currentTime: 0, duration: 10, error: null, load() {} })
  const states: string[] = []
  const watch = watchTabletVideo(video as unknown as HTMLVideoElement, state => states.push(state), new EventTarget())
  try {
    t.mock.timers.tick(14_000)
    video.dispatchEvent(new Event('progress'))
    t.mock.timers.tick(14_000)
    assert.equal(states.at(-1), 'loading')
    video.dispatchEvent(new Event('loadeddata'))
    t.mock.timers.tick(20_000)
    assert.equal(states.at(-1), 'ready')
  } finally { watch.dispose() }
})

test('видео без сетевого прогресса показывает повтор загрузки', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const video = Object.assign(new EventTarget(), { readyState: 0, currentTime: 0, duration: 10, error: null, load() {} })
  const states: string[] = []
  const watch = watchTabletVideo(video as unknown as HTMLVideoElement, state => states.push(state), new EventTarget())
  try { t.mock.timers.tick(15_001); assert.equal(states.at(-1), 'error') }
  finally { watch.dispose() }
})

test('после сетевой ошибки перезагружает видео при online и сохраняет позицию; исправное видео не трогает', () => {
  const video = Object.assign(new EventTarget(), {
    readyState: 2, currentTime: 4, duration: 10, error: null, seeking: false,
    load() { this.currentTime = 0; loads++ },
  })
  let loads = 0
  const events = new EventTarget()
  const states: string[] = []
  const watch = watchTabletVideo(video as unknown as HTMLVideoElement, states.push.bind(states), events)
  events.dispatchEvent(new Event('focus'))
  assert.equal(loads, 0)
  video.dispatchEvent(new Event('error'))
  assert.equal(states.at(-1), 'error')
  events.dispatchEvent(new Event('online'))
  assert.equal(loads, 1)
  video.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(video.currentTime, 4)
  video.dispatchEvent(new Event('loadeddata'))
  assert.equal(states.at(-1), 'ready')
  watch.dispose()
  video.dispatchEvent(new Event('error'))
  events.dispatchEvent(new Event('online'))
  assert.equal(loads, 1)
})
