import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { promptLineHeights, resolvePromptInputHeight } from './promptInputHeight'

test('ручная высота пустой строки остаётся после отпускания мыши', () => {
  assert.equal(resolvePromptInputHeight({
    promptIsEmpty: true,
    contentHeight: 34,
    preferredHeight: 360,
    availableHeight: 440,
    isFocused: false,
    isResizing: false,
    manuallySized: true,
  }), 360)
})

test('чат не наследует вручную заданную высоту обычного промпта', () => {
  assert.equal(resolvePromptInputHeight({
    promptIsEmpty: true,
    contentHeight: 34,
    preferredHeight: 360,
    availableHeight: 440,
    isFocused: false,
    isResizing: false,
    manuallySized: true,
    panel: 'chat',
  }), 34)
})

// Жалоба 19.10.2026: у окна помощника отступы 12+12 и рамка, строка 22.5 px —
// в прибитые 34 px пустое поле не помещалось и рисовало полосу прокрутки.
test('пустое поле помощника в покое вмещает одну строку целиком', () => {
  const heights = promptLineHeights({
    lineHeight: '22.5px',
    fontSize: '15px',
    paddingTop: '12px',
    paddingBottom: '12px',
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
  })
  assert.equal(heights.restingHeight, 49)
  assert.equal(resolvePromptInputHeight({
    promptIsEmpty: true,
    contentHeight: 49,
    preferredHeight: 250,
    availableHeight: 600,
    isFocused: false,
    isResizing: false,
    manuallySized: false,
    panel: 'chat',
    ...heights,
  }), 49)
})

test('превью в покое — две строки поля, а не прибитые 62 px', () => {
  const heights = promptLineHeights({
    lineHeight: '22.5px',
    fontSize: '15px',
    paddingTop: '12px',
    paddingBottom: '12px',
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
  })
  assert.equal(heights.previewHeight, 71)
  assert.equal(resolvePromptInputHeight({
    promptIsEmpty: false,
    contentHeight: 200,
    preferredHeight: 250,
    availableHeight: 600,
    isFocused: false,
    isResizing: false,
    manuallySized: false,
    panel: 'chat',
    ...heights,
  }), 71)
})

test('строка без числа в line-height считается по кеглю, а не нулём', () => {
  const heights = promptLineHeights({
    lineHeight: 'normal',
    fontSize: '20px',
    paddingTop: '10px',
    paddingBottom: '10px',
    borderTopWidth: '0px',
    borderBottomWidth: '0px',
  })
  assert.equal(heights.restingHeight, 50)
})

test('полоса прокрутки решается по настоящему размеру поля, а не по расчётной высоте', () => {
  const source = readFileSync(new URL('./usePromptInputSize.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /scrollHeight > next/)
  assert.match(source, /scrollHeight > textarea\.clientHeight/)
  assert.match(source, /promptLineHeights\(getComputedStyle\(textarea\)\)/)
})
