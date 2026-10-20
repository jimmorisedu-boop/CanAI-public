import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvasVideoPlaybackCommands, shouldTogglePlaybackOnClick } from './videoPlaybackCoordinator'

interface FixtureOptions {
  currentTime?: number
  duration?: number
  ended?: boolean
  playRejects?: boolean
}

function fixture(scope: object, id: string, options: FixtureOptions = {}) {
  let pauseCalls = 0
  let playCalls = 0
  let playing = false
  let shownTime = options.currentTime ?? 5
  let redraws = 0
  const video = {
    currentTime: options.currentTime ?? 5,
    duration: options.duration ?? 10,
    ended: options.ended ?? false,
    pause() {
      pauseCalls += 1
    },
    play() {
      playCalls += 1
      return options.playRejects
        ? Promise.reject(new Error('play rejected'))
        : Promise.resolve()
    },
  }
  const commands = createCanvasVideoPlaybackCommands(scope, id, video, {
    setPlaying(value) {
      playing = value
    },
    setCurrentTime(value) {
      shownTime = value
    },
    redraw() {
      redraws += 1
    },
  })
  return {
    commands,
    video,
    get pauseCalls() { return pauseCalls },
    get playCalls() { return playCalls },
    get playing() { return playing },
    get shownTime() { return shownTime },
    get redraws() { return redraws },
  }
}

test('запуск второго видео останавливает первое и перематывает его в начало', () => {
  const scope = {}
  const first = fixture(scope, 'first', { currentTime: 7 })
  const second = fixture(scope, 'second', { currentTime: 3 })

  first.commands.start()
  second.commands.start()

  assert.equal(first.pauseCalls, 1)
  assert.equal(first.video.currentTime, 0)
  assert.equal(first.shownTime, 0)
  assert.equal(first.playing, false)
  assert.equal(first.redraws, 1)
  assert.equal(second.playing, true)
})

test('ручная пауза сохраняет текущий кадр', () => {
  const current = fixture({}, 'current', { currentTime: 6 })
  current.commands.start()
  current.commands.pause()

  assert.equal(current.pauseCalls, 1)
  assert.equal(current.video.currentTime, 6)
  assert.equal(current.shownTime, 6)
  assert.equal(current.playing, false)
})

test('повторная регистрация того же видео не останавливает его', () => {
  const scope = {}
  const current = fixture(scope, 'same')
  current.commands.start()
  current.commands.start()
  assert.equal(current.pauseCalls, 0)
})

test('запоздалый cleanup старого видео не освобождает новое', () => {
  const scope = {}
  const first = fixture(scope, 'first')
  const second = fixture(scope, 'second')
  const third = fixture(scope, 'third')

  first.commands.start()
  second.commands.start()
  first.commands.release()
  third.commands.start()

  assert.equal(second.pauseCalls, 1)
  assert.equal(second.video.currentTime, 0)
})

test('разные доски не останавливают видео друг друга', () => {
  const first = fixture({}, 'first')
  const second = fixture({}, 'second')
  first.commands.start()
  second.commands.start()
  assert.equal(first.pauseCalls, 0)
})

test('отказ play освобождает слот и возвращает кнопку воспроизведения', async () => {
  const scope = {}
  const rejected = fixture(scope, 'rejected', { playRejects: true })
  const next = fixture(scope, 'next')

  rejected.commands.start()
  await Promise.resolve()
  await Promise.resolve()
  next.commands.start()

  assert.equal(rejected.playing, false)
  assert.equal(rejected.pauseCalls, 0)
})

test('первый клик по видео только выделяет, играть просят вторым', () => {
  // Клик по невыделенному клипу — это «возьми его»: перетащить, сделать
  // референсом, открыть правку. Запускать при этом звук значит заставлять
  // человека каждый раз его гасить.
  assert.equal(shouldTogglePlaybackOnClick({ wasSelected: false, shiftKey: false }), false)
  assert.equal(shouldTogglePlaybackOnClick({ wasSelected: true, shiftKey: false }), true)
})

test('Shift+клик набирает выделение и ничего не запускает', () => {
  assert.equal(shouldTogglePlaybackOnClick({ wasSelected: false, shiftKey: true }), false)
  assert.equal(shouldTogglePlaybackOnClick({ wasSelected: true, shiftKey: true }), false)
})
