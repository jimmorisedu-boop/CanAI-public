import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

// Browser media chrome follows the browser's language even in an English
// document. Guard the app boundary; controls={false} is safe, omission defaults
// to false, and CanAI's own controls provide localized-independent labels.
test('application media never enables browser-localized native controls', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const violations: string[] = []
  function walk(folder: string): void {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      if (!file.endsWith('.tsx') || /\.(test|spec)\./u.test(file)) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function visit(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(source)
          if (tag === 'video' || tag === 'audio') {
            for (const prop of node.attributes.properties) {
              if (!ts.isJsxAttribute(prop) || prop.name.getText(source) !== 'controls') continue
              const initializer = prop.initializer
              const disabled = initializer && ts.isJsxExpression(initializer)
                && initializer.expression?.kind === ts.SyntaxKind.FalseKeyword
              if (!disabled) {
                const line = source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1
                violations.push(`${path.relative(root, file)}:${line}`)
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  walk(root)
  assert.deepEqual(violations, [], `Use English playback controls instead of native browser chrome:\n${violations.join('\n')}`)
})
