// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readFileSync } from 'node:fs'

/**
 * ⚠️ Маленькие панели, висящие НАД ХОЛСТОМ, обязаны выглядеть одинаково — и
 * это не про красоту, а про видимость. У плиток полки ассетов и архива стояла
 * плоская полупрозрачная заливка без размытия, и на холсте их было попросту не
 * видно (жалоба 08.09.2026: «ассеты и архив стали полностью прозрачные,
 * поэтому их не видно»). Замер контраста к фону холста тёмной темы (#0c0e13):
 * пунктир пустого слота 1.28:1, заливка занятого 1.12:1 — границе интерфейса
 * нужно 3:1. Зум-бар в том же углу читался, потому что он стеклянный.
 * Образцом держим его: заведётся четвёртый вид — тест назовёт виновника.
 */
const block = (css: string, selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  assert.ok(start >= 0, `в стилях нет правила ${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

const canvasUi = readFileSync(new URL('../styles/canvas-ui.css', import.meta.url), 'utf8')
const archive = readFileSync(new URL('../styles/archive.css', import.meta.url), 'utf8')

const zoomBar = block(canvasUi, '.zoom-bar')
const glass = zoomBar.match(/backdrop-filter:\s*([^;]+);/)?.[1]

test('плитки холста берут материал зум-бара, а не свой', () => {
  assert.ok(glass, 'у зум-бара должно быть стекло — он образец материала')
  assert.match(zoomBar, /background:\s*var\(--material-regular\)/)

  for (const selector of ['.asset-slot', '.archive-tile']) {
    const rule = block(archive, selector)
    assert.match(rule, /background:\s*var\(--material-regular\)/, `${selector}: тот же фон`)
    assert.ok(rule.includes(`backdrop-filter: ${glass}`), `${selector}: то же размытие`)
    // Прозрачная плитка неотличима от холста: рамка и тень — это и есть то,
    // чем она от него отделяется.
    assert.match(rule, /border:\s*1px solid var\(--border-strong\)/, `${selector}: заметная рамка`)
    assert.match(rule, /box-shadow:\s*var\(--shadow-md\)/, `${selector}: тень`)
  }
})

test('пустая плитка отличается пунктиром, а не исчезновением', () => {
  for (const selector of ['.asset-slot.empty', '.archive-tile.empty']) {
    const rule = block(archive, selector)
    assert.match(rule, /border-style:\s*dashed/, `${selector}: пунктир остаётся признаком пустоты`)
    assert.doesNotMatch(rule, /background:\s*transparent/, `${selector}: заливку не снимаем`)
    assert.doesNotMatch(rule, /box-shadow:\s*none/, `${selector}: тень не снимаем`)
  }
})
