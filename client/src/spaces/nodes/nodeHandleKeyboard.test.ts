import assert from 'node:assert/strict'
import test from 'node:test'
import type { KeyboardEvent } from 'react'
import { handleNodePortKeyDown } from './nodeHandleKeyboard'

function keyEvent(key: string, options: Partial<KeyboardEvent<HTMLDivElement>> = {}) {
  const actions = { clicks: 0, prevented: false, stopped: false }
  const event = {
    key, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    preventDefault: () => { actions.prevented = true },
    stopPropagation: () => { actions.stopped = true },
    currentTarget: { click: () => { actions.clicks++ } },
    ...options,
  } as KeyboardEvent<HTMLDivElement>
  return { event, actions }
}

test('Enter и пробел активируют порт ровно одним нативным click', () => {
  for (const key of ['Enter', ' ']) {
    const { event, actions } = keyEvent(key)
    handleNodePortKeyDown(event)
    assert.deepEqual(actions, { clicks: 1, prevented: true, stopped: true })
  }
})

test('удержание клавиши не переключает начатое соединение повторными click', () => {
  const { event, actions } = keyEvent(' ', { repeat: true })
  handleNodePortKeyDown(event)
  assert.deepEqual(actions, { clicks: 0, prevented: true, stopped: true })
})

test('Tab, undo и Ctrl+Space остаются доступными обработчикам редактора', () => {
  for (const [key, options] of [
    ['Tab', {}], ['z', { ctrlKey: true }], [' ', { ctrlKey: true }],
    ['Enter', { metaKey: true }], ['Enter', { altKey: true }],
  ] as const) {
    const { event, actions } = keyEvent(key, options)
    handleNodePortKeyDown(event)
    assert.deepEqual(actions, { clicks: 0, prevented: false, stopped: false })
  }
})
