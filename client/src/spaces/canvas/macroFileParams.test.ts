import assert from 'node:assert/strict'
import test from 'node:test'
import { toCanonParams } from '../../../../packages/model-catalog/canonBridge.js'
import type { CatalogModel, ParamSpec } from '../../types.js'
import { pickerModels } from '../nodes/nodeModel.js'
import type { NodeKind } from '../nodes/types.js'
import { readMacroFile, type MacroFile } from './macroFile.js'
import { adaptMacroFile } from './macroFileAdapt.js'
import {
  CATALOGS, LOCAL_MODELS, TEAM_MODELS, assertRunnable, dataOf, node, otherSide, seeded, target, transfer,
  type Side,
} from './macroFileTestKit.js'

// Параметры ноды из файла — под модель получателя, и слова о том, что при этом
// потерялось. Та же настройка у своей доски и у сервера команды зовётся и
// хранится по-разному: `aspect_ratio` и `aspect`, размер `1K` и `hd`,
// длительность строкой «12» и числом 12. Модели, виды нод и файлы — в
// macroFileAdapt.test.ts.

const aboutParams = (notes: string[]) => notes.filter((note) => /setting|настройк/.test(note))
// «Авто» у длительности Seedance на своей доске значит «длину выберет модель»; у сервера команды
// длительность — число, и такого значения нет.
const AUTO_DURATION_NOTE = '«Video» (Seedance 2.0): setting «Duration (sec)» has no value here «auto» - delivered by 5'

// ⚠️ Находка проверки 02.10.2026: у текстовых моделей сервера команды параметров
// нет вовсе, и системный промпт LLM-ноды просто выбрасывался. Макрос запускался,
// LLM отвечала без своих инструкций, и дальше по цепочке уходили не те промпты —
// оплаченные картинки и видео получались не те.
test('системный промпт LLM-ноды переезжает в начало её промпта, и об этом сказано', () => {
  const system = 'Ты арт-директор.\nВерни только английский промпт.'
  const llm = (id: string, prompt: string, patch: Record<string, unknown> = {}) => (
    node(id, 'text', { prompt, model: 'gemini', params: { ...seeded(LOCAL_MODELS, 'gemini'), ...patch } })
  )
  const imported = transfer('local', 'team', [
    llm('a', 'улучши промпт', { system_prompt: system }),
    llm('b', '', { system_prompt: `  ${system}  ` }),
    llm('c', 'без инструкций'),
    llm('d', 'пустые инструкции', { system_prompt: '   ' }),
    // Системный промпт бывает только у LLM: такой параметр у картинки — мусор, в промпт он не идёт.
    node('img', 'image', { prompt: 'кот', model: 'chatgpt-image-2', params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), system_prompt: 'не для картинки' } }),
  ])
  assert.equal(dataOf(imported, 'a').prompt, `${system}\n\nулучши промпт`)
  assert.equal(dataOf(imported, 'b').prompt, system, 'у ноды без своего промпта остаётся сам системный текст')
  assert.equal(dataOf(imported, 'c').prompt, 'без инструкций')
  assert.equal(dataOf(imported, 'd').prompt, 'пустые инструкции')
  assert.equal(dataOf(imported, 'img').prompt, 'кот')
  for (const id of ['a', 'b', 'c', 'd']) assert.deepEqual(dataOf(imported, id).params, {})
  assert.deepEqual(imported.notes, [
    '«LLM» (Gemini Flash): the system prompt has been moved to the beginning of the node prompt - there is no separate field for it here (in 2 nodes)',
  ])
})

test('где у модели получателя есть поле системного промпта, он остаётся в нём', () => {
  // Модели автора на этой доске нет — берётся модель по умолчанию, а у неё такое поле есть.
  const text = JSON.stringify({
    format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: { 'моя-llm': 'Моя LLM' },
    graph: { nodes: [node('a', 'text', { prompt: 'вопрос', model: 'моя-llm', params: { system_prompt: 'Отвечай коротко' } })], edges: [] },
  })
  const imported = adaptMacroFile(readMacroFile(text), target('local'))
  assert.equal(dataOf(imported, 'a').prompt, 'вопрос')
  assert.equal(dataOf(imported, 'a').params!.system_prompt, 'Отвечай коротко')
  assert.deepEqual(imported.notes, ['Model "Моя LLM" replaced with "Gemini 3.8 Flash"'])
})

// ⚠️ Раньше общая фраза «Часть параметров моделей сброшена…» выходила почти при
// КАЖДОМ переносе: у ноды на одних умолчаниях «терялись» служебное число
// картинок и формат. Нода на умолчаниях ничего не теряет — и замечаний не даёт.
// Исключение одно: «Авто» у длительности Seedance — умолчание своей доски,
// которого у сервера команды нет. Смысл ноды меняется, и об этом сказано.
test('нода на умолчаниях переносится без замечаний о настройках — у любой модели, в обе стороны', () => {
  for (const from of ['local', 'team'] as Side[]) {
    for (const kind of ['text', 'image', 'video', 'audio'] as NodeKind[]) {
      for (const model of pickerModels(CATALOGS[from], kind)) {
        const label = `${from} → ${otherSide(from)}, ${model.id}`
        const imported = transfer(from, otherSide(from), [node('n', kind, { prompt: 'x', model: model.id, params: seeded(CATALOGS[from], model.id) })])
        const autoDuration = from === 'local' && seeded(LOCAL_MODELS, model.id).duration === 'auto'
        assert.deepEqual(aboutParams(imported.notes), autoDuration ? [AUTO_DURATION_NOTE] : [], label)
        assertRunnable(CATALOGS[otherSide(from)], dataOf(imported, 'n'), label)
      }
    }
  }
})

test('о выбранной настройке, которая не перенеслась, сказано по ноде и её словами', () => {
  const localNodes = [
    node('llm', 'text', { prompt: 'x', model: 'gemini', params: { ...seeded(LOCAL_MODELS, 'gemini'), temperature: 0.2 } }),
    node('img', 'image', { prompt: 'x', model: 'chatgpt-image-2', params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), quality: 'low' } }),
    node('wide', 'image', { prompt: 'x', model: 'nano-banana', params: { ...seeded(LOCAL_MODELS, 'nano-banana'), aspect_ratio: '21:9', seed: 12345 } }),
    node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { ...seeded(LOCAL_MODELS, 'seedance-2'), generate_audio: false, resolution: '1080p' } }),
  ]
  const toTeam = transfer('local', 'team', localNodes)
  assert.deepEqual(toTeam.notes, [
    '«LLM» (Gemini Flash): the «Temperature (creativity)» setting is not here - the 0.2 value is not transferred',
    '«Image» (GPT Image 2): the «Quality» setting is not here - the «Low» value is not transferred',
    '«Image» (Nano Banana 2): setting «Aspect ratio» has no value here «21:9» - delivered by «Auto»',
    AUTO_DURATION_NOTE,
    '«Video» (Seedance 2.0): the «With audio» setting is not here - the “off” value is not transferred',
  ])
  // То, что перенеслось, перенеслось: зерно, размер.
  assert.deepEqual(dataOf(toTeam, 'wide').params, { aspect: 'auto', size: 'hd', seed: 12345, format: 'png' })
  assert.equal(dataOf(toTeam, 'clip').params!.size, '2k')
  for (const item of toTeam.graph.nodes) assertRunnable(TEAM_MODELS, item.data, item.id)

  const toLocal = transfer('team', 'local', [
    node('img', 'image', { prompt: 'x', model: 'gpt-image-2', params: { aspect: 'auto', size: 'auto', format: 'jpeg' } }),
  ])
  assert.deepEqual(toLocal.notes, ['«Image» (GPT Image 2): the «Format» setting is not here - the «JPEG» value is not transferred'])
})

test('одинаковые замечания сливаются, длинный список сворачивается', () => {
  const quiet = (id: string) => node(id, 'video', {
    prompt: 'x', model: 'seedance-2', params: { ...seeded(LOCAL_MODELS, 'seedance-2'), duration: '8', generate_audio: false },
  })
  assert.deepEqual(transfer('local', 'team', [quiet('a'), quiet('b'), quiet('c')]).notes, [
    '«Video» (Seedance 2.0): the «With audio» setting is not here - the “off” value is not transferred (in 3 nodes)',
  ])
  const many = transfer('local', 'team', Array.from({ length: 9 }, (_, index) => node(`n${index}`, 'text', {
    prompt: 'x', model: 'gemini', params: { ...seeded(LOCAL_MODELS, 'gemini'), temperature: (index + 1) / 10 },
  })))
  assert.equal(many.notes.length, 7)
  assert.equal(many.notes[6], '…and 3 more notes about settings — check the nodes in the workflow editor')
})

// Файл прежнего вида (и текст из буфера прежнего приложения) не помнит ни
// подписей настроек, ни умолчаний: выбирал ли автор значение, по нему не понять.
test('файл прежнего вида: служебное не тревожит, о прочем сказано без выдумок', () => {
  const legacy = (params: Record<string, unknown>) => adaptMacroFile(readMacroFile(JSON.stringify({
    format: 'canai-macro', version: 1, name: 'Старый', catalog: 'local', modelNames: { 'chatgpt-image-2': 'GPT Image 2' },
    graph: { nodes: [node('img', 'image', { prompt: 'x', model: 'chatgpt-image-2', params })], edges: [] },
  })), target('team'))

  const quiet = legacy({ aspect_ratio: '9:16', num_images: 1 })
  assert.deepEqual(dataOf(quiet, 'img').params, { aspect: '9:16', size: 'auto', format: 'png' })
  assert.deepEqual(quiet.notes, [], 'число картинок человек в ноде не выбирает — панель его не показывает')

  // Настройки здесь нет вовсе, и её подписи файл не помнит: называть нечем, молчать нельзя.
  assert.deepEqual(legacy({ quality: 'low', enable_safety_checker: false, num_images: 1 }).notes, [
    '«Image» (GPT Image 2): some of the settings from the file do not apply here - check the node in the editor',
  ])
  // Настройка здесь есть, а значения нет — называем её так, как её видит получатель.
  assert.deepEqual(legacy({ aspect_ratio: '21:9' }).notes, [
    '«Image» (GPT Image 2): setting «Aspect ratio» has no value here «21:9» - delivered by «Auto»',
  ])
})

test('параметр, которого не знал и каталог автора, — не настройка: о нём не говорим', () => {
  const imported = transfer('local', 'team', [
    node('img', 'image', { prompt: 'x', model: 'chatgpt-image-2', params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), guidance: 7, steps: 30 } }),
  ])
  assert.deepEqual(dataOf(imported, 'img').params, { aspect: '4:3', size: 'hd', format: 'png' })
  assert.deepEqual(imported.notes, [])
})

// ⚠️ Длительность Seedance на своей доске — строка из списка («12»), на сервере
// команды — число. При буквальном сравнении она терялась в обе стороны: 12 с
// превращались в 5 с там и в «авто» (до 15 с по $0.30) здесь.
// ⚠️ «Авто» своей доски перевести не во что: у сервера команды длительность —
// число. Раньше оно молча становилось 5 с — длину выбирала модель, а после
// переноса ролик всегда выходил пятисекундным, и об этом не было ни слова.
test('длительность ролика переносится в обе стороны, хотя хранится по-разному', () => {
  const toTeam = transfer('local', 'team', [
    node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { ...seeded(LOCAL_MODELS, 'seedance-2'), duration: '12' } }),
    node('auto', 'video', { prompt: 'x', model: 'seedance-2', params: { ...seeded(LOCAL_MODELS, 'seedance-2'), duration: 'auto' } }),
    node('grok', 'video', { prompt: 'x', model: 'grok', params: { ...seeded(LOCAL_MODELS, 'grok'), duration: 12 } }),
  ])
  assert.strictEqual(dataOf(toTeam, 'clip').params!.duration, 12)
  assert.strictEqual(dataOf(toTeam, 'auto').params!.duration, 5, '«авто» у числового поля нет — остаётся его умолчание')
  assert.strictEqual(dataOf(toTeam, 'grok').params!.duration, 12)
  assert.deepEqual(toTeam.notes, [AUTO_DURATION_NOTE], 'сказано только про «авто»: выбранная длительность переносится без слов')

  const toLocal = transfer('team', 'local', [
    node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { aspect: 'auto', size: 'auto', duration: 12 } }),
    node('grok', 'video', { prompt: 'x', model: 'grok-video', params: { aspect: 'auto', size: 'auto', duration: 12 } }),
  ])
  assert.strictEqual(dataOf(toLocal, 'clip').params!.duration, '12')
  assert.strictEqual(dataOf(toLocal, 'grok').params!.duration, 12)
  assert.deepEqual(toLocal.notes, [])

  // Длительности, которой у получателя нет, молча не бывает.
  const short = transfer('team', 'local', [
    node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { aspect: 'auto', size: 'auto', duration: 3 } }),
  ])
  assert.strictEqual(dataOf(short, 'clip').params!.duration, 'auto')
  assert.deepEqual(short.notes, ['«Video» (ByteDance Seedance 2.0): setting «Duration, s» has no value here 3 - delivered by «auto»'])
})

// Файл прежнего вида подписи настройки не помнит — называем её так, как её видит получатель.
test('об «авто» при числовом поле сказано и в файле прежнего вида', () => {
  const text = JSON.stringify({
    format: 'canai-macro', version: 1, name: 'Старый', catalog: 'local', modelNames: {},
    graph: { nodes: [node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { duration: 'auto' } })], edges: [] },
  })
  const imported = adaptMacroFile(readMacroFile(text), target('team'))
  assert.strictEqual(dataOf(imported, 'clip').params!.duration, 5)
  assert.deepEqual(imported.notes, ['«Video» (Seedance 2.0): setting «Duration, s» has no value here «auto» - delivered by 5'])
})

test('настройка, которая при этих значениях не действует, в ноду не кладётся', () => {
  const flare = (id: string, format: string) => node(id, 'image', {
    prompt: 'x', model: 'gpt-image-2.5-flare', params: { ...seeded(TEAM_MODELS, 'gpt-image-2.5-flare'), format, compression: 60 },
  })
  const imported = transfer('team', 'local', [flare('png', 'png'), flare('webp', 'webp')])
  // Свой сервер отказывает ноде, где качество JPEG задано при формате PNG.
  assert.equal('output_compression' in dataOf(imported, 'png').params!, false)
  assert.equal(dataOf(imported, 'webp').params!.output_compression, 60)
  assert.deepEqual(imported.notes, [])
  for (const item of imported.graph.nodes) assertRunnable(LOCAL_MODELS, item.data, item.id)
})

// Перевод имён и размеров при ЗАПУСКЕ генерации ведёт canonBridge; у обмена
// файлом таблицы свои (нужны обе стороны). Разъедутся — параметр, который
// доезжает до модели с холста, начнёт теряться при переносе макроса.
test('имена параметров и ступени размера переводятся так же, как при запуске генерации', () => {
  const any = (name: string): ParamSpec => ({ name, label: name, widget: 'textarea' })
  const sizes = ['sd', 'hd', '2k', '4k']
  const canon = [{
    id: 'm', name: 'М', kind: 'image', refs: true,
    params: [any('aspect'), any('format'), any('negative'), { name: 'compression', label: 'c', widget: 'number' },
      { name: 'size', label: 's', widget: 'select', options: sizes.map((value) => ({ value, label: value })) }],
  }] as CatalogModel[]
  const adapt = (params: Record<string, string | number>) => {
    const file: MacroFile = {
      format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: {},
      graph: { nodes: [{ id: 'n', type: 'gen', position: { x: 0, y: 0 }, data: { kind: 'image', prompt: 'x', status: 'idle', model: 'm', params } }], edges: [] },
    }
    return adaptMacroFile({ file, droppedFiles: 0 }, { catalog: 'team', models: canon, defaultModelId: () => 'm' }).graph.nodes[0]!.data.params
  }
  const own: Array<[string, string | number]> = [
    ['aspect_ratio', '9:16'], ['output_format', 'jpeg'], ['negative_prompt', 'шум'], ['output_compression', 80],
    ...['resolution', 'image_size'].flatMap((name) => (
      ['0.5K', '1K', '1k', '2K', '4K', '480p', '720p', '1080p', 'square_hd', 'square', 'sd', 'hd', '2k', '4k'].map((value): [string, string] => [name, value])
    )),
  ]
  for (const [name, value] of own) assert.deepEqual(adapt({ [name]: value }), toCanonParams({ [name]: value }), `${name}=${value}`)
  // Ступени размера — только у размера: у прочих настроек «2K» ни во что не превращается.
  assert.deepEqual(adapt({ output_format: '2K' }), { format: '2K' })
  const mode: CatalogModel[] = [{ ...canon[0]!, params: [{ name: 'mode', label: 'Режим', widget: 'select', default: 'fast', options: [{ value: 'fast', label: 'Быстро' }, { value: 'hd', label: 'Чётко' }] }] }]
  const file: MacroFile = {
    format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: {},
    graph: { nodes: [{ id: 'n', type: 'gen', position: { x: 0, y: 0 }, data: { kind: 'image', prompt: 'x', status: 'idle', model: 'm', params: { mode: '1K' } } }], edges: [] },
  }
  const strict = adaptMacroFile({ file, droppedFiles: 0 }, { catalog: 'team', models: mode, defaultModelId: () => 'm' })
  assert.deepEqual(strict.graph.nodes[0]!.data.params, { mode: 'fast' }, '«1K» — не «hd», когда настройка не про размер')
})
