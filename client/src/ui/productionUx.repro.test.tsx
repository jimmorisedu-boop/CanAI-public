import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BillingHistoryModal } from '../BillingHistoryModal.js'
import { SettingsModal, shouldCloseSettingsAfterSave } from '../settings/SettingsModal.js'
import { ShortcutsModal } from '../ShortcutsModal.js'
import { falBalancePresentation } from './falBalancePresentation.js'
import './feedbackComponents.test.js'

function assertSemanticDialog(html: string, title: RegExp): void {
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /aria-labelledby="[^"]+"/)
  assert.match(html, title)
}

test('настройки имеют доступный dialog-контракт', () => {
  assertSemanticDialog(
    renderToStaticMarkup(<SettingsModal hint={null} onClose={() => {}} />),
    /Settings/,
  )
})

test('удаление ключа оставляет настройки открытыми и сохраняет элемент управления', () => {
  assert.equal(shouldCloseSettingsAfterSave(true), false)
  assert.equal(shouldCloseSettingsAfterSave(false), true)

  const html = renderToStaticMarkup(<SettingsModal hint={null} section="generation" onClose={() => {}} />)
  assert.match(html, /<button[^>]*disabled[^>]*>No key<\/button>/)
})

test('раздел fal.ai содержит четыре дефолта и новый мастер без JSON-редактора', () => {
  const sections = readFileSync(new URL('../settings/settingsSections.ts', import.meta.url), 'utf8')
  const defaults = readFileSync(new URL('../settings/ModelDefaultsCard.tsx', import.meta.url), 'utf8')
  const catalog = readFileSync(new URL('../settings/ModelCatalogList.tsx', import.meta.url), 'utf8')
  const wizard = readFileSync(new URL('../settings/FalModelWizard.tsx', import.meta.url), 'utf8')
  const source = [sections, defaults, catalog, wizard].join('\n')

  assert.match(source, /fal\.ai and models/)
  for (const label of ['Image', 'Video', 'Audio', 'Assistant']) assert.match(defaults, new RegExp(`label: '${label}'`))
  assert.match(catalog, /Add model/)
  assert.doesNotMatch(source, /Custom parameter description|New model JSON description/)
})

// ⚠️ Панель разложена по разделам (жалоба 26.08.2026: «слишком громоздкая»),
// поэтому каждый раздел рисуется отдельно. Сторож следит, чтобы содержимое не
// потерялось при переносе и чтобы диагностика по-прежнему была отделена.
const settingsHtml = (section: Parameters<typeof SettingsModal>[0]['section']) =>
  renderToStaticMarkup(<SettingsModal hint={null} section={section} onClose={() => {}} />)

test('каждый раздел настроек говорит о целях пользователя', () => {
  const general = settingsHtml('general')
  assert.match(general, /class="settings-primary"/)
  assert.match(general, /Navigation/)
  assert.match(general, /value="mouse"/)
  assert.match(general, /value="touchpad"/)
  assert.match(general, /Behavior/)

  const generation = settingsHtml('generation')
  assert.match(generation, /fal\.ai connection/)
  assert.match(generation, /Checking settings…/)

  const editor = settingsHtml('editor')
  assert.match(editor, /Image editor/)
  assert.match(editor, />Choose app<\/button>/)
  assert.match(editor, /Full path to program/)

  assert.doesNotMatch(general, /Системный промпт помощника|Помощник по умолчанию/)

  assert.match(settingsHtml('components'), /Video and audio processing|Face comparison/)
})

// Раздел выбирается боковым списком, и в него можно попасть из подсказки.
test('в окне есть список разделов, а не одна длинная лента', () => {
  const html = settingsHtml('general')
  assert.match(html, /class="settings-nav"/)
  assert.match(html, /aria-label="Settings sections"/)
  // Открыт «Общие» — соседних разделов на экране нет.
  assert.doesNotMatch(html, /fal\.ai connection/)
  assert.doesNotMatch(html, /Image editor/)

  // Подсказка ведёт прямо в нужный раздел.
  assert.match(settingsHtml('editor'), /Image editor/)
})

test('диагностика отделена от основного блока в каждом разделе', () => {
  for (const section of ['general', 'generation', 'editor', 'components', 'remote'] as const) {
    const html = settingsHtml(section)
    const primary = html.match(/<div class="settings-primary">([\s\S]*?)<\/div><\/div>/)?.[1] ?? html
    const withoutDetails = primary.replace(/<details[\s\S]*?<\/details>/g, '')
    assert.doesNotMatch(
      withoutDetails,
      /CANAI_MOCK=1|server\/\.env|C:\\Program Files/,
      `${section}: техническая деталь оказалась в основном потоке`,
    )
  }

  // Сами «Технические детали» на месте — свёрнутые.
  for (const section of ['generation', 'editor'] as const) {
    const html = settingsHtml(section)
    assert.match(html, /<details[^>]*class="settings-technical"/, `${section}: нет блока технических деталей`)
    assert.match(html, /<summary[^>]*aria-expanded="false"[^>]*>Technical details<\/summary>/)
  }
})

test('в настройках прокручивается только содержимое, а действия остаются видимыми', () => {
  const settingsCss = readFileSync(new URL('../styles/settings.css', import.meta.url), 'utf8')
  const compactCss = readFileSync(new URL('../styles/compact.css', import.meta.url), 'utf8')

  assert.match(settingsCss, /\.settings-modal\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto[^}]*max-height:[^;}]*100dvh[^}]*overflow:\s*hidden/s)
  assert.match(settingsCss, /\.settings-body\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(settingsCss, /\.settings-actions\s*\{[^}]*border-top:[^}]*background:\s*var\(--surface-solid\)/s)
  assert.match(settingsCss, /\.settings-section\s*\{/)
  assert.match(settingsCss, /\.settings-connection\[data-tone=['"]success['"]\]\s*\{[^}]*var\(--ok\)/s)
  assert.match(settingsCss, /\.settings-connection\[data-tone=['"]warning['"]\]\s*\{[^}]*var\(--warn-text\)/s)
  assert.match(settingsCss, /\.settings-technical summary:focus-visible/)
  assert.match(settingsCss, /\.settings-technical:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{[^}]*display:\s*none/s)
  assert.match(compactCss, /\.settings-editor-actions[\s\S]*?min-height:\s*var\(--compact-target\)/)
  assert.match(compactCss, /\.settings-modal input:not\(\[type="checkbox"\]\)[\s\S]*?min-height:\s*var\(--compact-target\)/)
})

// Подсказка приходит от того, кто сюда отправил («нужен ключ», «укажи
// редактор»), — это продолжение уже показанной плашки. Раньше та же мысль
// звучала здесь четвёртым видом: заливка --warn-soft во всю ширину.
test('подсказка в настройках говорит на языке общей плашки', () => {
  const html = renderToStaticMarkup(
    <SettingsModal hint="Вставь ключ fal.ai — и генерации заработают." onClose={() => {}} />,
  )
  assert.match(html, /class="inline-notice settings-hint"/)
  assert.match(html, /data-tone="info"/)
  assert.match(html, /Вставь ключ fal\.ai/)
})

test('справка по клавишам имеет доступный dialog-контракт', () => {
  assertSemanticDialog(
    renderToStaticMarkup(<ShortcutsModal onClose={() => {}} />),
    /Keyboard shortcuts/,
  )
})

test('история расходов имеет доступный dialog-контракт', () => {
  assertSemanticDialog(
    renderToStaticMarkup(
      <BillingHistoryModal
        balance={null}
        currency="USD"
        onClose={() => {}}
        onRefreshBalance={() => {}}
      />,
    ),
    /Transaction history/,
  )
})

test('глобальный канал ошибок отличает ошибку от обычного сообщения', async () => {
  const bus = await import('../spaces/canvas/toastBus.js')
  const showErrorToast = (
    bus as typeof bus & { showErrorToast?: (message: string) => void }
  ).showErrorToast
  assert.equal(typeof showErrorToast, 'function')

  let received: { kind: string; message: string } | null = null
  const unsubscribe = bus.onToast((event) => {
    if (event.type === 'show') received = event.toast
  })
  try {
    showErrorToast?.('Не удалось загрузить модели')
  } finally {
    unsubscribe()
  }

  const actual = received as { kind: string; message: string } | null
  assert.deepEqual(actual && { kind: actual.kind, message: actual.message }, {
    kind: 'error',
    message: 'Could not load models.',
  })
})

test('глобальный канал публикует адресное закрытие без создания нового toast', async () => {
  const bus = await import('../spaces/canvas/toastBus.js')
  const received: unknown[] = []
  const unsubscribe = bus.onToast((event) => received.push(event))
  try {
    bus.dismissToast('generation-result-navigation')
    bus.dismissToast('generation-result-navigation')
  } finally {
    unsubscribe()
  }

  assert.deepEqual(received, [
    { type: 'dismiss', replaceKey: 'generation-result-navigation' },
    { type: 'dismiss', replaceKey: 'generation-result-navigation' },
  ])
})

test('модальный фокус переходит внутрь и возвращается к прежнему элементу', async () => {
  const module = await import('./dialogFocus.js').catch(() => null)
  if (!module) throw new Error('нужен единый контроллер фокуса модальных окон')

  let insideFocused = 0
  let previousFocused = 0
  const inside = { focus: () => { insideFocused++ } }
  const previous = { focus: () => { previousFocused++ } }
  const dialog = {
    querySelector: () => inside,
    focus: () => { insideFocused++ },
  }

  const restore = module.activateDialog(
    dialog as unknown as HTMLElement,
    previous as unknown as HTMLElement,
  )
  assert.equal(insideFocused, 1)
  restore()
  assert.equal(previousFocused, 1)
})

test('перерисовка модального окна не перезапускает захват фокуса', () => {
  const source = readFileSync(new URL('./dialogFocus.ts', import.meta.url), 'utf8')

  assert.match(source, /const onCloseRef = useRef\(onClose\)/)
  assert.match(source, /onCloseRef\.current = onClose/)
  assert.match(source, /onCloseRef\.current\(\)/)
  assert.doesNotMatch(source, /\[dialogRef, onClose\]/)
})

test('верхняя панель не сообщает об отсутствующем ключе в демо-режиме', () => {
  assert.deepEqual(
    falBalancePresentation({
      mockMode: true,
      balance: null,
      currency: 'USD',
      errorMsg: 'FAL_KEY не установлен',
    }),
    {
      label: 'Demo',
      tooltip: 'Demo mode: paid fal.ai calls are disabled',
    },
  )
})

test('верхняя панель распознаёт отсутствие ключа в английской и русской ошибке', () => {
  for (const errorMsg of ['fal.ai key is not configured', 'FAL_KEY не установлен']) {
    assert.equal(
      falBalancePresentation({ mockMode: false, balance: null, currency: 'USD', errorMsg }).label,
      'No key',
    )
  }
})
