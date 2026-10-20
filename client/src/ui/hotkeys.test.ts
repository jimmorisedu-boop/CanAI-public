import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { HOTKEYS, HOTKEY_GROUPS, formatHotkeyKeys, hits, hotkey, hotkeysOfGroup } from './hotkeys'

const ev = (over: Partial<Parameters<typeof hits>[1]> = {}) => ({
  key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over,
})

test('каждая запись реестра заполнена и уникальна', () => {
  const ids = new Set<string>()
  for (const item of HOTKEYS) {
    assert.ok(item.keys.trim(), `${item.id}: пустое описание клавиш`)
    assert.ok(item.what.trim(), `${item.id}: пустое описание действия`)
    assert.ok(!ids.has(item.id), `дубль id: ${item.id}`)
    ids.add(item.id)
    assert.ok(
      HOTKEY_GROUPS.some((group) => group.id === item.group),
      `${item.id}: группа «${item.group}» не объявлена`,
    )
  }
})

test('справка показывает ВСЕ записи — ни одна не может потеряться молча', () => {
  const shown = HOTKEY_GROUPS.flatMap((group) => hotkeysOfGroup(group.id))
  assert.equal(shown.length, HOTKEYS.length)
})

test('Delete и Shift+Delete не путаются между собой', () => {
  assert.ok(hits('canvas.delete', ev({ key: 'Delete' })))
  assert.ok(!hits('canvas.archive', ev({ key: 'Delete' })))
  assert.ok(hits('canvas.archive', ev({ key: 'Delete', shiftKey: true })))
  assert.ok(!hits('canvas.delete', ev({ key: 'Delete', shiftKey: true })))
})

test('отмена и повтор различаются по Shift, Ctrl+Y тоже повтор', () => {
  assert.ok(hits('canvas.undo', ev({ code: 'KeyZ', ctrlKey: true })))
  assert.ok(!hits('canvas.redo', ev({ code: 'KeyZ', ctrlKey: true })))
  assert.ok(hits('canvas.redo', ev({ code: 'KeyZ', ctrlKey: true, shiftKey: true })))
  assert.ok(!hits('canvas.undo', ev({ code: 'KeyZ', ctrlKey: true, shiftKey: true })))
  assert.ok(hits('canvas.redo', ev({ code: 'KeyY', ctrlKey: true })))
})

test('русская раскладка ловится наравне с латиницей', () => {
  for (const [id, latin, cyrillic] of [
    ['canvas.copy', 'c', 'с'],
    ['canvas.paste', 'v', 'м'],
    ['canvas.cut', 'x', 'ч'],
    ['canvas.duplicate', 'd', 'в'],
    ['canvas.selectAll', 'a', 'ф'],
    ['nodes.save', 's', 'ы'],
  ] as const) {
    assert.ok(hits(id, ev({ key: latin, ctrlKey: true })), `${id}: латиница`)
    assert.ok(hits(id, ev({ key: cyrillic, ctrlKey: true })), `${id}: кириллица`)
  }
})

test('zoomToFit ловится и по символу восклицания, и по Digit1', () => {
  assert.ok(hits('canvas.zoomToFit', ev({ key: '!', shiftKey: true })))
  assert.ok(hits('canvas.zoomToFit', ev({ code: 'Digit1', shiftKey: true })))
  assert.ok(!hits('canvas.zoomToFit', ev({ code: 'Digit1', shiftKey: false })))
  assert.ok(!hits('canvas.zoomToFit', ev({ code: 'Digit1', shiftKey: true, ctrlKey: true })))
})

test('formatHotkeyKeys заменяет Ctrl и Alt на символы Mac на macOS', () => {
  assert.equal(formatHotkeyKeys('Ctrl+C', false), 'Ctrl+C')
  assert.equal(formatHotkeyKeys('Ctrl+C', true), '⌘C')
  assert.equal(formatHotkeyKeys('Ctrl+Shift+Z / Ctrl+Y', true), '⌘Shift+Z / ⌘Y')
  assert.equal(formatHotkeyKeys('Alt+Enter', true), '⌥Enter')
})

test('обращение к необъявленному хоткею падает сразу, а не молчит', () => {
  assert.throws(() => hotkey('canvas.нетТакого'), /not defined/)
})

// Страж: обработчик, распознающий клавишу мимо реестра, снова разведёт
// поведение и справку — именно так из справки выпали Ctrl+X и Ctrl+S (F-20).
test('обработчики хоткеев не распознают клавиши в обход реестра', () => {
  const files = [
    'spaces/canvas/konva/useCanvasHotkeys.ts',
    'ShortcutsModal.tsx',
  ]
  const root = path.resolve(import.meta.dirname, '..')
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const offenders = source
      .split('\n')
      .map((line, index) => [line, index + 1] as const)
      .filter(([line]) => !line.trimStart().startsWith('//'))
      // сравнение с буквой в кавычках = самодельный разбор клавиши
      .filter(([line]) => /e\.key === '[a-zа-яё]'/i.test(line) || /key === '[a-zа-яё]'/i.test(line))
      .map(([, index]) => `${file}:${index}`)
    assert.deepEqual(
      offenders.filter((place) => !place.startsWith('spaces/canvas/konva/useCanvasHotkeys.ts:8')),
      [],
      'распознавайте клавиши через hits() из ui/hotkeys',
    )
  }
})
