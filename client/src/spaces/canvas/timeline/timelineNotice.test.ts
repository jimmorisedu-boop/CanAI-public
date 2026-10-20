import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { clearTimelineNotice, getTimelineNotice, notifyInTimeline, onTimelineNotice } from './timelineNotice.js'
import { setTimelineTarget } from './timelineBus.js'

// Сообщения режима правки живут посреди кадра, поэтому гаснуть обязаны ВСЕ,
// включая ошибку: висящая там до последнего плашка загораживала бы ровно то,
// ради чего в режим и зашли.

function inTimeline(run: () => void): void {
  setTimelineTarget('клип')
  try {
    run()
  } finally {
    clearTimelineNotice()
    setTimelineTarget(null)
  }
}

test('обычное сообщение гаснет само', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    inTimeline(() => {
      notifyInTimeline({ kind: 'info', message: 'Режу…' })
      assert.equal(getTimelineNotice()?.message, 'Режу…')
      mock.timers.tick(2_000)
      assert.equal(getTimelineNotice(), null)
    })
  } finally {
    mock.timers.reset()
  }
})

test('сообщение с действием держится дольше — его надо успеть нажать', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    inTimeline(() => {
      notifyInTimeline({ kind: 'success', message: 'Звук отделён', action: { label: 'Отменить', run: () => {} } })
      mock.timers.tick(4_000)
      assert.ok(getTimelineNotice(), 'через 4 секунды кнопка ещё на месте')
      mock.timers.tick(2_000)
      assert.equal(getTimelineNotice(), null)
    })
  } finally {
    mock.timers.reset()
  }
})

test('ошибка тоже гаснет сама, просто позже остальных', () => {
  // Раньше она висела до крестика. На полке под дорожкой это было терпимо, а
  // посреди кадра — нет: закрывать её руками пришлось бы каждый раз.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    inTimeline(() => {
      notifyInTimeline({ kind: 'error', message: 'Failed to cut video' })
      mock.timers.tick(2_000)
      assert.ok(getTimelineNotice(), 'ошибку дают прочитать дольше обычного сообщения')
      mock.timers.tick(3_000)
      assert.equal(getTimelineNotice(), null)
    })
  } finally {
    mock.timers.reset()
  }
})

test('новое сообщение отменяет таймер прежнего, а не гасится его временем', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    inTimeline(() => {
      notifyInTimeline({ kind: 'info', message: 'первое' })
      mock.timers.tick(3_500)
      notifyInTimeline({ kind: 'info', message: 'второе' })
      mock.timers.tick(1_000)
      assert.equal(getTimelineNotice()?.message, 'второе', 'чужой таймер не гасит свежее сообщение')
      mock.timers.tick(3_000)
      assert.equal(getTimelineNotice(), null)
    })
  } finally {
    mock.timers.reset()
  }
})

test('подписчик узнаёт и о появлении, и о гашении', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const seen: Array<string | null> = []
  const off = onTimelineNotice((notice) => seen.push(notice?.message ?? null))
  try {
    inTimeline(() => {
      notifyInTimeline({ kind: 'info', message: 'Режу…' })
      mock.timers.tick(4_000)
    })
    assert.deepEqual(seen, ['Режу…', null])
  } finally {
    off()
    mock.timers.reset()
  }
})
