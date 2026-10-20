import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const text = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('PromptBar.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const macros: ts.JsxSelfClosingElement[] = []
function visit(node: ts.Node): void {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'PromptMacros') macros.push(node)
  ts.forEachChild(node, visit)
}
visit(source)

function within(node: ts.Node, tag: string, className?: string): ts.JsxElement | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isJsxElement(parent) || parent.openingElement.tagName.getText(source) !== tag) continue
    if (!className || parent.openingElement.attributes.properties.some((attribute) => (
      ts.isJsxAttribute(attribute)
      && attribute.name.getText(source) === 'className'
      && attribute.initializer
      && ts.isStringLiteral(attribute.initializer)
      && attribute.initializer.text === className
    ))) return parent
  }
}

function guard(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxExpression(parent) && parent.expression) {
      const expression = parent.expression
      assert.ok(ts.isBinaryExpression(expression))
      assert.equal(expression.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken)
      return expression.left.getText(source)
    }
  }
  throw new Error('Macro shelf must be conditionally rendered')
}

test('desktop macros stay beside Create, not in a separate Scripts shelf', () => {
  assert.equal(macros.length, 2, 'one wide and one compact location')
  const wide = macros.find((node) => within(node, 'div', 'prompt-actions-right'))
  assert.ok(wide)
  assert.equal(guard(wide), "mode === 'make' && !compact")
  const actions = within(wide, 'div', 'prompt-actions-right')!
  assert.ok(wide.pos < text.indexOf('className="generate paid-action"', actions.pos))
  assert.equal(within(wide, 'ActionDockLibrary'), undefined)
  assert.doesNotMatch(text, /ActionDockLibrary|label="Скрипты"/u)
})

test('compact macros stay in the Make settings disclosure without duplicating the wide shelf', () => {
  const compact = macros.find((node) => within(node, 'PromptSettingsSection'))
  assert.ok(compact)
  assert.equal(guard(compact), 'compact')
  assert.equal(guard(within(compact, 'PromptSettingsSection')!), "mode === 'make'")
  assert.equal(within(compact, 'div', 'prompt-actions-right'), undefined)
})

test('both macro locations keep local/cloud routing and generation admission unchanged', () => {
  for (const node of macros) {
    const props = node.getText(source)
    assert.match(props, /projectSource=\{projectSource\}/)
    assert.match(props, /projectId=\{projectId\}/)
    assert.match(props, /generationAvailable=\{generationReady\}/)
    assert.match(props, /confirmCostAboveUsd=\{confirmCostAboveUsd\}/)
  }
})
