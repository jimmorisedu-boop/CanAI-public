import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import type { ButtonHTMLAttributes, DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LanguageProvider } from '../../i18n/context.js'
import { createLanguageStore } from '../../i18n/language.js'
import { NodePaletteButton } from './NodePaletteButton.js'

function propsOf(element: ReturnType<typeof NodePaletteButton>): ButtonHTMLAttributes<HTMLButtonElement> {
  return element.props as ButtonHTMLAttributes<HTMLButtonElement>
}

type NodePaletteButtonProps = Parameters<typeof NodePaletteButton>[0]
const languageStore = createLanguageStore(null)

/** Invoke the function component under its language provider so useT has a dispatcher. */
function invoke(props: NodePaletteButtonProps): ReturnType<typeof NodePaletteButton> {
  let element!: ReturnType<typeof NodePaletteButton>
  function Probe(): ReturnType<typeof NodePaletteButton> {
    element = NodePaletteButton(props)
    return element
  }
  renderToStaticMarkup(
    React.createElement(
      LanguageProvider,
      { store: languageStore, children: React.createElement(Probe) },
    ),
  )
  return element
}

function renderButton(props: NodePaletteButtonProps): string {
  return renderToStaticMarkup(
    React.createElement(
      LanguageProvider,
      { store: languageStore, children: React.createElement(NodePaletteButton, props) },
    ),
  )
}

test('click по палитре добавляет ровно одну ноду', () => {
  const added: string[] = []
  const element = invoke({
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
  const html = renderButton({
    kind: 'text',
    label: 'Текст',
    loaded: false,
    onAdd: () => undefined,
  })

  assert.match(html, /^<button/)
  assert.match(html, /disabled=""/)
  assert.match(html, /Click or drag/)
})

test('Enter и Space добавляют по одной ноде без ожидания синтетического click', () => {
  const added: string[] = []
  let prevented = 0
  const element = invoke({
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
  const element = invoke({
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
