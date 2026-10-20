import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { isMacroText } from './libraryFile'
import { INPUT, bench, graph, macro, type FakeKey } from './macroClipboardTestKit'
import { macroClipboardText } from './macroFileActions'
import { LOCAL_MODELS, node } from './macroFileTestKit'
import { macroUnderCursor, pastedMacroName, typingInField } from './useMacroClipboard'

// Ctrl+C макроса над рядом кнопок и то, из чего хук собран.
//
// ⚠️ Пока обработчики жили внутри хука, проверить их было нечем: на копии снимали
// замок двойной вставки, проверку «курсор над рядом» и слова об отказе буфера —
// прогон оставался зелёным (проверка 02.10.2026). Здесь они гоняются подставными
// событиями (стенд — macroClipboardTestKit.ts). Ctrl+V — в
// useMacroClipboardPaste.test.ts; что с тем же Ctrl+V делает холст — в
// macroPasteRoute.test.ts.

const here = import.meta.dirname
const source = (file: string) => fs.readFileSync(path.join(here, file), 'utf8').replaceAll('\r\n', '\n')

const macroText = macroClipboardText({ name: 'Портрет', graph }, 'local', LOCAL_MODELS)

test('вставленный макрос получает “(copy)”, только когда такое имя здесь уже есть', () => {
  assert.equal(pastedMacroName('Портрет', new Set(['Портрет'])), 'Портрет (copy)')
  // принесён с другой доски — копией ничего не является
  assert.equal(pastedMacroName('Портрет', new Set(['Пейзаж'])), 'Портрет')
  // вторая и третья копии различимы
  assert.equal(pastedMacroName('Портрет', new Set(['Портрет', 'Портрет (copy)'])), 'Портрет (copy 2)')
  assert.equal(pastedMacroName('Портрет', new Set(['Портрет', 'Портрет (copy)', 'Портрет (copy 2)'])), 'Портрет (copy 3)')
  // имя на пределе сервера (100 знаков) не вылезает за него и остаётся узнаваемым
  const long = 'я'.repeat(100)
  const copy = pastedMacroName(long, new Set([long]))
  assert.equal(Array.from(copy).length, 100)
  assert.ok(copy.endsWith(' (copy)'))
  const second = pastedMacroName(long, new Set([long, copy]))
  assert.equal(Array.from(second).length, 100)
  assert.ok(second.endsWith(' (copy 2)'))
})

test('в буфер ложится локальный файл обмена с именами моделей', () => {
  const localGraph = {
    nodes: [{ id: 'n1', type: 'gen', position: { x: 0, y: 0 }, data: { kind: 'image', prompt: 'кот', model: 'chatgpt-image-2' } }],
    edges: [],
  }
  const text = macroClipboardText({ name: 'Кот', graph: localGraph }, 'local', LOCAL_MODELS)
  assert.equal(isMacroText(text), true)
  const parsed = JSON.parse(text)
  assert.equal(parsed.format, 'canai-macro')
  assert.equal(parsed.catalog, 'local')
  assert.deepEqual(parsed.modelNames, { 'chatgpt-image-2': 'GPT Image 2' })
})

test('посторонний текст в буфере за макрос не принимается', () => {
  for (const text of ['', 'просто текст', '{"format":"canai-assistant"}', '{"canai-macro":1}', '["canai-macro"]', 'https://example.com/"canai-macro"']) {
    assert.equal(isMacroText(text), false, text)
  }
  // прежний вид из буфера обмена — {type, name, graph}
  assert.equal(isMacroText('{"type":"canai-macro","name":"x","graph":{"nodes":[],"edges":[]}}'), true)
})

test('Ctrl+C на кнопке макроса кладёт его в буфер и говорит об этом', async () => {
  const { page, clipboard, toasts, handlers, key } = bench()
  page.hovered = macro('Портрет', 0)
  for (const init of [{}, { key: 'с' }, { key: 'C', ctrlKey: false, metaKey: true }]) {
    clipboard.text = ''
    const event = key(init)
    await handlers.onKeyDown(event)
    assert.equal(event.prevented, true, 'нажатие наше: браузер своё копирование не делает')
    assert.equal(clipboard.text, macroText, 'в буфере тот же файл обмена, что «Сохранить в файл»')
  }
  assert.equal(JSON.parse(clipboard.text).catalog, 'local')
  // Выделение из одних пробелов — не выделение: нажатие всё равно наше.
  page.selected = ' \n '
  const spaced = key()
  await handlers.onKeyDown(spaced)
  assert.equal(spaced.prevented, true)
  assert.deepEqual(toasts, Array(4).fill('success: Macro “Портрет” copied'))
})

test('буфер всегда получает локальную пометку и локальные имена моделей', async () => {
  const { page, clipboard, handlers, key } = bench('local')
  page.hovered = macro('Портрет', undefined, { graph: { nodes: [node('img', 'image', { prompt: 'кот', model: 'chatgpt-image-2' })], edges: [] } })
  await handlers.onKeyDown(key())
  const parsed = JSON.parse(clipboard.text)
  assert.equal(parsed.catalog, 'local')
  assert.deepEqual(parsed.modelNames, { 'chatgpt-image-2': 'GPT Image 2' }, 'имена моделей — из локального каталога')
})

// ⚠️ Раньше хватало памяти о том, что курсор когда-то заходил на кнопку: после
// вставки над кнопкой она залипала, и Ctrl+C по объектам доски клал в буфер
// макрос — объекты не копировались, а Ctrl+V на холсте потом молча ничего не делал.
test('Ctrl+C не наш, когда курсор не на кнопке, человек печатает или выделил текст', async () => {
  const { page, clipboard, toasts, handlers, key } = bench()
  const untouched = async (label: string, init: Partial<FakeKey> = {}) => {
    clipboard.text = 'то, что человек хотел скопировать'
    const event = key(init)
    await handlers.onKeyDown(event)
    assert.equal(event.prevented, false, `${label}: нажатие остаётся браузеру и холсту`)
    assert.equal(clipboard.text, 'то, что человек хотел скопировать', label)
  }
  await untouched('курсор не на кнопке')
  page.hovered = macro('Портрет', 0)
  await untouched('печатают в поле', { target: INPUT })
  page.selected = 'выделенный абзац'
  await untouched('на странице выделен текст')
  page.selected = '   '
  page.hovered = null
  await untouched('пробелы — не выделение, но и курсор не на кнопке')
  page.hovered = macro('Портрет', 0)
  await untouched('другая клавиша', { key: 'v', code: 'KeyV' })
  await untouched('без Ctrl', { ctrlKey: false })
  assert.deepEqual(toasts, [])
})

test('отказ буфера и негодный макрос — словами, а не «скопирован»', async () => {
  const { page, clipboard, toasts, handlers, key } = bench()
  page.hovered = macro('Портрет', 0)
  clipboard.refuses = true
  const refused = key()
  await handlers.onKeyDown(refused)
  assert.equal(refused.prevented, true)
  assert.deepEqual(toasts.splice(0), ['error: Failed to put macro on clipboard'])

  clipboard.refuses = false
  page.hovered = macro('Пустой', 1, { graph: { nodes: [], edges: [] } })
  await handlers.onKeyDown(key())
  assert.equal(clipboard.text, '', 'пустой макрос в буфер не кладём')
  assert.deepEqual(toasts, ['error: There is not a single valid node in the macro'])
})

test('макрос под курсором берётся у страницы и из СВЕЖЕГО списка', () => {
  const stale = macro('Портрет', 0, { id: 'm1', name: 'Старое имя' })
  const fresh = macro('Портрет', 0, { id: 'm1' })
  const row = (hoveredId: string | null) => ({
    querySelector: (selector: string) => (
      selector === '[data-macro-id]:hover' && hoveredId ? { dataset: { macroId: hoveredId } } : null
    ),
  }) as never
  assert.equal(macroUnderCursor(row('m1'), [fresh]), fresh, 'список перечитан — копируется новый объект, а не запомненный')
  assert.notEqual(macroUnderCursor(row('m1'), [fresh]), stale)
  assert.equal(macroUnderCursor(row(null), [fresh]), null, 'курсор не на кнопке')
  assert.equal(macroUnderCursor(row('m2'), [fresh]), null, 'кнопка осталась, а макроса в списке уже нет')
  assert.equal(macroUnderCursor(null, [fresh]), null, 'ряда на экране нет')
})

// ⚠️ Ряд и холст обязаны понимать «печатают в поле» одинаково: холст по этому
// признаку решает, чей Ctrl+V, и уступает ход ряду. Раньше ряд считал полем и
// выпадающий список (в нём фокус остаётся после выбора модели), а холст — нет:
// холст уступал, ряд отказывался, и Ctrl+V над рядом молчал.
test('«печатают в поле» — это поле ввода и редактируемый текст, как у холста', () => {
  class FakeElement {
    constructor(readonly tagName: string, readonly isContentEditable = false) {}
  }
  const globals = globalThis as { HTMLElement?: unknown }
  const before = globals.HTMLElement
  globals.HTMLElement = FakeElement
  try {
    for (const tag of ['INPUT', 'TEXTAREA']) assert.equal(typingInField(new FakeElement(tag) as never), true, tag)
    assert.equal(typingInField(new FakeElement('DIV', true) as never), true, 'редактируемый текст')
    for (const tag of ['SELECT', 'DIV', 'BUTTON', 'CANVAS']) assert.equal(typingInField(new FakeElement(tag) as never), false, tag)
    assert.equal(typingInField(null), false)
    assert.equal(typingInField({} as never), false, 'не элемент страницы')
  } finally {
    globals.HTMLElement = before
  }
  // Двойник правила — у холста: меняется там, менять и в typingInField.
  assert.match(
    source('konva/KonvaCanvas.tsx'),
    /focusInInput: Boolean\(\s*target && \(target\.tagName === 'INPUT' \|\| target\.tagName === 'TEXTAREA' \|\| target\.isContentEditable\),\s*\),/,
  )
})

// ⚠️ Сторож пути. Ctrl+V над рядом макросов должен идти тем же очищающим
// импортом, что и «Из файла», без обхода сохранения и без разбора JSON в хуке.
test('вставка макроса из буфера идёт тем же путём, что «Из файла»', () => {
  const hook = source('useMacroClipboard.ts')
  assert.match(hook, /importMacro: importMacroFromText,/)
  assert.match(hook, /macroClipboardText\(/)
  assert.doesNotMatch(hook, /saveMacro\(|JSON\.parse\(/)
  // событием paste, а не чтением буфера по клавише: без вопроса браузера о доступе
  assert.match(hook, /addEventListener\('paste'/)
  assert.doesNotMatch(hook, /clipboard\.readText\(/)
  // свежие список и каталог читаются при каждом нажатии, а не запоминаются при подключении
  assert.match(hook, /loadRow: \(\) => loadMacroRow\(latest\.current\.projectSource\)/)
  assert.match(hook, /hoveredMacro: \(\) => macroUnderCursor\(rowRef\.current, latest\.current\.macros\)/)
  // ряд сообщает холсту, что курсор над ним, — тем же признаком, по которому вставляет сам
  assert.match(hook, /const overRow = \(\) => Boolean\(rowRef\.current\?\.matches\(':hover'\)\)/)
  assert.match(hook, /const unregisterRow = registerMacroRow\(overRow\)/)
  assert.match(hook, /return \(\) => \{\s*unregisterRow\(\)/)

  const panel = source('PromptMacros.tsx')
  assert.match(panel, /useMacroClipboard\(/)
  assert.doesNotMatch(panel, /navigator\.clipboard|api\.saveMacro\(/)
  // Кнопка называет себя сама; памяти «курсор заходил на кнопку» в ряду нет — залипать нечему.
  assert.match(panel, /data-macro-id=\{m\.id\}/)
  assert.doesNotMatch(panel, /hoveredMacroRef|onMouseEnter|onMouseLeave/)
  // Замечания вставки открывают окно макросов вместе с итогом.
  assert.match(panel, /initialNotice=\{libraryNotice\}/)
  assert.match(panel, /setLibraryNotice\(notice\)\s*setLibraryOpen\(true\)/)
})

// ⚠️ Сторож проводки. Обработчики стенд гоняет подставными событиями, но
// подключает их к странице хук, а хук в Node не исполняется: это React и окно.
// На копии в нём по одной ломали шесть вещей — не слушать keydown, не спрашивать
// выделенный текст, не отличать поле ввода, считать запись в буфер всегда
// удачной, не обновлять свежие значения, снять ref с ряда кнопок — и прогон
// оставался зелёным (проверка 03.10.2026). Для человека каждая — «Ctrl+C макроса
// молчит», «копирует макрос вместо выделенного текста» или «скопирован», когда в
// буфере пусто.
test('хук подключает обработчики к странице: клавиши, выделение, поле ввода, буфер, свежие значения и ряд кнопок', () => {
  const hook = source('useMacroClipboard.ts')
  const wiringStart = hook.indexOf('const handlers = createMacroClipboardHandlers({')
  const wiringEnd = hook.indexOf('})', wiringStart)
  assert.ok(wiringStart > 0 && wiringEnd > wiringStart, 'хук собирает обработчики из своих зависимостей')
  const wired = new Set(hook.slice(wiringStart, wiringEnd).split('\n').map((line) => line.trim()))
  for (const line of [
    // Ctrl+C не наш, когда печатают или выделили текст, — спрашиваем у страницы, а не «никогда».
    'typingIn: typingInField,',
    'selectedText: browserSelectedText,',
    // Запись в буфер — настоящая, с честным «не удалось».
    'copyText,',
    'importMacro: importMacroFromText,',
    'notify,',
    'changed: notifyMacrosChanged,',
  // Источник и каталог читаются свежими, а замечания передаются в библиотеку.
    'projectSource: () => latest.current.projectSource,',
    'models: () => latest.current.models,',
    'onNotes: (notice) => latest.current.onNotes(notice),',
  ]) {
    assert.ok(wired.has(line), `в проводке хука нет «${line}»`)
  }
  assert.match(hook, /import \{ copyText \} from '\.\.\/\.\.\/ui\/ids'/)
  assert.match(hook, /import \{ browserSelectedText \} from '\.\/konva\/canvasCopyOwnership'/)
  // Свежие значения кладутся после КАЖДОЙ отрисовки: у эффекта нет списка зависимостей.
  assert.match(hook, /useEffect\(\(\) => \{\s*latest\.current = \{ macros, models, projectSource, onNotes \}\s*\}\)\n/)
  // Оба события слушаются на окне и ведут в обработчики; снимаются оба.
  assert.match(hook, /const onKeyDown = \(event: KeyboardEvent\) => \{ void handlers\.onKeyDown\(event\) \}/)
  assert.match(hook, /const onPaste = \(event: ClipboardEvent\) => \{ void handlers\.onPaste\(event\) \}/)
  // ⚠️ Сверяем ЖИВЫЕ строки целиком: подстрока находится и в закомментированной.
  const live = new Set(hook.split('\n').map((line) => line.trim()))
  for (const listener of ["'keydown', onKeyDown", "'paste', onPaste"]) {
    assert.ok(live.has(`window.addEventListener(${listener})`), `хук не слушает ${listener}`)
    assert.ok(live.has(`window.removeEventListener(${listener})`), `хук не снимает ${listener}`)
  }

  // Ряд кнопок: без ref хук не узнает ни «курсор над рядом», ни макрос под курсором.
  const panel = source('PromptMacros.tsx')
  assert.match(panel, /const rowRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(panel, /<div className="macros-inline" ref=\{rowRef\}>/)
  assert.match(panel, /useMacroClipboard\(\{ rowRef, macros, models, projectSource: localSource, onNotes: \w+ \}\)/)
})
