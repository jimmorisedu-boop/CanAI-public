import assert from 'node:assert/strict'
import test from 'node:test'
import { AttemptWindow } from './accessAttempts.js'


test('окно попыток блокирует по лимиту, забывает по времени и сбрасывается', () => {
  let now = 0
  const window = new AttemptWindow({ max: 3, windowMs: 1_000, now: () => now })

  assert.equal(window.blocked('гость'), false)
  window.register('гость')
  window.register('гость')
  assert.equal(window.blocked('гость'), false)
  window.register('гость')
  assert.equal(window.blocked('гость'), true)
  assert.equal(window.blocked('другой'), false, 'лимит считается по каждому ключу отдельно')

  now = 1_001
  assert.equal(window.blocked('гость'), false, 'старые попытки выпадают из окна')

  now = 1_100
  window.register('гость'); window.register('гость'); window.register('гость')
  assert.equal(window.blocked('гость'), true)
  window.clear('гость')
  assert.equal(window.blocked('гость'), false, 'успешный вход обнуляет счётчик')
})
