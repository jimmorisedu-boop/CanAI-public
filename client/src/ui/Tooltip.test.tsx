import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Tooltip } from './Tooltip'

test('родной title снимается: браузер не показывает вторую подсказку поверх нашей', () => {
  const html = renderToStaticMarkup(
    <Tooltip title="Ссылка с этого компьютера" hint="Работает, пока запущено приложение">
      <button type="button" title="Поделиться доской" aria-label="Поделиться доской">знак</button>
    </Tooltip>,
  )
  assert.doesNotMatch(html, /title="/u, 'родной title обязан исчезнуть')
  assert.match(html, /role="tooltip"/u)
  assert.match(html, /aria-describedby="/u, 'подсказка должна быть связана с кнопкой')
  assert.match(html, /Ссылка с этого компьютера/u)
  assert.match(html, /Работает, пока запущено приложение/u)
})

test('имя для чтения с экрана остаётся на кнопке, а не уходит в подсказку', () => {
  const html = renderToStaticMarkup(
    <Tooltip title="Заголовок"><button type="button" aria-label="Поделиться доской">знак</button></Tooltip>,
  )
  assert.match(html, /aria-label="Поделиться доской"/u)
})

test('по умолчанию подсказка открывается вниз — шапка приложения не меняется', () => {
  const html = renderToStaticMarkup(
    <Tooltip title="Тема"><button type="button" aria-label="Тема">знак</button></Tooltip>,
  )
  assert.match(html, /class="ui-tooltip-host"/u)
  assert.match(html, /class="ui-tooltip"/u, 'без размещения у слоя подсказки нет модификатора')
})

test('нижним рядам окна подсказка открывается вверх, обёртка может занять своё место', () => {
  const html = renderToStaticMarkup(
    <Tooltip
      title="Разрезать · S"
      placement="top-start"
      hostClassName="tl-host"
      hostStyle={{ left: '40%' }}
    >
      <button type="button" aria-label="Разрезать">знак</button>
    </Tooltip>,
  )
  assert.match(html, /class="ui-tooltip-host tl-host"/u)
  assert.match(html, /style="left:40%"/u)
  assert.match(html, /class="ui-tooltip top-start"/u)
  assert.doesNotMatch(html, /title="/u, 'родной title снимается при любом размещении')
})

test('размещения вверх описаны в стилях и подсказка по-прежнему не ловит указатель', async () => {
  const css = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../styles/controls.css', import.meta.url), 'utf8'))
  for (const placement of ['.ui-tooltip.top', '.ui-tooltip.top-start', '.ui-tooltip.top-end']) {
    assert.ok(css.includes(placement), `в controls.css нет размещения ${placement}`)
  }
  assert.match(css, /\.ui-tooltip\.top,[\s\S]*?bottom:\s*calc\(100% \+ 8px\)/u, 'вверх — значит подпись над значком')
})

test('фокус после клика не оставляет старую подсказку поверх соседней', async () => {
  // После клика кнопка сохраняет обычный focus. Если показывать подсказку через
  // focus-within, при наведении на соседнюю кнопку на экране остаются обе.
  // Клавиатурный focus-visible при этом обязан продолжать показывать подсказку.
  const css = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../styles/controls.css', import.meta.url), 'utf8'))
  const start = css.indexOf('.ui-tooltip-host:hover')
  const end = css.indexOf('@media (prefers-reduced-motion', start)
  const visibilityRule = css.slice(start, end)

  assert.match(visibilityRule, /\.ui-tooltip-host:hover \.ui-tooltip/u)
  assert.match(visibilityRule, /> :focus-visible \+ \.ui-tooltip/u,
    'клавиатурный фокус должен открывать подсказку')
  assert.doesNotMatch(visibilityRule, /:focus-within/u,
    'обычный фокус мышью не должен приклеивать старую подсказку')
})

test('первый тап не съедается подсказкой: слой не перехватывает pointer/click', async () => {
  // §15 ТЗ: первый tap по action-кнопке обязан ЗАПУСТИТЬ действие. Подсказка
  // может жить только неблокирующим способом — pointer-events:none у слоя и
  // никаких перехватчиков pointerdown/click/stopPropagation у обёртки.
  // Браузерного DOM в этом проекте нет (jsdom не подключён), поэтому тест
  // запирает сам контракт слоя по исходнику, как и остальные тесты Tooltip.
  const [tooltipSource, controlsCss] = await Promise.all([
    import('node:fs').then((fs) => fs.readFileSync(new URL('./Tooltip.tsx', import.meta.url), 'utf8')),
    import('node:fs').then((fs) => fs.readFileSync(new URL('../styles/controls.css', import.meta.url), 'utf8')),
  ])
  // сам Tooltip не вешает ни одного указателя/клика на host или слой
  assert.doesNotMatch(
    tooltipSource,
    /onPointer|onClick|onMouse|onTouch|stopPropagation|preventDefault/u,
    'обёртка подсказки не имеет права перехватывать первый тап',
  )
  // слой подсказки физически не ловит указатель (CSS-инвариант из controls.css)
  assert.match(
    controlsCss,
    /\.ui-tooltip\s*\{[\s\S]*?pointer-events:\s*none/u,
    'слой подсказки обязан иметь pointer-events:none',
  )
})

test('local top bar has no team publication or network presence controls', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'))
  assert.doesNotMatch(source, /AccountPublicationControl|PersonalDraftControl|BoardParticipantsMenu|TeamBudgetIndicator/u)
})
