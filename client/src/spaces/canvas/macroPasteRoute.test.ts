import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CanvasPasteArbiter } from './konva/pasteArbiter'
import { decidePaste, OWN_CLIPBOARD_TYPE } from './konva/pasteDecision'
import { isMacroText } from './libraryFile'
import { macroClipboardText } from './macroFileActions'
import { LOCAL_MODELS, node } from './macroFileTestKit'
import { MACRO_PASTE_HINT, macroRowHovered, registerMacroRow, routeMacroPaste } from './macroPasteRoute'

// Чей ход по Ctrl+V, когда в буфере макрос: ряда кнопок макросов или холста.

const here = import.meta.dirname
const source = (file: string) => fs.readFileSync(path.join(here, file), 'utf8').replaceAll('\r\n', '\n')

const macroText = macroClipboardText(
  { name: 'Портрет', graph: { nodes: [node('n', 'note', { prompt: 'кот' })], edges: [] } }, 'local', LOCAL_MODELS,
)

test('ряд макросов сообщает холсту, что курсор над ним', () => {
  assert.equal(macroRowHovered(), false, 'ряда на экране нет')
  let hovered = false
  const unregister = registerMacroRow(() => hovered)
  assert.equal(macroRowHovered(), false)
  hovered = true
  assert.equal(macroRowHovered(), true)
  unregister()
  assert.equal(macroRowHovered(), false, 'ряд ушёл с экрана')
})

// ⚠️ Раньше холст, увидев макрос в буфере, выходил ДО решения «что вставлять»:
// своя копия объектов, не доехавшая до системного буфера, не вставлялась вовсе,
// а Ctrl+V над холстом не давал ни макроса, ни слова о том, куда вести курсор.
test('макрос из буфера текстом на холст не ложится, а своя свежая копия объектов вставляется', () => {
  const own = JSON.stringify({ type: OWN_CLIPBOARD_TYPE, items: [{ id: 'a' }] })
  const route = (clipboardText: string, state: Partial<Parameters<typeof decidePaste>[0]> = {}, overMacroRow = false) => {
    // Решение холста — настоящее: то же, что он принял бы для любого текста в буфере.
    const choice = decidePaste({
      hasMediaFiles: false, focusInInput: false, clipboardText, hasInternalItems: false, mirrorFailed: false, ...state,
    })
    return [choice, routeMacroPaste({ macroInClipboard: isMacroText(clipboardText), choice, overMacroRow })]
  }
  // Холст положил бы текст — вместо этого подсказка; над рядом вставит ряд.
  assert.deepEqual(route(macroText), ['text', 'hint'])
  assert.deepEqual(route(macroText, { hasInternalItems: true }), ['text', 'hint'], 'давняя копия объектов свежему макросу не помеха')
  assert.deepEqual(route(macroText, {}, true), ['text', 'row'])
  // Своя копия объектов до буфера не доехала: в нём остался макрос, а свежее — она.
  assert.deepEqual(route(macroText, { hasInternalItems: true, mirrorFailed: true }), ['internal', 'objects'])
  // …но над рядом макросов вставляется макрос: его могли скопировать уже после неё.
  assert.deepEqual(route(macroText, { hasInternalItems: true, mirrorFailed: true }, true), ['internal', 'row'])
  // Поле ввода и файлы из буфера — как всегда: макрос тут ни при чём.
  assert.deepEqual(route(macroText, { focusInInput: true }, true), ['input', 'canvas'])
  assert.deepEqual(route(macroText, { hasMediaFiles: true }), ['media', 'canvas'])
  // В буфере не макрос — холст работает как работал, где бы ни стоял курсор.
  assert.deepEqual(route('заметка', {}, true), ['text', 'canvas'])
  assert.deepEqual(route(own, { hasInternalItems: true }, true), ['internal', 'canvas'])
  assert.deepEqual(route('', {}, true), ['none', 'canvas'])
  assert.match(MACRO_PASTE_HINT, /macro row in the prompt panel.*Ctrl\+V/, 'подсказка говорит, куда вести курсор')
})

test('холст спрашивает, чей ход, после своего решения и до того, как положить текст', () => {
  const canvas = source('konva/KonvaCanvas.tsx')
  const decide = canvas.indexOf('decidePaste({')
  const route = canvas.indexOf('routeMacroPaste({')
  const placeText = canvas.indexOf("if (choice === 'text')")
  assert.ok(decide > 0 && route > decide, 'сначала решение холста, потом — чей ход')
  assert.ok(placeText > route, 'и только потом текст кладётся на доску')
  const block = canvas.slice(route, placeText)
  assert.match(block, /macroInClipboard: isMacroText\(text\)/)
  assert.match(block, /overMacroRow: macroRowHovered\(\)/)
  assert.match(block, /if \(macroRoute !== 'canvas'\) \{/)
  assert.match(block, /macroRoute === 'objects' && canvasPasteArbiter\.settle\(false\)/, 'своя копия объектов вставляется')
  assert.match(block, /if \(macroRoute !== 'row'\) \{\s*notify\(\{ kind: 'info', message: t\(MACRO_PASTE_HINT\)/, 'молчать нельзя')
  // Прежний ранний выход возвращать нельзя: он стоял до решения и отменял вставку своей копии.
  assert.ok(!canvas.slice(0, decide).includes('isMacroText('), 'макрос не разбирается до решения холста')

  // ⚠️ Четыре строки, которых сверки выше не видели (проверка 03.10.2026): на
  // копии их убирали по одной — прогон оставался зелёным. Что каждая значит
  // для человека, показывает следующий тест; здесь — что они стоят на месте.
  const branch = macroBranch(canvas)
  // своя копия объектов: вставили — и вышли, подсказки поверх неё нет
  assert.match(branch, /macroRoute === 'objects' && canvasPasteArbiter\.settle\(false\)\) \{\s*e\.preventDefault\(\)\s*e\.stopPropagation\(\)\s*return\s*\}/)
  // ход ряда и подсказка: запланированная вставка давних объектов отменяется…
  const tail = branch.slice(branch.indexOf('canvasPasteArbiter.cancel()'))
  assert.ok(tail.startsWith('canvasPasteArbiter.cancel()'), 'запланированная вставка объектов отменяется')
  // …событие не гасится: ряд слушает окно на всплытии, холст — на погружении…
  assert.doesNotMatch(tail, /stopPropagation|preventDefault/, 'погашенное событие до ряда не дойдёт')
  // …и обязательно выход: без него JSON макроса ляжет на доску текстом.
  assert.match(tail, /if \(macroRoute !== 'row'\) \{\s*notify\([^\n]+\)\s*\}\s*return\s*\}\s*$/)
})

/** Развилка макроса в обработчике вставки холста — от решения «чей ход» до первой обычной ветки. */
function macroBranch(canvas: string): string {
  const start = canvas.indexOf('const macroRoute = routeMacroPaste({')
  const end = canvas.indexOf("if (choice === 'media')", start)
  assert.ok(start > 0 && end > start, 'развилка макроса стоит перед обычными ветками вставки')
  return canvas.slice(start, end)
}

const PASSED_ON = Symbol('холст пошёл дальше, в обычные ветки вставки')

/**
 * Развилка макроса из НАСТОЯЩЕГО текста холста, исполненная с подставным миром.
 * Konva в Node не грузится, поэтому берём сам кусок обработчика (в нём обычный
 * JavaScript) и подаём ему всё, чего он касается, поимённо. Решения — настоящие:
 * decidePaste, routeMacroPaste, isMacroText и CanvasPasteArbiter.
 *
 * ⚠️ Появилось в развилке новое имя — объяви его и здесь: прогон упадёт на
 * «is not defined», а не по делу.
 */
function canvasPaste(state: { text: string; overMacroRow?: boolean; ownCopy?: 'old' | 'fresh' }) {
  const log: string[] = []
  const clock: { fire: (() => void) | null } = { fire: null }
  const arbiter = new CanvasPasteArbiter({ set: (callback) => { clock.fire = callback; return 1 }, clear: () => { clock.fire = null } })
  // Ctrl+V на холсте: клавиши планируют вставку внутреннего буфера, если он не пуст (useCanvasHotkeys).
  if (state.ownCopy) arbiter.schedule(() => { log.push('объекты из внутреннего буфера') })
  const event = {
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
  }
  const choice = decidePaste({
    hasMediaFiles: false,
    focusInInput: false,
    clipboardText: state.text,
    hasInternalItems: Boolean(state.ownCopy),
    // «fresh» — своя копия до системного буфера не доехала: там остался макрос, а свежее — она.
    mirrorFailed: state.ownCopy === 'fresh',
  })
  const world = {
    routeMacroPaste,
    isMacroText,
    macroRowHovered: () => Boolean(state.overMacroRow),
    canvasPasteArbiter: arbiter,
    notify: (toast: { message: string }) => { log.push(toast.message === MACRO_PASTE_HINT ? 'подсказка' : toast.message) },
    MACRO_PASTE_HINT,
    t: (message: string) => message,
    text: state.text,
    choice,
    e: event,
    PASSED_ON,
  }
  const run = new Function(...Object.keys(world), `${macroBranch(source('konva/KonvaCanvas.tsx'))}\nreturn PASSED_ON`)
  const handled = run(...Object.values(world)) !== PASSED_ON
  // Прошло 50 мс: срабатывает запасной таймер — если запланированную вставку никто не отменил.
  clock.fire?.()
  return { log, handled, prevented: event.prevented, stopped: event.stopped }
}

// ⚠️ Сама правка — «макрос из буфера текстом на доску не ложится» — держалась на
// одной чистой функции, а что холст с её ответом ДЕЛАЕТ, не проверял никто. На
// копии убирали выход из развилки — и JSON макроса снова клался на доску
// текстом; убирали отмену — и над рядом вместе с макросом вставали давние
// объекты; гасили событие — и Ctrl+V над рядом молчал. Прогон был зелёным.
test('холст с макросом в буфере: подсказка, ход ряда или своя копия объектов — и на этом всё', () => {
  // Курсор над холстом: подсказка — и ничего больше, даже если есть давняя копия объектов.
  assert.deepEqual(canvasPaste({ text: macroText }), { log: ['подсказка'], handled: true, prevented: false, stopped: false })
  assert.deepEqual(
    canvasPaste({ text: macroText, ownCopy: 'old' }),
    { log: ['подсказка'], handled: true, prevented: false, stopped: false },
    'давние объекты вместе с подсказкой не вставляются',
  )
  // Курсор над рядом макросов: холст молчит, а событие доходит до ряда целым.
  for (const ownCopy of [undefined, 'old', 'fresh'] as const) {
    assert.deepEqual(
      canvasPaste({ text: macroText, overMacroRow: true, ownCopy }),
      { log: [], handled: true, prevented: false, stopped: false },
      `над рядом вставляет ряд (своя копия объектов: ${ownCopy ?? 'нет'})`,
    )
  }
  // Своя копия объектов свежее макроса, оставшегося в буфере: вставляется она — один раз и без подсказки.
  assert.deepEqual(
    canvasPaste({ text: macroText, ownCopy: 'fresh' }),
    { log: ['объекты из внутреннего буфера'], handled: true, prevented: true, stopped: true },
  )
  // В буфере не макрос — развилка не вмешивается, где бы ни стоял курсор.
  for (const overMacroRow of [false, true]) {
    assert.deepEqual(canvasPaste({ text: 'заметка', overMacroRow }), { log: [], handled: false, prevented: false, stopped: false })
  }
})
