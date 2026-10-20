import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { CATALOG } from '../../../../packages/model-catalog/catalog.js'
import type { CatalogModel } from '../../types.js'
import { effectiveModel } from '../canvas/genOptions.js'
import { cleanMacroGraph } from './macroPersistence.js'
import {
  createNodeAspectTracker,
  nodeAspectStep,
  nodePanelParams,
  settleNodeSeed,
  type NodeAspectSeen,
} from './nodeAspect.js'
import type { CanaiNode } from './types.js'

// ⚠️ Жалоба 01.10.2026 со снимком: «в ноде пропало авто пропорции». Нода
// «Картинка», GPT Image 2.5 Sunburst, референс подключён — а в списке только
// 1:1, 3:4, 9:16, 4:3, 16:9. Причин было три (см. nodeAspect.ts), и прежний
// сторож ни одной не видел: он искал в тексте ноды слова, а не правило.

const models = CATALOG as unknown as CatalogModel[]
const sunburstByRefs = effectiveModel(models, 'image', 'gpt-image-2.5-sunburst', true)!
const sunburstBase = effectiveModel(models, 'image', 'gpt-image-2.5-sunburst', false)!
const grokVideo = effectiveModel(models, 'video', 'grok', false)!
const grokVideoByRefs = effectiveModel(models, 'video', 'grok', true)!
const seedance = effectiveModel(models, 'video', 'seedance-2', false)!

const select = (name: string, defaultValue: string, values: string[]) => ({
  name, label: name, widget: 'select', default: defaultValue,
  options: values.map((value) => ({ value, label: value })),
})

/** Модель сервера команды: пропорции зовутся `aspect`, умолчание конкретное. */
const cloudModel = {
  id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', kind: 'image',
  params: [select('aspect', '4:3', ['auto', '1:1', '3:4', '9:16', '4:3', '16:9'])],
} as unknown as CatalogModel

/**
 * Канон сервера команды: «Авто» по умолчанию значит «параметр не задан».
 * Порядок пунктов как у Gemini Omni Flash — первым конкретным стоит 9:16.
 */
const cloudUnset = {
  id: 'veo-omni', name: 'Gemini Omni Flash', kind: 'video',
  params: [select('aspect', 'auto', ['auto', '9:16', '16:9']), select('size', 'auto', ['auto', 'sd', 'hd'])],
} as unknown as CatalogModel

const seen = (model: CatalogModel, hasMediaRefs: boolean): NodeAspectSeen => ({ modelId: model.id, hasMediaRefs })
const aspectOptions = (model: CatalogModel, params: Record<string, unknown>, hasMediaRefs: boolean, name = 'aspect_ratio') =>
  nodePanelParams(model, params, hasMediaRefs).find((param) => param.name === name)!.options!.map((option) => option.value)

test('с подключённым референсом «Авто» есть в списке ноды, без него — нет', () => {
  assert.equal(aspectOptions(sunburstByRefs, {}, true)[0], 'auto', '«Авто» стоит первым пунктом')
  assert.ok(!aspectOptions(sunburstBase, { aspect_ratio: '4:3' }, false).includes('auto'), 'без референса решать не по чему')
})

test('список не врёт: «Авто», уже лежащее в макросе, остаётся в списке и без референса', () => {
  // Иначе список показал бы первый пункт, а в генерацию ушло бы другое.
  assert.ok(aspectOptions(sunburstBase, { aspect_ratio: 'auto' }, false).includes('auto'))
  assert.ok(aspectOptions(grokVideo, { resolution: 'auto' }, false, 'resolution').includes('auto'))
  assert.ok(!aspectOptions(grokVideo, { resolution: '720p' }, false, 'resolution').includes('auto'))
})

test('референс подключили — пропорции становятся «Авто»', () => {
  const next = nodeAspectStep(sunburstByRefs, { aspect_ratio: '4:3' }, seen(sunburstBase, false), true)
  assert.equal(next.aspect_ratio, 'auto')
})

test('выбор человека при подключённом референсе не перебивается', () => {
  // Раньше правило стояло на каждой смене пропорции и возвращало 'auto' сразу.
  const chosen = { aspect_ratio: '16:9', quality: 'high' }
  assert.equal(nodeAspectStep(sunburstByRefs, chosen, seen(sunburstByRefs, true), true), chosen)
})

// ⚠️ Открыть редактор — не действие над макросом. Навязанная здесь запись
// делала макрос «с правками» уже тем, что на него посмотрели, а у макроса
// сетевой доски меняла и результат (проверка 01.10.2026).
test('открытие редактора не меняет сохранённые параметры — ни с референсом, ни без', () => {
  const saved = { aspect_ratio: '9:16' }
  assert.equal(nodeAspectStep(sunburstByRefs, saved, null, true), saved)
  const savedAuto = { aspect_ratio: 'auto' }
  assert.equal(nodeAspectStep(sunburstBase, savedAuto, null, false), savedAuto)
  const cloudSaved = { aspect: 'auto', size: 'auto' }
  assert.equal(nodeAspectStep(cloudUnset, cloudSaved, null, false), cloudSaved)
})

test('референс сняли — «Авто» уступает конкретной пропорции', () => {
  assert.notEqual(
    nodeAspectStep(sunburstBase, { aspect_ratio: 'auto' }, seen(sunburstByRefs, true), false).aspect_ratio,
    'auto',
  )
})

test('референс сняли — «Авто» у разрешения тоже становится конкретным', () => {
  // С референсом в ноде можно выбрать «auto» у разрешения (Grok Video). Правило
  // вело только пропорции: после снятия референса список показывал 480p, а
  // сервер подставлял 720p — человек видел одно, платил за другое.
  const next = nodeAspectStep(grokVideo, { aspect_ratio: 'auto', resolution: 'auto' }, seen(grokVideoByRefs, true), false)
  assert.equal(next.resolution, '720p', 'умолчание модели, а не первый пункт')
  assert.notEqual(next.aspect_ratio, 'auto')
  const kept = { aspect_ratio: 'auto', resolution: 'auto' }
  assert.equal(nodeAspectStep(grokVideoByRefs, kept, seen(grokVideoByRefs, true), true), kept, 'при референсе «auto» не трогаем')
})

test('сменили модель при подключённом референсе — снова «Авто»', () => {
  // Значения новой модели засеиваются от БАЗОВОЙ (у GPT это 4:3).
  const next = nodeAspectStep(sunburstByRefs, { aspect_ratio: '4:3' }, { modelId: 'nano-banana-edit', hasMediaRefs: true }, true)
  assert.equal(next.aspect_ratio, 'auto')
})

test('макрос сетевой доски: параметр зовётся aspect, правило то же', () => {
  assert.ok(aspectOptions(cloudModel, {}, true, 'aspect').includes('auto'), '«Авто» в списке')
  const next = nodeAspectStep(cloudModel, { aspect: '4:3' }, seen(cloudModel, false), true)
  assert.deepEqual(next, { aspect: 'auto' }, 'пишем в имя параметра каталога, а не в aspect_ratio')
  assert.equal(nodeAspectStep(cloudModel, { aspect: 'auto' }, seen(cloudModel, true), false).aspect, '4:3')
})

// ⚠️ У канона сервера команды «Авто» по умолчанию — «параметр не задан»: сервер
// не шлёт его провайдеру. Подмена первым пунктом превращала ролик 16:9 в
// вертикаль (Gemini Omni) или квадрат (Seedance, Grok Video) за те же деньги.
test('канон сервера команды: «Авто» по умолчанию не подменяется и остаётся в списке', () => {
  const unset = { aspect: 'auto', size: 'auto' }
  assert.equal(nodeAspectStep(cloudUnset, unset, seen(cloudUnset, true), false), unset, 'референс сняли')
  assert.deepEqual(settleNodeSeed(cloudUnset, unset), unset, 'новая нода')
  assert.ok(aspectOptions(cloudUnset, unset, false, 'aspect').includes('auto'))
  assert.ok(aspectOptions(cloudUnset, { aspect: '16:9', size: 'hd' }, false, 'size').includes('auto'), 'вернуться к «не задано» можно всегда')
  // Подключили референс — «Авто» включается, как у всех.
  assert.equal(nodeAspectStep(cloudUnset, { aspect: '16:9' }, seen(cloudUnset, false), true).aspect, 'auto')
})

test('новая нода: «Авто» из умолчаний своего каталога сразу становится конкретным', () => {
  // У Seedance 2.0 пропорции по умолчанию 'auto'. Референса у новой ноды быть
  // не может: иначе список показывал бы 16:9, а в макросе лежало бы 'auto'.
  const seeded = settleNodeSeed(seedance, { aspect_ratio: 'auto', resolution: '720p' })
  assert.notEqual(seeded.aspect_ratio, 'auto')
  assert.ok(aspectOptions(seedance, seeded, false).includes(String(seeded.aspect_ratio)))
})

// Память перехода проверяем ПОСЛЕДОВАТЕЛЬНОСТЬЮ: прежний сторож читал текст
// компонента и не замечал ни пропавшей записи памяти, ни записи до шага.
test('память перехода: открыли → подключили → выбрали → сняли', () => {
  const step = createNodeAspectTracker()
  const saved = { aspect_ratio: '9:16' }
  assert.equal(step(sunburstByRefs, saved, true, 1), saved, 'открыли с референсом — выбор цел')
  assert.equal(step(sunburstBase, saved, false, 1), saved, 'сняли референс — конкретная пропорция остаётся')
  const auto = step(sunburstByRefs, saved, true, 1)
  assert.equal(auto.aspect_ratio, 'auto', 'подключили — «Авто»')
  const chosen = { aspect_ratio: '16:9' }
  assert.equal(step(sunburstByRefs, chosen, true, 1), chosen, 'выбор человека держится')
  assert.equal(step(sunburstByRefs, chosen, true, 1), chosen, 'и при повторном прогоне эффекта (StrictMode)')
  assert.notEqual(step(sunburstBase, { aspect_ratio: 'auto' }, false, 1).aspect_ratio, 'auto', 'сняли — конкретная')
})

test('Ctrl+Z, вернувший референс, не стирает возвращённый выбор', () => {
  // Нода при отмене не размонтируется, и её память считала возврат связи
  // действием человека: писала 'auto' поверх снимка и сжигала «повтор».
  const step = createNodeAspectTracker()
  const chosen = { aspect_ratio: '16:9' }
  step(sunburstByRefs, chosen, true, 1)
  assert.equal(step(sunburstBase, chosen, false, 1), chosen, 'связь удалили')
  assert.equal(step(sunburstByRefs, chosen, true, 2), chosen, 'отмена вернула снимок — отметка сменилась')
  // А следующее настоящее действие — снова переход.
  assert.equal(step(sunburstBase, chosen, false, 2), chosen)
  assert.equal(step(sunburstByRefs, chosen, true, 2).aspect_ratio, 'auto')
})

test('референс, подключённый пока каталог моделей ехал, — тоже переход', () => {
  const step = createNodeAspectTracker()
  const saved = { aspect_ratio: '4:3' }
  assert.equal(step(null, saved, false, 1), saved)
  assert.equal(step(null, saved, true, 1), saved, 'подключили без каталога')
  assert.equal(step(sunburstByRefs, saved, true, 1).aspect_ratio, 'auto', 'каталог пришёл')
  // Каталог приехал, а референс был с самого начала — это открытие, не переход.
  const opened = createNodeAspectTracker()
  assert.equal(opened(null, saved, true, 1), saved)
  assert.equal(opened(sunburstByRefs, saved, true, 1), saved)
})

test('отметка замены графа в макрос не сохраняется', () => {
  const node = {
    id: 'n1', type: 'canai', position: { x: 0, y: 0 },
    data: { kind: 'image', prompt: '', status: 'idle', restoredAt: 7 },
  } as unknown as CanaiNode
  const cleaned = JSON.parse(JSON.stringify(cleanMacroGraph([node], [])))
  assert.equal('restoredAt' in cleaned.nodes[0].data, false, 'иначе отмена до сохранённого состояния считалась бы правкой')
})

test('нода ведёт правило памятью из модуля, панель знает о референсе', async () => {
  const source = await readFile(new URL('./GenNode.tsx', import.meta.url), 'utf8')
  assert.match(source, /nodePanelParams\(eff, data\.params \?\? \{\}, hasMediaRefs\)/, 'панель обязана знать о референсе')
  assert.doesNotMatch(source, /panelParams\(eff\)/, 'без признака «Авто» вырезается всегда')
  assert.match(source, /useRef\(createNodeAspectTracker\(\)\)/)
  assert.match(
    source,
    /\}, \[effModel\?\.id, hasMediaRefs, data\.restoredAt\]\)/,
    'переход — смена модели и появление референса; отметка замены графа обязана перезапускать правило',
  )
  assert.doesNotMatch(source, /\}, \[[^\]]*params\?\.aspect/, 'пропорция в зависимостях возвращает авто на каждый выбор')
  // Правило живёт в теле ноды: у свёрнутой ноды панели модели нет.
  const picker = source.slice(source.indexOf('function ModelPicker'), source.indexOf('function ResultPreview'))
  assert.doesNotMatch(picker, /createNodeAspectTracker|nodeAspectStep|aspectForRefs/)
  assert.match(picker, /hasMediaRefs = hasImageRefs \|\| hasVideoRefs/, 'панель считает референсом и видео')
  assert.equal(picker.match(/settleNodeSeed\(/g)?.length, 2, 'оба засева новой модели проходят через правило')

  const graph = await readFile(new URL('./useNodesGraph.ts', import.meta.url), 'utf8')
  assert.equal(graph.match(/stampRestored\(/g)?.length, 2, 'отмена и возврат ставят отметку замены графа')
  assert.match(graph, /error: undefined,\s*restoredAt,/, 'и загрузка графа тоже')
})

// ⚠️ Жалоба 19.10.2026 со снимком: нода «Image», Grok Image HQ, два референса —
// а в «Пропорциях» нет «Авто». Сервер команды строил форму по операции без
// референса (там «Авто» нет), хотя операция «по референсам» его принимает.
// Форма ниже — ТОЧНО та, что приходит с сервера (пропорции с умолчанием 1:1,
// без «auto»); новый сервер добавляет к ней пометку `autoWithRefs`.
const HQ_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '19.5:9', '9:19.5', '9:20']
const grokHq = (autoWithRefs: boolean) => ({
  id: 'grok-image-hq', name: 'Grok Image HQ', kind: 'image', refs: true,
  params: [
    { ...select('aspect', '1:1', HQ_ASPECTS), label: 'Пропорции', ...(autoWithRefs ? { autoWithRefs: true } : {}) },
    { ...select('size', 'hd', ['hd', '2k']), label: 'Разрешение' },
  ],
}) as unknown as CatalogModel

test('Grok Image HQ сетевой доски: с референсом «Авто» в пропорциях есть, без него — нет', () => {
  const hq = grokHq(true)
  assert.equal(aspectOptions(hq, { aspect: '1:1' }, true, 'aspect')[0], 'auto', 'с референсом «Авто» стоит первым')
  assert.ok(!aspectOptions(hq, { aspect: '1:1' }, false, 'aspect').includes('auto'), 'без референса решать не по чему')
  // У разрешения «Авто» нет и у fal — его и не появляется.
  assert.ok(!aspectOptions(hq, { size: 'hd' }, true, 'size').includes('auto'))
})

test('Grok Image HQ: подключили референс — «Авто», сняли — снова 1:1', () => {
  const hq = grokHq(true)
  assert.deepEqual(nodeAspectStep(hq, { aspect: '1:1', size: 'hd' }, seen(hq, false), true), { aspect: 'auto', size: 'hd' })
  assert.deepEqual(nodeAspectStep(hq, { aspect: 'auto', size: 'hd' }, seen(hq, true), false), { aspect: '1:1', size: 'hd' })
  const chosen = { aspect: '3:2', size: '2k' }
  assert.equal(nodeAspectStep(hq, chosen, seen(hq, true), true), chosen, 'выбор человека при референсе цел')
})

test('прежний сервер без пометки — нода ведёт себя как раньше', () => {
  const old = grokHq(false)
  assert.ok(!aspectOptions(old, { aspect: '1:1' }, true, 'aspect').includes('auto'))
  const kept = { aspect: '1:1', size: 'hd' }
  assert.equal(nodeAspectStep(old, kept, seen(old, false), true), kept, '«auto», которого сервер не обещал, не пишем')
})

// ⚠️ 19.10.2026 у Grok Image сетевой доски из «Размера» убраны «Small» и «4K»:
// fal их не умеет, а сервер молча отдавал 1k и 2k. Сохранённый макрос с «4K»
// обязан это ПОКАЗАТЬ, а не прятать за первым пунктом списка.
test('сохранённое значение, которого в списке больше нет, видно как есть', () => {
  const grok = {
    id: 'grok-image', name: 'Grok Image', kind: 'image',
    params: [select('aspect', 'auto', ['auto', '1:1', '16:9']), select('size', 'auto', ['auto', 'hd', '2k'])],
  } as unknown as CatalogModel
  for (const hasMediaRefs of [false, true]) {
    const size = nodePanelParams(grok, { size: '4k' }, hasMediaRefs).find((param) => param.name === 'size')!
    const stale = size.options!.find((option) => option.value === '4k')
    assert.ok(stale, 'значение из макроса в списке')
    assert.match(stale.label, /not supported/u)
  }
  const saved = { aspect: 'auto', size: '4k' }
  assert.equal(nodeAspectStep(grok, saved, null, false), saved, 'открытие редактора значение не трогает')
  const honest = nodePanelParams(grok, { size: '2k' }, false).find((param) => param.name === 'size')!
  assert.deepEqual(honest.options!.map((option) => option.value), ['auto', 'hd', '2k'], 'честное значение список не раздувает')
})
