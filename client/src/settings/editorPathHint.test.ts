import assert from 'node:assert/strict'
import test from 'node:test'
import { editorPathHint } from './editorPathHint.js'

// ⚠️ Подсказка была одна на все системы и виндовая. На маке она называла путь,
// которого там не бывает, и молчала о главном: указывать надо бандл «.app», а
// не файл внутри него.

test('на macOS подсказка называет бандл, а не файл внутри него', () => {
  const hint = editorPathHint('darwin')
  assert.match(hint.placeholder, /\.app$/)
  assert.doesNotMatch(hint.placeholder, /Contents\/MacOS/, 'внутренности вручную указывать не надо')
  assert.match(hint.note ?? '', /\.app/)
  assert.equal(hint.browse, 'Choose app', 'диалог выбора на маке есть')
})

test('на Windows всё как было', () => {
  const hint = editorPathHint('win32')
  assert.match(hint.placeholder, /^C:\\/)
  assert.equal(hint.browse, 'Choose app')
})

// Старый сервер поля не присылает — нельзя, чтобы интерфейс из-за этого поехал.
test('без ответа о системе ведём себя как раньше', () => {
  assert.deepEqual(editorPathHint(undefined), editorPathHint('win32'))
})

test('там, где диалога нет, кнопку не обещаем', () => {
  const hint = editorPathHint('linux')
  assert.equal(hint.browse, null)
  assert.match(hint.note ?? '', /full path/)
})
