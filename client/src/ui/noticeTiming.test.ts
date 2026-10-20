// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import {
  AUTO_DISMISS_MS,
  autoDismissDelay,
  scheduleAutoDismiss,
} from './noticeTiming.js'

test('обычное сообщение живёт две секунды', () => {
  // Просьба пользователя 18.08.2026: «буквально секунды две». Плашка читается
  // за миг, а висит поверх работы.
  assert.equal(AUTO_DISMISS_MS, 2000)
  assert.equal(autoDismissDelay('info', AUTO_DISMISS_MS), 2000)
  assert.equal(autoDismissDelay('success', AUTO_DISMISS_MS), 2000)
})

test('сообщение с кнопкой держится дольше — её надо успеть нажать', () => {
  // Две секунды на «Отменить» — это приглашение промахнуться.
  assert.equal(autoDismissDelay('info', AUTO_DISMISS_MS, true), 6000)
  assert.equal(autoDismissDelay('success', AUTO_DISMISS_MS, true), 6000)
  // Запрошенный срок длиннее нашего минимума не укорачиваем
  assert.equal(autoDismissDelay('success', 9000, true), 9000)
})

test('warning, error и постоянный info не получают таймер', () => {
  assert.equal(autoDismissDelay('warning', 5000), null)
  assert.equal(autoDismissDelay('error', 5000), null)
  assert.equal(autoDismissDelay('info', undefined), null)
})

test('schedule вызывает dismiss и cleanup отменяет ожидающий callback', () => {
  let callback: (() => void) | null = null
  let cleared: unknown = null
  let dismissed = 0
  const cleanup = scheduleAutoDismiss({
    tone: 'info',
    requestedMs: 5000,
    onDismiss: () => { dismissed++ },
    setTimer: (next, ms) => {
      assert.equal(ms, 5000)
      callback = next
      return 17
    },
    clearTimer: (handle) => { cleared = handle },
  })

  assert.equal(dismissed, 0)
  ;(callback as (() => void) | null)?.()
  assert.equal(dismissed, 1)
  cleanup()
  assert.equal(cleared, 17)
})

test('schedule не планирует warning или сообщение без onDismiss', () => {
  let scheduled = 0
  const setTimer = () => {
    scheduled++
    return 1
  }
  scheduleAutoDismiss({
    tone: 'warning',
    requestedMs: 5000,
    onDismiss: () => {},
    setTimer,
    clearTimer: () => {},
  })
  scheduleAutoDismiss({
    tone: 'info',
    requestedMs: 5000,
    onDismiss: undefined,
    setTimer,
    clearTimer: () => {},
  })
  assert.equal(scheduled, 0)
})
