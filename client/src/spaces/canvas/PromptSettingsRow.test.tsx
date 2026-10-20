import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CatalogModel, ParamSpec } from '../../types'
import { PromptSettingsRow } from './PromptSettingsRow'
import { promptParamPresentation } from './promptParamPresentation'
import { ParamControls } from '../../ui/ParamControls'
import { changeParameter } from '../../../../packages/model-catalog/parameterRules'

const promptCss = readFileSync(new URL('../../styles/prompt-bar.css', import.meta.url), 'utf8')

/** Тело правила с РОВНО таким селектором (без соседей через запятую). */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = promptCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  assert.ok(body, `в prompt-bar.css нет правила ${selector}`)
  return body
}

const models: CatalogModel[] = [
  {
    id: 'image-base',
    name: 'Базовая модель',
    kind: 'image',
    refs: false,
    pairId: 'image-edit',
    params: [],
  },
  {
    id: 'image-edit',
    name: 'Модель по референсу',
    kind: 'image',
    refs: true,
    params: [],
  },
]

const panel: ParamSpec[] = [
  {
    name: 'aspect_ratio',
    label: 'Формат',
    widget: 'select',
    default: '1:1',
    options: [{ value: '1:1', label: '1:1' }],
  },
]

const h3Models: CatalogModel[] = [
  {
    id: 'minimax-h3',
    name: 'MiniMax H3 Max',
    kind: 'video',
    refs: false,
    params: [],
  },
]

const h3Panel: ParamSpec[] = [
  { name: 'resolution', label: 'Разрешение', widget: 'select', default: '768P', options: [{ value: '768P', label: '768P' }] },
  { name: 'duration', label: 'Длительность, сек', widget: 'slider', default: 5, min: 5, max: 15, step: 1 },
  { name: 'prompt_expansion_mode', label: 'Дополнять промпт', widget: 'select', default: 'balanced', options: [{ value: 'balanced', label: 'Сред.' }] },
  { name: 'enable_safety_checker', label: 'Фильтр безопасности', widget: 'boolean', default: true },
  { name: 'seed', label: 'Seed', widget: 'seed', default: -1 },
]

function render(
  layout: 'inline' | 'stacked' = 'inline',
  legacyEffectiveModel = false,
): string {
  // Передаём прежний prop намеренно: до удаления подсказки именно отличающийся
  // effModel включал её. Нынешний компонент игнорирует лишний compatibility-prop.
  const legacyProps = legacyEffectiveModel ? { effModel: models[1] } : {}
  return renderToStaticMarkup(
    <PromptSettingsRow
      models={models}
      kind="image"
      modelId="image-base"
      onModelChange={() => {}}
      count={1}
      onCountChange={() => {}}
      panel={panel}
      params={{ aspect_ratio: '1:1' }}
      onParamsChange={() => {}}
      hasMediaRefs
      imageReferenceCount={1}
      layout={layout}
      {...legacyProps}
    />,
  )
}

test('строка настроек не показывает пояснение об автоматической ref-модели', () => {
  const html = render('inline', true)

  assert.doesNotMatch(html, /gen-eff-hint/)
  assert.doesNotMatch(html, /включена/)
})

test('dock auto is an explicit choice and shows the resolved base model without price', () => {
  const html = renderToStaticMarkup(
    <PromptSettingsRow
      models={models}
      kind="image"
      modelId="__canai_auto_model__"
      onModelChange={() => {}}
      count={1}
      onCountChange={() => {}}
      panel={panel}
      params={{ aspect_ratio: '1:1' }}
      onParamsChange={() => {}}
      hasMediaRefs
      imageReferenceCount={1}
      autoEnabled
      autoModelName={models[1].name}
      modelTitle="Модель по референсу (вариант) · $0.123"
    />,
  )

  assert.match(html, /<option value="__canai_auto_model__" selected="">Auto · Модель по референсу<\/option>/u)
  assert.match(html, /title="Модель по референсу \(вариант\) · \$0\.123"/u)
  assert.doesNotMatch(html, /сохранённый выбор/u)
})

test('на узкой панели параметры переносятся и остаются видимыми без горизонтального скролла', () => {
  const html = render()
  const row = cssRule('.gen-controls-secondary.is-inline')

  assert.match(html, /class="gen-controls-secondary is-inline"/)
  assert.match(row, /flex-wrap:\s*wrap/)
  assert.match(row, /width:\s*100%/)
  assert.match(row, /min-width:\s*0/)
  assert.doesNotMatch(row, /overflow-x:/)
  assert.match(html, /class="param-controls compact labelled"/)
  assert.match(html, /<span class="param-label">Format<\/span>/)
  assert.match(html, /aria-label="Format"/)
})

// Жалоба 02.10.2026 со снимком: под рядом настроек GPT Image 2.5 появилась
// полоса прокрутки. Ряд был на 19 px шире панели — каждая «пилюля» растянута
// по самому длинному пункту своего списка, а не по выбранному значению.
test('у обычной строки нет полосы прокрутки, а пилюли облегают выбранное значение', () => {
  assert.doesNotMatch(cssRule('.gen-controls-secondary.is-inline'), /overflow-x:\s*auto/)
  assert.match(
    promptCss,
    /\.gen-controls-secondary\.is-inline \.gen-select,\s*\.gen-controls-secondary\.is-inline \.param-controls\.compact select\.param-input\s*\{[^}]*field-sizing:\s*content/,
  )
  // Список моделей — единственный, кому есть куда сжаться: он уступает место
  // раньше, чем строка начнёт уезжать за край.
  const model = cssRule('.gen-controls-secondary.is-inline .gen-select')
  assert.match(model, /flex:\s*0 1 auto/)
  assert.match(model, /min-width:\s*\d+px/)
})

// Полосы нет, поэтому спрятанное за краем обязано выдавать себя иначе: за
// краем остаются параметры, которые уйдут в оплаченную генерацию.
test('параметры не обрезаются маской у края панели', () => {
  assert.doesNotMatch(promptCss, /\.gen-controls-secondary\.is-inline\[data-fade=/)
})

test('компактная строка остаётся вертикальной и не получает горизонтальную прокрутку', () => {
  const html = render('stacked')

  assert.match(html, /class="gen-controls-secondary is-stacked"/)
  assert.doesNotMatch(html, /is-inline/)
  assert.doesNotMatch(html, /flex-wrap:nowrap/)
})

test('MiniMax H3 показывает длительность коротким выпадающим списком', () => {
  const html = renderToStaticMarkup(
    <PromptSettingsRow
      models={h3Models}
      kind="video"
      modelId="minimax-h3"
      onModelChange={() => {}}
      count={1}
      onCountChange={() => {}}
      panel={h3Panel}
      params={{ duration: 5, prompt_expansion_mode: 'balanced', seed: -1 }}
      onParamsChange={() => {}}
      hasMediaRefs={false}
      imageReferenceCount={0}
    />,
  )

  assert.doesNotMatch(html, /type="range"/)
  assert.match(html, /class="param-controls compact labelled"/)
  assert.match(html, /aria-expanded="false"[^>]*title="Additional model parameters"/)
  assert.doesNotMatch(html, /data-param-name="seed"/)
  assert.doesNotMatch(html, /data-param-name="enable_safety_checker"/)
  assert.match(html, /<option value="5" selected="">5 sec<\/option>/)
  assert.match(html, /<option value="15">15 sec<\/option>/)
})

test('сетевой видеопараметр длительности выглядит как локальный список, но остаётся числом', () => {
  const html = renderToStaticMarkup(
    <PromptSettingsRow
      models={[{ id: 'cloud-video', name: 'Видео', kind: 'video', refs: false, params: [] }]}
      kind="video"
      modelId="cloud-video"
      onModelChange={() => {}}
      count={1}
      onCountChange={() => {}}
      panel={[{ name: 'duration', label: 'Длительность, с', widget: 'number', default: 5, min: 3, max: 10, step: 1 }]}
      params={{ duration: 5 }}
      onParamsChange={() => {}}
      hasMediaRefs={false}
      imageReferenceCount={0}
      projectSource="cloud"
    />,
  )
  assert.doesNotMatch(html, /type="number"/)
  assert.match(html, /<option value="5" selected="">5 sec<\/option>/)
  assert.match(html, /<option value="10">10 sec<\/option>/)
})

test('длинная шкала сетевой модели остаётся слайдером, а не сотней пунктов меню', () => {
  const html = renderToStaticMarkup(
    <PromptSettingsRow
      models={[{ id: 'cloud-video', name: 'Видео', kind: 'video', refs: false, params: [] }]}
      kind="video"
      modelId="cloud-video"
      onModelChange={() => {}}
      count={1}
      onCountChange={() => {}}
      panel={[{ name: 'duration', label: 'Длительность', widget: 'slider', default: 30, min: 1, max: 100, step: 1 }]}
      params={{ duration: 30 }}
      onParamsChange={() => {}}
      hasMediaRefs={false}
      imageReferenceCount={0}
      projectSource="cloud"
    />,
  )
  assert.match(html, /type="range"/)
  assert.doesNotMatch(html, /<option value="100">/)
})

test('локальная и сетевая длительности используют одинаковую форму без переименования API-поля', () => {
  const local: ParamSpec[] = [{ name: 'duration', label: 'Длительность, сек', widget: 'slider', default: 5, min: 3, max: 10, step: 1 }]
  const cloud: ParamSpec[] = [{ ...local[0], label: 'Duration', widget: 'number' }]
  assert.deepEqual(promptParamPresentation(local, { duration: 5 }), promptParamPresentation(cloud, { duration: 5 }))
  const custom = promptParamPresentation([{ ...cloud[0], name: 'custom__duration' }], { custom__duration: 7 })
  assert.deepEqual(custom.primaryNames, ['custom__duration'])
  assert.equal(custom.displayParams[0].name, 'custom__duration')
  const markup = (projectSource: 'local' | 'cloud', schema: ParamSpec[]) => renderToStaticMarkup(
    <PromptSettingsRow models={h3Models} kind="video" modelId="minimax-h3" onModelChange={() => {}}
      count={1} onCountChange={() => {}} panel={schema} params={{ duration: 5 }} onParamsChange={() => {}}
      hasMediaRefs={false} imageReferenceCount={0} projectSource={projectSource} />,
  )
  assert.equal(markup('local', local), markup('cloud', cloud))
})

test('редкие параметры остаются редактируемыми; раскрытие не теряет custom-поля или значения enum', () => {
  const specs: ParamSpec[] = [
    ...panel,
    { name: 'output_format', label: 'Формат файла', widget: 'select', default: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }] },
    { name: 'custom__mode', label: 'Режим', widget: 'select', default: 'auto', options: [{ value: 'auto', label: 'Авто' }, { value: '2', label: 'Второй' }] },
    { name: 'custom__description', label: 'Описание', widget: 'textarea', default: '' },
  ]
  const values = { output_format: 'webp', custom__mode: '2', custom__description: 'Сохранить персонажа' }
  const view = promptParamPresentation(specs, values)
  assert.deepEqual(view.primaryNames, ['aspect_ratio'])
  assert.deepEqual(view.secondaryNames, ['output_format', 'custom__mode', 'custom__description'])
  assert.equal(view.changedSecondary, 3)
  const html = renderToStaticMarkup(<ParamControls params={view.displayParams} visibleNames={view.secondaryNames} values={values} onChange={() => {}} />)
  assert.match(html, /value="webp" selected=""/)
  assert.match(html, /value="2" selected=""/)
  assert.match(html, /Сохранить персонажа/)
  assert.doesNotMatch(html, /data-param-name="aspect_ratio"/)
})

test('условные параметры в «Ещё» учитывают дефолты и изменения полей основного ряда', () => {
  const specs: ParamSpec[] = [
    { name: 'quality', label: 'Качество', widget: 'select', default: 'high', options: [{ value: 'high', label: 'Высокое' }, { value: 'low', label: 'Низкое' }] },
    { name: 'custom__detail', label: 'Детали', widget: 'number', default: 3, activeWhen: { name: 'quality', values: ['high'] } },
  ]
  const initial = promptParamPresentation(specs, {})
  assert.deepEqual(initial.secondaryNames, ['custom__detail'])
  const html = renderToStaticMarkup(<ParamControls params={initial.displayParams} visibleNames={initial.secondaryNames} values={{}} onChange={() => {}} />)
  assert.match(html, /data-param-name="custom__detail"/)
  const next = changeParameter(initial.displayParams, { custom__detail: 8 }, 'quality', 'low')
  assert.equal(next.custom__detail, undefined)
  assert.deepEqual(promptParamPresentation(specs, next).secondaryNames, [])
})

test('основные контролы идут в одном порядке независимо от порядка параметров каталога', () => {
  const specs: ParamSpec[] = [
    { name: 'duration', label: 'Длительность', widget: 'select', options: [{ value: 'auto', label: 'auto' }, { value: '5', label: '5' }] },
    { name: 'resolution', label: 'Разрешение', widget: 'select', options: [{ value: '720p', label: '720p' }] },
    ...panel,
  ]
  const renderParams = (source: ParamSpec[]) => {
    const view = promptParamPresentation(source, {})
    return renderToStaticMarkup(<ParamControls params={view.displayParams} visibleNames={view.primaryNames} values={{}} onChange={() => {}} compact compactLabels />)
  }
  const html = renderParams(specs)
  assert.equal(html, renderParams([...specs].reverse()))
  assert.match(html, /value="auto">Auto<\/option>/)
  assert.match(html, /value="5">5 sec<\/option>/)
})

// Жалоба 19.10.2026: «More» раскрывал форму «подпись + широкий список» в две
// колонки, и вёрстка промпт-бара слетала. Раскрытое — те же пилюли, что ряд.
test('раскрытые по More параметры рисуются теми же пилюлями, что и ряд над ними', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./PromptSettingsRow.tsx', import.meta.url), 'utf8')
  const expanded = source.slice(source.indexOf('className="gen-params-expanded"'))
  const block = expanded.slice(0, expanded.indexOf('/>'))
  assert.match(block, /<ParamControls\s+compact\s+compactLabels/)
  // текстовые параметры — не пилюлей: в ней фраза не помещается, и терялся «Развернуть»
  assert.match(source, /visibleNames=\{secondaryPills\}/)
  const texts = source.slice(source.indexOf('secondaryTexts.length > 0 && ('))
  assert.doesNotMatch(texts.slice(0, texts.indexOf('/>')), /compact/)
  const css = readFileSync(new URL('../../styles/prompt-bar.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /\.gen-params-expanded \.param-controls \{[^}]*display: grid/)
})
