import assert from 'node:assert/strict'
import test from 'node:test'
import type { ButtonHTMLAttributes, DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NodePaletteButton } from './NodePaletteButton.js'

function propsOf(element: ReturnType<typeof NodePaletteButton>): ButtonHTMLAttributes<HTMLButtonElement> {
  return element.props as ButtonHTMLAttributes<HTMLButtonElement>
}

test('click по палитре добавляет ровно одну ноду', () => {
  const added: string[] = []
  const element = NodePaletteButton({
    kind: 'text',
    label: 'Текст',
    loaded: true,
    onAdd: (kind) => added.push(kind),
  })

  assert.equal(element.type, 'button')
  propsOf(element).onClick?.({} as MouseEvent<HTMLButtonElement>)
  assert.deepEqual(added, ['text'])
})

test('нативная кнопка сохраняет клавиатурную семантику и disabled-состояние', () => {
  const html = renderToStaticMarkup(NodePaletteButton({
    kind: 'text',
    label: 'Текст',
    loaded: false,
    onAdd: () => undefined,
  }))

  assert.match(html, /^<button/)
  assert.match(html, /disabled=""/)
  assert.match(html, /Click or drag/)
})

test('Enter и Space добавляют по одной ноде без ожидания синтетического click', () => {
  const added: string[] = []
  let prevented = 0
  const element = NodePaletteButton({
    kind: 'text',
    label: 'Текст',
    loaded: true,
    onAdd: (kind) => added.push(kind),
  })
  const onKeyDown = propsOf(element).onKeyDown

  for (const key of ['Enter', ' ']) {
    onKeyDown?.({
      key,
      repeat: false,
      preventDefault: () => { prevented += 1 },
    } as unknown as KeyboardEvent<HTMLButtonElement>)
  }

  assert.deepEqual(added, ['text', 'text'])
  assert.equal(prevented, 2)
})

test('dragstart заполняет DnD-контракт и не запускает click-путь', () => {
  const added: string[] = []
  const writes = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: 'none',
    setData: (type: string, value: string) => writes.set(type, value),
    getData: (type: string) => writes.get(type) ?? '',
  }
  const element = NodePaletteButton({
    kind: 'text',
    label: 'Текст',
    loaded: true,
    onAdd: (kind) => added.push(kind),
  })

  propsOf(element).onDragStart?.({ dataTransfer } as unknown as DragEvent<HTMLButtonElement>)
  assert.deepEqual(added, [])
  assert.equal(dataTransfer.effectAllowed, 'copy')
  assert.equal(writes.get('application/x-canai-node-kind'), 'text')
})
