import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantModelOptions, modelSelectHint } from './assistantModelHint'

const catalog = [
  { id: 'gemini', name: 'Gemini 3.6 Flash', kind: 'text' },
  { id: 'claude', name: 'Claude Sonnet 5', kind: 'text' },
  { id: 'nano', name: 'Nano Banana', kind: 'image' },
]

const labels = (options: ReturnType<typeof assistantModelOptions>) => options.map((option) => option.label)

test('модель диалога есть в каталоге: только текстовые модели, без пояснений', () => {
  const options = assistantModelOptions({ models: catalog, selectedModelId: 'claude', chatLoadState: 'ready' })

  assert.deepEqual(options.map((option) => option.value), ['gemini', 'claude'])
  assert.equal(options.some((option) => option.disabled), false)
})

// ⚠️ Модели диалога нет в каталоге (тимлид снял с публикации): раньше в шапке
// стояла первая модель списка, хотя диалог настроен на другую.
test('модели диалога нет в каталоге: отдельный пункт с её id, а не первая модель списка', () => {
  const options = assistantModelOptions({ models: catalog, selectedModelId: 'retired-model', chatLoadState: 'ready' })

  assert.deepEqual(options[0], {
    value: 'retired-model',
    label: 'Model not available retired-model',
    disabled: true,
    title: 'Model “retired-model” is not in the catalog - select another',
  })
  assert.deepEqual(options.slice(1).map((option) => option.value), ['gemini', 'claude'])
})

test('нетекстовая модель в роли выбранной — тоже недоступна для диалога', () => {
  const options = assistantModelOptions({ models: catalog, selectedModelId: 'nano', chatLoadState: 'ready' })

  assert.equal(options[0].value, 'nano')
  assert.match(options[0].label, /^Model not available/)
})

test('каталог ещё не пришёл: «недоступна» не говорим, остаётся id модели', () => {
  const options = assistantModelOptions({ models: [], selectedModelId: 'gemini', chatLoadState: 'ready' })

  assert.deepEqual(labels(options), ['gemini'])
})

// ⚠️ Планшет писал «Загрузка моделей…», хотя модели давно пришли, а не
// загрузился диалог.
test('диалог не загрузился при готовом каталоге: так и сказано, моделей не «грузим»', () => {
  const options = assistantModelOptions({ models: catalog, selectedModelId: undefined, chatLoadState: 'error' })

  assert.equal(options[0].value, '')
  assert.equal(options[0].label, "Chat didn't load")
  assert.equal(options[0].disabled, true)
  assert.equal(labels(options).includes('Загрузка моделей…'), false)
})

test('«Загрузка моделей…» — только когда каталога действительно ещё нет', () => {
  const loading = assistantModelOptions({ models: [], selectedModelId: undefined, chatLoadState: 'loading' })
  assert.deepEqual(labels(loading), ['Loading models...'])

  const catalogReady = assistantModelOptions({ models: catalog, selectedModelId: undefined, chatLoadState: 'loading' })
  assert.equal(catalogReady[0].label, 'Loading chat...')
})

test('диалог не выбран при готовой загрузке — не «грузится», а не выбран', () => {
  const options = assistantModelOptions({ models: catalog, selectedModelId: undefined, chatLoadState: 'ready' })

  assert.equal(options[0].label, 'No chat selected')
})

test('подсказка выключенного списка называет причину', () => {
  assert.match(modelSelectHint('error'), /did not load/)
  assert.match(modelSelectHint('error'), /Retry/)
  assert.match(modelSelectHint('loading'), /when the chat loads/)
})
