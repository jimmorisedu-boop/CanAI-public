import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('кнопка добавления макроса находится в нижней панели после списка', () => {
  const source = readFileSync(new URL('./MacroLibrary.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('MacroLibrary.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let button: ts.JsxElement | undefined

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'button') {
      const className = node.openingElement.attributes.properties.find(
        (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(file) === 'className',
      )
      if (className?.initializer && ts.isStringLiteral(className.initializer) && className.initializer.text === 'macro-lib-add') {
        button = node
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  if (!button) throw new Error('кнопка добавления должна существовать')
  const parent = button.parent
  if (!ts.isJsxElement(parent)) throw new Error('кнопка должна находиться в отдельной нижней панели')
  assert.equal(parent.openingElement.tagName.getText(file), 'footer')
  assert.match(parent.openingElement.getText(file), /macro-lib-footer/)
})

// Окно разложено на части (окно, строка, действия) — проверяем, что локальная
// сборка не тащит команды публикации и сохраняет весь рабочий путь библиотеки.
const LIBRARY_PARTS = [
  './MacroLibrary.tsx', './MacroLibraryRow.tsx', './MacroLibraryLegacy.tsx',
  './useMacroLibraryActions.ts', './useMacroLibraryData.ts', './macroFileActions.ts',
]

test('локальная библиотека не содержит команд публикации и сохраняет рабочие действия', () => {
  const source = LIBRARY_PARTS.map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n')
  assert.doesNotMatch(source, /publishMacro|reviewMacroSubmission|listMacroSubmissions|submitMacro/u)
  assert.match(source, /saveMacro/u)
  assert.match(source, /duplicate|onDuplicate/u)
  assert.match(source, /exportMacroToFile/u)
})

test('строка локального макроса сохраняет действия открытия, копии, файла и удаления', () => {
  const source = readFileSync(new URL('./MacroLibraryRow.tsx', import.meta.url), 'utf8')
  for (const action of ['onOpen', 'onDuplicate', 'onExport', 'onRemove']) assert.match(source, new RegExp(action))
  assert.match(source, /macro-lib-act/u)
  assert.doesNotMatch(source, /submit|publish/u)
  const css = readFileSync(new URL('../../styles/macro-library.css', import.meta.url), 'utf8')
  assert.match(css, /\.macro-lib-act/u)
})

test('заголовок обычного раздела не красный: тревожный тон только у предупреждений', () => {
  const css = readFileSync(new URL('../../styles/macro-library.css', import.meta.url), 'utf8')
  const base = /\.macro-lib-section \{([^}]*)\}/u.exec(css)?.[1] ?? ''
  assert.doesNotMatch(base, /--danger/u)
  assert.match(/\.macro-lib-section\.warn \{([^}]*)\}/u.exec(css)?.[1] ?? '', /--danger/u)
})
