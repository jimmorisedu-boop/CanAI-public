// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
import { promptHeightBudget } from './usePromptHeightBudget'

test('manual prompt height reaches board top at every panel scale and keyboard height', () => {
  for (const scale of [.6, 1, 1.4]) {
    for (const bottom of [440, 880]) {
      const chrome = 160
      const height = promptHeightBudget(bottom, 60, scale, chrome)
      assert.ok(Math.abs(bottom - (height + chrome) * scale - 68) < .001)
    }
  }
})
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import * as viewportModel from './visualViewportModel'

const { tabletViewportState } = viewportModel

type PromptLayout = {
  rows: number
  minHeight: number
  maxHeight: number
}

function promptLayout(input: {
  expanded: boolean
  largeEditor: boolean
  keyboardOpen: boolean
  visibleHeight: number
}): PromptLayout | undefined {
  return (viewportModel as typeof viewportModel & {
    tabletPromptLayout?: (value: typeof input) => PromptLayout
  }).tabletPromptLayout?.(input)
}

test('пристыкованная клавиатура определяется по заметному сокращению viewport', () => {
  assert.deepEqual(tabletViewportState(820, { height: 470, offsetTop: 0 }), {
    keyboardOpen: true,
    bottomInset: 350,
    visibleHeight: 470,
  })
})

test('внешняя клавиатура не включает компактное состояние', () => {
  assert.deepEqual(tabletViewportState(820, { height: 800, offsetTop: 0 }), {
    keyboardOpen: false,
    bottomInset: 20,
    visibleHeight: 800,
  })
})

test('смещение viewport учитывается в нижнем отступе', () => {
  assert.equal(tabletViewportState(820, { height: 500, offsetTop: 40 }).bottomInset, 280)
})

test('обычное поле начинается с одной строки и растёт по тексту над клавиатурой', () => {
  const layout = promptLayout({
    expanded: true,
    largeEditor: false,
    keyboardOpen: true,
    visibleHeight: 470,
  })

  assert.ok(layout, 'модель должна описывать геометрию редактора')
  assert.equal(layout.rows, 1)
  assert.equal(layout.minHeight, 44)
  assert.ok(layout.maxHeight <= 188, 'обычный редактор не должен занять больше 40% видимой области')
  assert.ok(layout.maxHeight >= layout.minHeight)
})

test('большой редактор даёт больше места и всё равно оставляет контекст канваса', () => {
  const regular = promptLayout({
    expanded: true,
    largeEditor: false,
    keyboardOpen: true,
    visibleHeight: 470,
  })
  const large = promptLayout({
    expanded: true,
    largeEditor: true,
    keyboardOpen: true,
    visibleHeight: 470,
  })

  assert.ok(regular && large)
  assert.ok(large.rows > regular.rows)
  assert.ok(large.maxHeight > regular.maxHeight)
  assert.ok(large.maxHeight <= 329, 'большой редактор не должен занять больше 70% видимой области')
})

test('в покое редактор остаётся компактным и не отнимает холст', () => {
  assert.deepEqual(promptLayout({
    expanded: false,
    largeEditor: false,
    keyboardOpen: false,
    visibleHeight: 820,
  }), {
    rows: 1,
    minHeight: 44,
    maxHeight: 88,
  })
})

test('меню параметров 1280x720 не уезжает под верхнюю панель', () => {
  const placement = viewportModel.tabletSettingsPlacement({
    promptTop: 348,
    popoverHeight: 388,
    viewportTop: 0,
    viewportHeight: 720,
  })

  assert.equal(placement.placement, 'viewport-top')
  assert.equal(placement.top, -288)
  assert.equal(placement.maxHeight, 652)
  assert.equal(placement.top + 348, 60, 'верх меню остаётся ниже topbar')
  assert.ok(placement.maxHeight + 60 <= 720 - 8, 'низ меню остаётся внутри viewport')
})

test('когда места достаточно, меню остаётся пристыкованным над доком', () => {
  assert.deepEqual(viewportModel.tabletSettingsPlacement({
    promptTop: 520,
    popoverHeight: 388,
    viewportTop: 0,
    viewportHeight: 720,
  }), {
    placement: 'above',
    top: null,
    maxHeight: null,
  })
})
