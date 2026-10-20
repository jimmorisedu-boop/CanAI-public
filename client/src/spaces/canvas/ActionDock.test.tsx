import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { ActionDockBatchSwitch, actionDockCreateLabel } from './ActionDock'

test('each mode names the operation and counts the real batch, including variants', () => {
  assert.equal(actionDockCreateLabel('image', 'each', 6), 'Edit 6 images')
  assert.equal(actionDockCreateLabel('image', 'each', 2), 'Edit 2 images')
  assert.equal(actionDockCreateLabel('image', 'each', 21), 'Edit 21 images')
  const html = renderToStaticMarkup(<ActionDockBatchSwitch mode="each" onChange={() => {}} imageCount={6} jobs={12} />)
  assert.match(html, /6 sources/)
  assert.match(html, /12 new images/)
  assert.match(html, /data-input-count="6" data-result-count="12"/)
  assert.match(html, /aria-pressed="true"[^>]*>.*Change each/su)
  assert.doesNotMatch(html, /<p>|price by usage|One instruction|Images are not mixed/u)
})

test('combined mode says references and one new image, not six edited sources', () => {
  assert.equal(actionDockCreateLabel('image', 'together', 6), 'Generate')
  const html = renderToStaticMarkup(<ActionDockBatchSwitch mode="together" onChange={() => {}} imageCount={6} jobs={1} />)
  assert.match(html, /6 references/)
  assert.match(html, /1 new image/)
  assert.match(html, /aria-pressed="true"[^>]*>.*As references/su)
})

test('single images and non-image tasks keep the ordinary create action', () => {
  for (const count of [0, 1]) {
    assert.equal(actionDockCreateLabel('image', 'each', count), 'Generate')
    assert.equal(renderToStaticMarkup(<ActionDockBatchSwitch mode="each" onChange={() => {}} imageCount={count} jobs={1} />), '')
  }
  assert.equal(actionDockCreateLabel('video', 'each', 6), 'Generate')
  assert.equal(actionDockCreateLabel('audio', 'each', 6), 'Generate')
})

test('both batch buttons respect disabled admission', () => {
  const html = renderToStaticMarkup(<ActionDockBatchSwitch mode="each" onChange={() => {}} imageCount={6} jobs={6} disabled />)
  assert.equal((html.match(/disabled=""/gu) ?? []).length, 2)
})

test('PromptBar.tsx: exactly one AssistantPresets in discuss mode; no obsolete preparation UI', () => {
  const file = './PromptBar.tsx'
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.doesNotMatch(text, /useAssistantPromptPreparation|CanvasActionPreparationReview|action-dock-prepare-button|цена по расходу/u)
  assert.match(text, /actionDockCreateLabel\(kind, batchMode,/u)
  assert.match(text, /paid-action-label[^>]*>\{createLabel\}/u)

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const pickers: ts.JsxSelfClosingElement[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'AssistantPresets') pickers.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(pickers.length, 1, 'expected exactly one AssistantPresets on desktop')

  let inDiscussMode = false
  for (let node: ts.Node | undefined = pickers[0]; node; node = node.parent) {
    if (ts.isBinaryExpression(node) && node.getText(source).includes("mode === 'discuss'")) inDiscussMode = true
  }
  assert.ok(inDiscussMode, 'AssistantPresets must be in discuss mode')
})

test('PromptBar.tsx: header batch toggle includes together and each options and defaults to together', () => {
  const file = './PromptBar.tsx'
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.match(text, /useState<ActionBatchMode>\('together'\)/u)
  assert.match(text, /prompt-header-batch-toggle/u)
  assert.match(text, /title="Use references together for one prompt"/u)
  assert.match(text, /title=\{kind === 'image' \? "Use each reference separately"/u)
})


test('TabletPrompt.tsx: single state hook, compact select only in Make above tablet-refs; no obsolete preparation UI', () => {
  const file = '../../tablet/TabletPrompt.tsx'
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.doesNotMatch(text, /useAssistantPromptPreparation|CanvasActionPreparationReview|action-dock-prepare-button|цена по расходу/u)
  assert.match(text, /actionDockCreateLabel\(kind, batchMode,/u)
  assert.match(text, /paid-action-label[^>]*>\{createLabel\}/u)

  const hookMatches = text.match(/useTabletAssistantSelection\(/gu) ?? []
  assert.equal(hookMatches.length, 1, 'TabletPrompt must use exactly one useTabletAssistantSelection hook')

  const selectIndex = text.indexOf('tablet-assistant-select')
  const refsIndex = text.indexOf('className="tablet-refs"')
  assert.ok(selectIndex > 0, 'tablet-assistant-select must be present')
  assert.ok(refsIndex > 0, 'tablet-refs must be present')
  assert.ok(selectIndex < refsIndex, 'tablet-assistant-select must precede tablet-refs')
  assert.match(text, /tab === 'prompt'[\s\S]*?tablet-assistant-select/u)
})

test('tablet batch decision follows the instruction and precedes the paid action', () => {
  const text = readFileSync(new URL('../../tablet/TabletPrompt.tsx', import.meta.url), 'utf8')
  assert.equal((text.match(/<ActionDockBatchSwitch/gu) ?? []).length, 1)
  assert.ok(text.indexOf('<textarea') < text.indexOf('<ActionDockBatchSwitch'))
  assert.ok(text.indexOf('<ActionDockBatchSwitch') < text.indexOf('aria-label={tabletActionText(createLabel'))
  assert.match(text, /disabled=\{readOnly \|\| !ready\}/u)
})

test('desktop and tablet ship the same batch control styling', () => {
  const desktop = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
  const tablet = readFileSync(new URL('../../tablet/main.tsx', import.meta.url), 'utf8')
  assert.match(desktop, /styles\/action-dock-batch\.css/u)
  assert.match(tablet, /styles\/action-dock-batch\.css/u)
  const styles = readFileSync(new URL('../../styles/action-dock-batch.css', import.meta.url), 'utf8')
  assert.match(styles, /\.action-dock-batch-switch button:focus-visible/u)
  assert.match(styles, /min-height: 44px/u)
  assert.match(styles, /white-space: nowrap/u)
  const tabletStyles = readFileSync(new URL('../../tablet/tabletPrompt.css', import.meta.url), 'utf8')
  assert.match(tabletStyles, /\.tablet-prompt \.action-dock-batch-switch button\s*\{\s*min-height: max\(44px, var\(--tablet-tap\)\)/u)
  assert.doesNotMatch(tabletStyles, /\.tablet-prompt \.action-dock-mode-tabs\s*\{\s*width: min\(150px/u)
})

// Жалоба 19.10.2026 «буквы в кнопках не выровнены относительно иконок»:
// подъём подписи на пиксель (08.09.2026, по расчёту) ставил центр заглавной
// на 0,8 px выше иконки у «Generate» и «Send» — замер по пикселям снимка.
test('подпись и цена платной кнопки стоят по своим коробкам, без отдельного подъёма', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../../styles/price-params.css', import.meta.url), 'utf8')
  const rule = (selector: string) => css.slice(css.indexOf(selector + ' {'), css.indexOf('}', css.indexOf(selector + ' {')))
  assert.doesNotMatch(rule('.paid-action-label'), /transform/)
  assert.doesNotMatch(rule('.paid-action .price-badge.is-action'), /transform/)
})
