import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { INPUT, bench, graph, macro, settle } from './macroClipboardTestKit'
import { macroClipboardText } from './macroFileActions'
import { LOCAL_MODELS, node, seeded } from './macroFileTestKit'
import { loadMacroRow } from './useMacroClipboard'

// Ctrl+V макроса над рядом кнопок: подставные события, настоящий путь в
// библиотеку (`importMacroFromText`). Ctrl+C — в useMacroClipboard.test.ts; что
// с тем же Ctrl+V делает холст — в macroPasteRoute.test.ts.

const here = import.meta.dirname
const source = (file: string) => fs.readFileSync(path.join(here, file), 'utf8').replaceAll('\r\n', '\n')

const macroText = macroClipboardText({ name: 'Портрет', graph }, 'local', LOCAL_MODELS)

test('Ctrl+V над рядом кладёт макрос в свободную кнопку и зовёт ряд перечитать список', async () => {
  const { page, toasts, notices, calls, handlers, pasteEvent, saved, changed } = bench()
  page.overRow = true
  const event = pasteEvent(macroText)
  await handlers.onPaste(event)
  assert.equal(event.prevented, true, 'вставка наша: текстом в страницу макрос не идёт')
  assert.deepEqual(saved(), [['Portrait', 0], ['Портрет', 1]])
  assert.deepEqual(calls, ['loadRow', 'saveMacro'])
  assert.equal(changed(), 1)
  assert.deepEqual(toasts, ['success: Macro "Портрет" inserted'])
  assert.deepEqual(notices, [], 'замечаний нет — окно не открываем')
})

test('Ctrl+V мимо ряда, в поле ввода и с посторонним текстом хук не трогает', async () => {
  const { page, toasts, calls, handlers, pasteEvent, saved } = bench()
  const ignored = async (label: string, text: string, target: EventTarget | null = null) => {
    const event = pasteEvent(text, target)
    await handlers.onPaste(event)
    assert.equal(event.prevented, false, label)
  }
  await ignored('курсор не над рядом', macroText)
  page.overRow = true
  await ignored('печатают в поле', macroText, INPUT)
  for (const foreign of ['', 'привет', '{"a":1}', 'https://example.com/"canai-macro"', '{"format":"canai-assistant","name":"x"}']) {
    await ignored(`посторонний текст ${JSON.stringify(foreign)}`, foreign)
  }
  assert.deepEqual(saved(), [['Portrait', 0]])
  assert.deepEqual(calls, [], 'ни запроса списка, ни записи')
  assert.deepEqual(toasts, [])
})

test('негодный макрос и отказ сервера — отказ словами, список не перечитывается', async () => {
  const { page, server, toasts, handlers, pasteEvent, saved, changed } = bench()
  page.overRow = true
  const broken = pasteEvent('{"format":"canai-macro","version":1,"name":"x"}')
  await handlers.onPaste(broken)
  assert.equal(broken.prevented, true)
  server.refusal = 'Недостаточно прав для создания макроса'
  await handlers.onPaste(pasteEvent(macroText))
  server.refusal = ''
  server.listFails = true
  await handlers.onPaste(pasteEvent(macroText))
  assert.deepEqual(toasts.splice(0), [
    'error: There is no macro graph in the file',
    'error: Недостаточно прав для создания макроса',
    'error: CanAI is temporarily unavailable',
  ])
  assert.equal(changed(), 0)
  assert.deepEqual(saved(), [['Portrait', 0]])
  // После отказа замок снят: следующая вставка проходит.
  server.listFails = false
  await handlers.onPaste(pasteEvent(macroText))
  assert.deepEqual(saved(), [['Portrait', 0], ['Портрет', 1]])
})

// ⚠️ Замок держится ВСЮ вставку: и пока читается список, и пока идёт запись.
// Раньше тест был один и подавал второе нажатие сразу за первым — в этот миг
// первое ещё ждало список и до «ворот» записи не доходило. Замок, снятый сразу
// после чтения списка, прогон поэтому не замечал (проверка 03.10.2026). А это и
// есть удержанная клавиша: повтор приходит во время записи, читает список без
// первого макроса и берёт ту же кнопку. Мигов два — и у каждого свой тест.
test('второй Ctrl+V, пока первый ещё читает список, — один макрос, а не два', async () => {
  const { page, calls, handlers, pasteEvent, saved, closeGate } = bench()
  page.overRow = true
  const open = closeGate()
  const first = handlers.onPaste(pasteEvent(macroText))
  assert.deepEqual(calls, ['loadRow'], 'первое нажатие только попросило список — до записи ему ещё идти')
  const second = pasteEvent(macroText)
  const repeated = handlers.onPaste(second)
  assert.equal(second.prevented, true, 'повторное нажатие тоже наше — текстом на холст оно не идёт')
  open()
  await Promise.all([first, repeated])
  assert.deepEqual(saved(), [['Portrait', 0], ['Портрет', 1]])
  assert.deepEqual(calls, ['loadRow', 'saveMacro'])
})

test('второй Ctrl+V, пока первый ещё пишется, — ни списка, ни записи: один макрос', async () => {
  const { page, calls, handlers, pasteEvent, saved, closeGate } = bench()
  page.overRow = true
  const open = closeGate()
  const first = handlers.onPaste(pasteEvent(macroText))
  await settle()
  assert.deepEqual(calls, ['loadRow', 'saveMacro'], 'первое нажатие дошло до записи и стоит у ворот')
  const second = pasteEvent(macroText)
  const repeated = handlers.onPaste(second)
  assert.equal(second.prevented, true, 'повторное нажатие тоже наше — текстом на холст оно не идёт')
  await settle()
  assert.deepEqual(calls, ['loadRow', 'saveMacro'], 'пока первое пишет, второе не читает список и не пишет')
  open()
  await Promise.all([first, repeated])
  assert.deepEqual(calls, ['loadRow', 'saveMacro'])
  assert.deepEqual(saved(), [['Portrait', 0], ['Портрет', 1]])
  // Замок снят вместе с записью: следующее нажатие — обычная вставка.
  await handlers.onPaste(pasteEvent(macroText))
  assert.deepEqual(saved(), [['Portrait', 0], ['Портрет', 1], ['Портрет (copy)', 2]])
})

// ⚠️ Список самого ряда отстаёт на один запрос. Раньше слот и занятые имена
// считались по нему: второе Ctrl+V сразу после первого (удержанная клавиша)
// бралось за ту же кнопку, и первый вставленный макрос её терял.
test('вставки подряд берут разные кнопки и разные имена, а на десятой — отказ', async () => {
  const library = Array.from({ length: 7 }, (_, slot) => macro(slot === 0 ? 'Портрет' : `М${slot}`, slot))
  const { page, toasts, handlers, pasteEvent, saved } = bench('local', library)
  page.overRow = true
  await handlers.onPaste(pasteEvent(macroText))
  await handlers.onPaste(pasteEvent(macroText))
  assert.deepEqual(saved().slice(7), [['Портрет (copy)', 7], ['Портрет (copy 2)', 8]], 'первая копия свою кнопку не потеряла')
  toasts.length = 0
  const tenth = pasteEvent(macroText)
  await handlers.onPaste(tenth)
  assert.equal(tenth.prevented, true)
  assert.deepEqual(toasts, ['info: All 9 slots are occupied — free one in Macro Library'])
  assert.equal(saved().length, 9, 'десятый макрос не создаётся и ничью кнопку не отбирает')
})

test('что при вставке пришлось заменить, остаётся в окне, а не мелькает всплывашкой', async () => {
  const sourceModels = LOCAL_MODELS.map((model) => model.id === 'chatgpt-image-2'
    ? {
        ...model,
        params: [...model.params, {
          name: 'legacy_quality', label: 'Legacy quality', widget: 'select', default: 'low',
          options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
        }],
      }
    : model)
  const localGraph = { nodes: [node('img', 'image', {
    // Источник содержит устаревший параметр, которого нет в локальном каталоге:
    // импорт должен сохранить макрос и показать человеку замечание.
    prompt: 'кот', model: 'chatgpt-image-2', params: { ...seeded(sourceModels, 'chatgpt-image-2'), legacy_quality: 'high' },
  })], edges: [] }
  const foreignFile = JSON.parse(macroClipboardText({ name: 'Портрет', graph: localGraph }, 'local', sourceModels)) as Record<string, unknown>
  // Файл со старой записью каталога должен пройти ту же локальную адаптацию.
  foreignFile.catalog = 'team'
  const { page, toasts, notices, calls, handlers, pasteEvent, server, changed } = bench('local', [])
  page.overRow = true
  await handlers.onPaste(pasteEvent(JSON.stringify(foreignFile)))
  assert.deepEqual(notices, [{
    tone: 'info',
    title: 'Macro “Портрет” inserted. Changes:',
    lines: ['«Image» (GPT Image 2): the «Legacy quality» setting is not here - the «High» value is not transferred'],
  }])
  assert.deepEqual(toasts, [], 'всплывашка живёт две секунды — прочесть замечания по ней нельзя')
  assert.deepEqual(calls, ['loadRow', 'saveMacro'])
  assert.equal(server.macros[0]!.scope, 'canvas')
  assert.equal(server.macros[0]!.slot, 0)
  assert.equal(changed(), 1)
})

test('свежий локальный список ряда берётся тем же отбором, что у самого ряда', async () => {
  const local = [macro('Свой', 0), macro('Цепочка', 0, { scope: 'assistant' }), macro('Без области', 1, { scope: undefined })]
  const asked: string[] = []
  const library = {
    listMacros: async () => { asked.push('local'); return { macros: local } },
  }
  assert.deepEqual((await loadMacroRow('local', library)).map((item) => item.name), ['Свой', 'Без области'])
  assert.deepEqual(asked, ['local'], 'ряд спрашивает только локальную библиотеку')
  // Сторож двойника: ряд отбирает макросы так же.
  const panel = source('PromptMacros.tsx')
  assert.match(panel, /\.filter\(\(m\) => m\.scope !== 'assistant'\)/)
})
