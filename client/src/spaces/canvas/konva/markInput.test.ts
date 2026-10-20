import test from 'node:test'
import assert from 'node:assert/strict'
import { isMarkDigit, markStep, MARK_MAX_DIGITS } from './markInput'

test('одна цифра ждёт паузу, чтобы дать набрать двузначную метку', () => {
  const first = markStep('', '1')
  assert.deepEqual(first, { buffer: '1', mark: 1, isFirstDigit: true, commit: false })
})

test('вторая цифра дописывает номер, а не начинает новый', () => {
  const second = markStep('1', '2')
  assert.equal(second.mark, 12)
  assert.equal(second.buffer, '12')
  assert.equal(second.isFirstDigit, false)
  assert.equal(second.commit, false)
})

test('третья цифра коммитит сразу — дальше цифр быть не может', () => {
  const third = markStep('12', '3')
  assert.equal(third.mark, 123)
  assert.equal(third.commit, true)
  assert.equal(third.buffer, '')
  assert.equal(MARK_MAX_DIGITS, 3)
})

test('ноль первой цифрой снимает метку', () => {
  const zero = markStep('', '0')
  assert.equal(zero.mark, undefined)
  assert.equal(zero.commit, true)
  assert.equal(zero.isFirstDigit, true)
})

test('ноль внутри номера — обычная цифра', () => {
  assert.equal(markStep('1', '0').mark, 10)
  assert.equal(markStep('10', '0').mark, 100)
})

test('цифру отличаем от прочих клавиш', () => {
  assert.equal(isMarkDigit('7'), true)
  assert.equal(isMarkDigit('0'), true)
  assert.equal(isMarkDigit('q'), false)
  assert.equal(isMarkDigit('Enter'), false)
  assert.equal(isMarkDigit('12'), false)
})
