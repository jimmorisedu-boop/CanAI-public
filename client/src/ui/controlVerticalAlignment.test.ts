// @ts-expect-error Client production build does not depend on Node typings.
import assert from 'node:assert/strict'
// @ts-expect-error Client production build does not depend on Node typings.
import { readFileSync } from 'node:fs'
// @ts-expect-error Client production build does not depend on Node typings.
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.trim())
    if (selectors.includes(selector)) return match[2]
  }
  return ''
}

const surfaces = [
  ['../styles/topbar.css', '.tab'],
  ['../styles/settings.css', '.settings-modal select'],
  ['../styles/settings.css', '.settings-actions .generate'],
  ['../styles/nodes-space.css', '.node-add-btn'],
  ['../styles/node-details.css', '.node-input-source-select'],
  ['../styles/node-details.css', '.brand-back'],
  ['../styles/node-details.css', '.top-project-name'],
  ['../styles/node-details.css', '.top-project-name-input'],
  ['../styles/diagnostics.css', 'button.top-project-name'],
  ['../styles/archive.css', '.archive-sort'],
  ['../styles/task-center.css', '.task-center-actions button'],
  ['../styles/notices.css', '.operation-state-actions button'],
  ['../styles/price-params.css', '.inline-notice-actions button'],
  ['../styles/assistant.css', '.pane-tabs button'],
  ['../styles/gallery.css', '.gallery-new'],
  ['../styles/compact.css', '.prompt-settings-trigger'],
  ['../styles/topbar.css', '.share-topbar-button'],
] as const

// ⚠️ Высоту теперь может задавать КАНОН (controls.css), а не каждое место
// своим правилом: с 21.08.2026 общий вид кнопок описан один раз, и требовать
// объявление в каждом файле — значит требовать обратно тот самый разнобой.
// Смысл проверки прежний: у элемента есть семантическая высота — своя или
// из канона.
const CANON = read('../styles/controls.css')
const SEMANTIC_HEIGHT = /(?:height|min-height):\s*var\(--control-h-(?:mini|compact|standard|emphasis|sm|md)\)/

function heightFromCanon(selector: string): boolean {
  return CANON.split('}').some((block) => block.includes(selector) && SEMANTIC_HEIGHT.test(block))
}

test('every product surface keeps its representative control vertically centered', () => {
  for (const [file, selector] of surfaces) {
    const rule = ruleBody(read(file), selector)
    // Правила может не быть вовсе: место могло целиком перейти на канон —
    // тогда своей геометрии у него не осталось, и это правильный итог.
    if (!rule) {
      assert.ok(heightFromCanon(selector), `${selector} не описан ни на месте, ни в каноне`)
      continue
    }
    assert.ok(
      SEMANTIC_HEIGHT.test(rule) || heightFromCanon(selector),
      `${selector} must use a semantic control height`,
    )
    assert.doesNotMatch(
      rule,
      /padding:\s*(?!0(?:\s|;))\d+px\s+[^;]*\d+px/,
      `${selector} must not grow through vertical padding`,
    )
  }
})
