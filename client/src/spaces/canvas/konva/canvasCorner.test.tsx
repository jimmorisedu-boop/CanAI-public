import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { BoardNavigator } from './BoardNavigator'
import { CanvasCorner, CORNER_NARROW_BELOW, canvasCornerIsTight } from './CanvasCorner'
import { CanvasStore } from './canvasStore'
import { canvasCornerDockIntersects, canvasCornerDockReserve } from './useCanvasCornerDockReserve'

/**
 * Мини-карта остаётся у нижнего левого края. Участники перенесены в шапку:
 * ни раскрытая карта, ни высокий док не должны прятать список людей.
 */

const block = (css: string, selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  assert.ok(start >= 0, `в стилях нет правила ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

const canvasUi = readFileSync(new URL('../../../styles/canvas-ui.css', import.meta.url), 'utf8')
const promptBar = readFileSync(new URL('../../../styles/prompt-bar.css', import.meta.url), 'utf8')

function childTypes(element: React.ReactElement): unknown[] {
  return React.Children.toArray((element.props as { children?: React.ReactNode }).children)
    .map((child) => (child as React.ReactElement).type)
}

test('у мини-карты нет списка участников: он открывается из верхней панели', () => {
  const store = new CanvasStore()
  const corner = CanvasCorner({ store, viewport: { w: 1440, h: 848 }, showNavigator: true })
  assert.equal(corner.props.className, 'canvas-corner')
  assert.deepEqual(childTypes(corner), [BoardNavigator])

  // Скетч, обрезка, правка клипа не оставляют плашку участников на холсте.
  const withoutMap = CanvasCorner({ store, viewport: { w: 1440, h: 848 }, showNavigator: false })
  assert.deepEqual(childTypes(withoutMap), [])
})

test('на узком холсте колонка сохраняет нижний левый угол', () => {
  const store = new CanvasStore()
  const narrow = CanvasCorner({ store, viewport: { w: CORNER_NARROW_BELOW - 1, h: 700 }, showNavigator: true })
  const wide = CanvasCorner({ store, viewport: { w: CORNER_NARROW_BELOW, h: 700 }, showNavigator: true })
  assert.match(narrow.props.className, /\bis-narrow\b/)
  assert.doesNotMatch(wide.props.className, /is-narrow/)
})

test('мини-карта остаётся в нижнем углу без списка участников', () => {
  for (const selector of ['.board-navigator']) {
    const rule = block(canvasUi, selector)
    assert.doesNotMatch(rule, /position\s*:/, `${selector}: своё место — это снова угаданная высота соседа`)
    assert.doesNotMatch(rule, /[\s;{](top|bottom|left|right)\s*:/, `${selector}: без собственных отступов от края`)
  }
  assert.match(block(canvasUi, '.canvas-corner'), /display:\s*grid/)
  assert.match(block(canvasUi, '.canvas-corner > .board-navigator'), /grid-row:\s*2/)
  // Свободное место остаётся НАД картой: третья строка снова поднимет её
  // к середине высокого окна, как на скриншоте 16.10.2026.
  assert.match(block(canvasUi, '.canvas-corner'), /grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, auto\)/)
  assert.doesNotMatch(block(canvasUi, '.canvas-corner.is-narrow'), /grid-template-rows:/)
  assert.match(block(canvasUi, '.canvas-corner.is-narrow'), /bottom:\s*max\(14px, var\(--canvas-corner-dock-reserve, 0px\)\)/)
})

test('порог узкого холста сходится с шириной промпта и колонки', () => {
  // Числа берём из стилей, а не переписываем сюда: поменяют ширину промпта
  // или карты — тест скажет, что порог пора пересчитать.
  const dockWidth = Number(block(promptBar, '.prompt-dock').match(/width:\s*min\((\d+)px/)?.[1])
  const mapWidth = Number(block(canvasUi, '.board-navigator').match(/\swidth:\s*(\d+)px/)?.[1])
  const corner = block(canvasUi, '.canvas-corner')
  const inset = Number(corner.match(/\sleft:\s*(\d+)px/)?.[1])
  const columnMax = Number(corner.match(/max-width:\s*min\((\d+)px/)?.[1])
  assert.ok(dockWidth > 0 && mapWidth > 0 && inset > 0, 'размеры читаются из стилей')
  assert.equal(columnMax, mapWidth, 'колонка не шире развёрнутой карты — иначе список вылезет за порог')
  assert.ok(
    inset + mapWidth <= (CORNER_NARROW_BELOW - dockWidth) / 2,
    'на широком холсте колонка не доходит до промпта',
  )
})

test('узкий corner резервирует фактический верх dock, а wide остаётся без него', () => {
  const store = new CanvasStore()
  const narrow = CanvasCorner({
    store,
    viewport: { w: CORNER_NARROW_BELOW - 1, h: 720 },
    showNavigator: true,
    dockBottomReserve: 376,
  })
  const wide = CanvasCorner({
    store,
    viewport: { w: CORNER_NARROW_BELOW, h: 720 },
    showNavigator: true,
    dockBottomReserve: 376,
  })
  assert.equal((narrow.props.style as Record<string, string>)['--canvas-corner-dock-reserve'], '376px')
  assert.equal(wide.props.style, undefined)
})

test('при нулевом месте corner показывает компактный toggle карты вместо полосы', () => {
  const store = new CanvasStore()
  const tight = CanvasCorner({
    store,
    viewport: { w: CORNER_NARROW_BELOW - 1, h: 720 },
    showNavigator: true,
    dockBottomReserve: 700,
  })
  assert.equal(canvasCornerIsTight(720, 700), true)
  assert.match(tight.props.className, /\bis-tight\b/)
  const tightRule = block(canvasUi, '.canvas-corner.is-narrow.is-tight')
  assert.match(tightRule, /height:\s*42px/)
  assert.match(tightRule, /bottom:\s*auto/)
})

test('dock reserve is derived from viewport rectangles without a mode-specific height guess', () => {
  assert.equal(canvasCornerDockReserve({ top: 0, bottom: 720 }, { top: 360 }), 376)
  assert.equal(canvasCornerDockReserve({ top: 0, bottom: 720 }, { top: 720 }), 16)
  assert.equal(canvasCornerDockReserve({ top: 0, bottom: 720 }, { top: 900 }), 0)
  assert.equal(canvasCornerDockReserve({ top: Number.NaN, bottom: 720 }, { top: 360 }), 0)
})

test('карта поднимается над доком только при пересечении его левого края', () => {
  const column = { left: 14, right: 238 }
  // Высокое окно со скриншота: узкая боковая колонка почти помещается.
  assert.equal(canvasCornerDockIntersects(column, { left: 229, right: 1029 }), true)
  assert.equal(canvasCornerDockIntersects(column, { left: 270, right: 1070 }), false)
  assert.equal(canvasCornerDockIntersects(column, { left: 254, right: 1054 }), false)
  assert.equal(canvasCornerDockIntersects(column, { left: 253, right: 1053 }), true)
  assert.equal(canvasCornerDockIntersects(column, { left: -800, right: -16 }), false)
  assert.equal(canvasCornerDockIntersects(column, { left: Number.NaN, right: 1053 }), false)
})
