import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readAllStyles } from '../testStyles'
import './controlVerticalAlignment.test.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('брендовая палитра различает акцент и ошибку и сохраняет контраст в обеих темах', () => {
  const tokens = read('../styles/tokens.css')
  const brand = read('../../../DESIGN.md')
  const dark = /:root\s*\{([^}]+)\}/s.exec(tokens)![1]
  const light = /:root\[data-theme='light'\]\s*\{([^}]+)\}/s.exec(tokens)![1]
  const value = (block: string, key: string) => new RegExp(`--${key}:\\s*([^;]+);`).exec(block)?.[1].trim()
  const brandValue = (key: string) => new RegExp(`^  ${key}: '([^']+)'`, 'm').exec(brand)![1]
  const luminance = (hex: string) => {
    const rgb = hex.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const contrast = (foreground: string, background: string) => {
    const a = luminance(foreground), b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  assert.equal(value(dark, 'accent'), brandValue('accent'))
  assert.equal(value(light, 'accent'), brandValue('accent'))
  assert.equal(value(dark, 'danger'), brandValue('danger-dark'))
  assert.equal(value(light, 'danger'), brandValue('danger'))
  assert.equal(value(dark, 'danger-fill'), brandValue('danger-fill'))
  assert.ok(contrast(value(dark, 'danger')!, value(dark, 'surface-solid')!) >= 4.5)
  assert.ok(contrast(value(light, 'danger')!, '#ffffff') >= 4.5)
  assert.ok(contrast('#ffffff', value(dark, 'danger-fill')!) >= 4.5)
  assert.ok(contrast('#ffffff', value(dark, 'accent')!) >= 4.5)
})

// Канон рабочих элементов: общая форма кнопок описана один раз (controls.css),
// и проверять её в каждом файле — значит требовать обратно тот разнобой,
// ради которого канон и заводили.
const canonSource = read('../styles/controls.css')
function canonCovers(selector: string): boolean {
  return canonSource.split('}').some((block) => (
    block.includes(selector) && /(?:height|min-height):\s*var\(--control-h-/.test(block)
  ))
}

// Шрифт и токены темы живут в tokens.css — его подключают и приложение,
// и гостевая страница публикации.

test('desktop and iPad share Onest UI type and JetBrains Mono technical type', () => {
  const tokens = read('../styles/tokens.css')
  const base = read('../styles/base.css')
  const tablet = read('../tablet/tablet.css')
  const canvasFonts = read('../spaces/canvas/konva/fonts.ts')

  assert.match(tokens, /--font-sans:\s*'Onest'/)
  assert.match(tokens, /--font-mono:\s*'JetBrains Mono'/)
  assert.match(tokens, /font-family:\s*'Onest'/)
  assert.match(tokens, /font-family:\s*'JetBrains Mono'/)
  assert.match(base, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s)
  assert.match(tablet, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s)
  assert.match(canvasFonts, /CANVAS_SANS_FONT\s*=\s*'Onest/)
  assert.match(canvasFonts, /CANVAS_MONO_FONT\s*=\s*'"JetBrains Mono"/)

  for (const file of [
    'onest-latin.woff2',
    'onest-cyrillic.woff2',
    'jetbrains-mono-latin.woff2',
    'jetbrains-mono-cyrillic.woff2',
    'OFL-Onest.txt',
    'OFL-JetBrains-Mono.txt',
  ]) {
    const url = new URL(`../../public/fonts/${file}`, import.meta.url)
    assert.ok(existsSync(url), `missing self-hosted font asset ${file}`)
    assert.ok(statSync(url).size > 0, `empty self-hosted font asset ${file}`)
  }
})

test('working UI does not reintroduce arbitrary radii or fractional tiny type', () => {
  const css = readAllStyles()
  assert.doesNotMatch(css, /font-size:\s*(?:9(?:\.5)?|10(?:\.5)?|11\.5|12\.5|13\.5)px/)

  const numericRadii = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((match) => match[1].trim())
    .filter((value) => /\dpx/.test(value))
  assert.deepEqual(numericRadii, [], `numeric radii must use semantic tokens: ${numericRadii.join(', ')}`)
})

test('design system exposes one compact typography and spacing rhythm', () => {
  const css = read('../styles/tokens.css')
  for (const token of [
    '--font-ui-xs: var(--text-micro)',
    '--font-ui-sm: var(--text-secondary)',
    '--font-ui-md: var(--text-control)',
    '--control-h-sm: var(--control-h-standard)',
    '--control-h-md: var(--control-h-emphasis)',
    '--space-2: 8px',
    '--space-3: 12px',
    '--space-4: 16px',
  ]) assert.ok(css.includes(token), `missing ${token}`)
})

test('professional product controls expose semantic geometry and type roles', () => {
  const css = read('../styles/tokens.css')
  for (const token of [
    '--radius-panel: 16px',
    '--radius-control: 10px',
    '--radius-compact: 8px',
    '--radius-pill: 999px',
    '--control-h-compact: 32px',
    '--control-h-standard: 36px',
    '--control-h-emphasis: 44px',
    '--text-panel-title: 16px',
    '--text-body: 14px',
    '--text-control: 13px',
    '--text-secondary: 12px',
    '--text-micro: 11px',
  ]) assert.ok(css.includes(token), `missing ${token}`)
})

test('one-line native controls share a vertical-centering contract', () => {
  const base = read('../styles/base.css')
  const appButton = base.match(/:where\(button:not\(\[data-control-layout='stack'\]\)\)\s*\{([^}]*)\}/)?.[1] ?? ''

  for (const rule of [appButton]) {
    assert.match(rule, /display:\s*inline-flex/)
    assert.match(rule, /align-items:\s*center/)
    assert.match(rule, /line-height:\s*1/)
  }
  assert.match(base, /--control-height:\s*var\(--control-h-standard\)/)
  assert.match(base, /select:not\(\[multiple\]\)[\s\S]*?height:\s*var\(--control-height\)[\s\S]*?padding-block:\s*0[\s\S]*?line-height:\s*1/)
  assert.match(base, /button:not\(\[data-control-layout='stack'\]\)\)\s*>\s*svg\s*\{[^}]*flex:\s*none/s)
})

test('topbar and prompt dock use controls by semantic role', () => {
  const topbar = read('../styles/topbar.css')
  const prompt = read('../styles/prompt-bar.css')
  const params = read('../styles/price-params.css')
  assert.match(
    topbar,
    /\.tab\s*\{[^}]*height:\s*var\(--control-h-compact\)[^}]*border-radius:\s*var\(--radius-control\)/s,
  )
  assert.match(
    topbar,
    /\.theme-toggle-btn\s*,\s*\.share-topbar-button\s*\{[^}]*min-width:\s*var\(--control-h-compact\)[^}]*height:\s*var\(--control-h-compact\)[^}]*border-radius:\s*var\(--radius-control\)/s,
  )
  assert.match(
    topbar,
    /\.fal-balance-btn\s*\{[^}]*height:\s*var\(--control-h-compact\)[^}]*border-radius:\s*var\(--radius-pill\)/s,
  )
  assert.match(
    prompt,
    /\.prompt-bar\s*\{[^}]*border-radius:\s*var\(--radius-panel\)[^}]*padding:\s*var\(--space-4\)/s,
  )
  assert.match(
    prompt,
    /\.macros-inline-btn\s*\{[^}]*width:\s*var\(--control-h-emphasis\)[^}]*height:\s*var\(--control-h-emphasis\)[^}]*border-radius:\s*var\(--radius-control\)/s,
  )
  assert.match(
    prompt,
    /\.gen-controls-secondary[\s\S]*?border-radius:\s*var\(--radius-compact\)/,
  )
  assert.match(
    params,
    /\.generate\s*\{[^}]*border-radius:\s*var\(--radius-control\)[^}]*height:\s*var\(--control-h-emphasis\)[^}]*font-size:\s*var\(--text-control\)/s,
  )
})

test('prompt controls center labels without vertical padding growth', () => {
  const prompt = read('../styles/prompt-bar.css')
  const controls = read('../styles/price-params.css')
  const params = read('../styles/node-params.css')
  const secondarySelect = prompt.match(/\.gen-controls-secondary \.gen-select\s*\{([^}]*)\}/)?.[1] ?? ''
  const compactRow = params.match(/\.param-controls\.compact \.param-row\s*\{([^}]*)\}/)?.[1] ?? ''
  const compactInput = params.match(/\.param-controls\.compact \.param-input\s*\{([^}]*)\}/)?.[1] ?? ''
  const paidAction = controls.match(/(?:^|\n)\.paid-action\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.match(secondarySelect, /height:\s*var\(--control-h-compact\)/)
  assert.match(secondarySelect, /padding:\s*0\s+9px/)
  assert.match(compactRow, /height:\s*var\(--control-h-compact\)/)
  assert.match(compactRow, /align-items:\s*center/)
  assert.match(compactRow, /padding:\s*0\s+6px\s+0\s+10px/)
  assert.match(compactInput, /height:\s*100%/)
  assert.match(compactInput, /padding:\s*0\s+4px/)
  assert.match(paidAction, /line-height:\s*1/)
})

test('archive assets and task center share panel and control geometry', () => {
  const archive = read('../styles/archive.css')
  const tasks = read('../styles/task-center.css')
  assert.match(
    archive,
    /\.archive-modal\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s,
  )
  assert.match(
    archive,
    /\.archive-sort\s*\{[^}]*height:\s*var\(--control-h-standard\)[^}]*border-radius:\s*var\(--radius-control\)/s,
  )
  // Размер у панели свой (рабочий инструмент, а не форма настроек), а форма
  // общая: скругление кнопки живёт в каноне, а не здесь.
  assert.match(
    archive,
    /\.archive-toolbar-actions \.generate,[\s\S]*?height:\s*var\(--control-h-standard\)/,
  )
  assert.ok(canonCovers('.editor-close'), 'кнопки архива берут форму из канона')
  assert.match(
    archive,
    /\.asset-slot\s*\{[^}]*border-radius:\s*var\(--radius-control\)/s,
  )
  assert.match(
    tasks,
    /\.task-center-panel\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s,
  )
  assert.ok(canonCovers('.task-center-actions button'), 'общая геометрия для .task-center-actions button должна жить в controls.css')
})

test('settings billing export and compare use professional controls', () => {
  const settings = read('../styles/settings.css')
  const billing = read('../styles/billing.css')
  const notices = read('../styles/notices.css')
  const compare = read('../styles/compare.css')
  assert.match(
    settings,
    /\.settings-modal\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s,
  )
  // «Отмена», «Проверить», «Скачать» — то же обычное действие, что и везде:
  // своя геометрия делала их единственными прямоугольниками среди пилюль.
  assert.ok(canonCovers('.editor-close'), 'обычное действие настроек берёт форму из канона')
  assert.match(
    billing,
    /\.billing-history-modal\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s,
  )
  assert.match(
    notices,
    /\.export-panel\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s,
  )
  assert.ok(canonCovers('.export-panel-actions button'), 'экспорт берёт форму из канона')
  assert.ok(canonCovers('.export-panel-actions button'), 'общая геометрия для .export-panel-actions button должна жить в controls.css')
  assert.ok(canonCovers('.compare-modes button'), 'режимы сравнения берут форму сегмента из канона')
})

test('comparison overlay uses aligned glass islands without moving the hint', () => {
  const compare = read('../styles/compare.css')
  const viewer = read('../spaces/canvas/compare/CompareViewer.tsx')
  const overlayRule = compare.match(/\.compare-overlay\s*\{([^}]*)\}/)?.[1] ?? ''
  const headRule = compare.match(/\.compare-head\s*\{([^}]*)\}/)?.[1] ?? ''
  const mainRule = compare.match(/\.compare-head-main\s*\{([^}]*)\}/)?.[1] ?? ''
  const hintRule = compare.match(/\.compare-hint\s*\{([^}]*)\}/)?.[1] ?? ''
  const restingHintRule = compare.match(/\.compare-overlay\.is-resting\s+\.compare-hint\s*\{([^}]*)\}/)?.[1] ?? ''

  // Текст читается на любом кадре за счёт собственных overlay-токенов, а не
  // темы приложения. Полноширинного затемняющего градиента больше нет.
  for (const token of ['--text', '--text-2', '--text-3', '--border', '--border-strong', '--surface-3']) {
    assert.match(overlayRule, new RegExp(`${token}:`), `${token} должен быть локальным токеном overlay`)
  }
  assert.match(headRule, /top:\s*18px/)
  assert.match(headRule, /left:\s*18px/)
  assert.match(headRule, /right:\s*18px/)
  assert.match(headRule, /background:\s*transparent/)
  assert.doesNotMatch(headRule, /linear-gradient/)

  assert.match(mainRule, /border-radius:\s*var\(--radius-panel\)/)
  assert.match(mainRule, /background:\s*var\(--material-thick\)/)
  assert.match(mainRule, /backdrop-filter:\s*blur\(/)

  // Нижняя подсказка использует ту же ось 18 px и согласованный r-md. В покое
  // меняется только opacity — любой translate снова ломает выравнивание.
  assert.match(hintRule, /left:\s*18px/)
  assert.match(hintRule, /bottom:\s*18px/)
  assert.match(hintRule, /transform:\s*none/)
  assert.match(hintRule, /border-radius:\s*var\(--radius-control\)/)
  assert.match(restingHintRule, /opacity:/)
  assert.doesNotMatch(restingHintRule, /transform:/)
  assert.match(viewer, /is-resting/)
  assert.match(viewer, /setControlsResting/)
  assert.match(viewer, /compare-hint-item/)
  assert.match(compare, /\.compare-hint-item\s*\{/)
})

test('settings fields resolve to the standard control height without padding growth', () => {
  const css = read('../styles/settings.css')
  const fieldRule = css.match(/\.settings-modal input:not\(\[type="checkbox"\]\),\s*\n\.settings-modal select\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(fieldRule, /height:\s*var\(--control-h-standard\)/)
  assert.match(fieldRule, /padding:\s*0\s+14px/)
  assert.doesNotMatch(fieldRule, /min-height:/)
})

test('gallery and auxiliary surfaces use semantic geometry and whole type roles', () => {
  const css = [
    read('../styles/gallery.css'),
    read('../styles/notices.css'),
    read('../styles/diagnostics.css'),
    read('../styles/onboarding.css'),
    read('../styles/assistant.css'),
    read('../styles/assistant-chat.css'),
  ].join('\n')
  assert.ok(css.includes('var(--radius-panel)'))
  assert.ok(css.includes('var(--radius-control)'))
  assert.ok(css.includes('var(--control-h-standard)'))
  assert.doesNotMatch(
    css,
    /font-size:\s*(?:9(?:\.5)?|10(?:\.5)?|11\.5|12\.5|13\.5)px/,
  )
  assert.doesNotMatch(css, /border-radius:\s*(?:2|4|5|6|7|10|12|18)px/)
})

test('macro editor controls follow shared geometry without styling graph ports', () => {
  const toolbar = read('../styles/nodes-space.css')
  const params = read('../styles/node-params.css')
  const details = read('../styles/node-details.css')
  const library = read('../styles/macro-library.css')
  assert.ok(canonCovers('.node-add-btn'), 'общая геометрия для .node-add-btn должна жить в controls.css')
  assert.ok(params.includes('var(--radius-control)'))
  assert.ok(details.includes('var(--radius-control)'))
  assert.match(library, /\.macro-lib\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/s)
  assert.doesNotMatch(toolbar, /\.react-flow__handle[^}]*border-radius:\s*var\(--radius-control\)/s)
})

test('audited floating panels consume shared rhythm tokens', () => {
  const css = [
    read('../styles/archive.css'),
    read('../styles/macro-library.css'),
    read('../styles/task-center.css'),
    read('../styles/notices.css'),
  ].join('\n')
  // ⚠️ Проверяем СЕМАНТИЧЕСКИЕ имена, а не короткие: короткие помечены в
  // tokens.css как «совместимость на время поэтапной миграции», и миграция
  // доведена до конца 21.08.2026 — в стилях остался один словарь. Сами
  // псевдонимы в tokens.css живут дальше, на них может опираться чужой код.
  assert.ok(css.includes('var(--control-h-standard)'))
  assert.ok(css.includes('var(--text-control)'))
  assert.ok(css.includes('var(--space-3)'))
})

test('task center keeps the branded typeface and shared spacing rhythm', () => {
  const css = read('../styles/task-center.css')
  const panelRule = css.match(/\.task-center-panel\s*\{([^}]*)\}/)?.[1] ?? ''
  const mainRule = css.match(/\.task-launch-main\s*\{([^}]*)\}/)?.[1] ?? ''
  const actionsRule = css.match(/\.task-launch-group-actions\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.match(panelRule, /font-family\s*:\s*var\(--font-sans\)/)
  assert.match(mainRule, /gap\s*:\s*var\(--space-2\)/)
  assert.match(mainRule, /padding\s*:\s*var\(--space-3\)\s+0/)
  assert.doesNotMatch(actionsRule, /padding-(?:left|top)\s*:\s*\d+px/)
  assert.match(
    css,
    /@media \(max-width: 520px\)[\s\S]*?\.compact-topbar-tasks \.task-center-panel\s*\{[\s\S]*?position\s*:\s*static[\s\S]*?width\s*:\s*100%/,
  )
})

test('archive cards rely on bounded paging instead of broken grid content visibility', () => {
  const archiveCss = readFileSync(new URL('../styles/archive.css', import.meta.url), 'utf8')
  const cardRule = archiveCss.match(/\.archive-card\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.doesNotMatch(cardRule, /content-visibility\s*:\s*auto/)
  assert.doesNotMatch(cardRule, /contain-intrinsic-size/)
  assert.match(cardRule, /aspect-ratio\s*:\s*1\s*\/\s*1/)
  assert.match(archiveCss, /\.archive-grid\s*\{[^}]*grid-auto-rows\s*:\s*max-content/s)
})

test('macro slots match the square media toggles and use letters without slot numbers', () => {
  const promptCss = readFileSync(new URL('../styles/prompt-bar.css', import.meta.url), 'utf8')
  const controlsCss = readFileSync(new URL('../styles/price-params.css', import.meta.url), 'utf8')
  const compactCss = readFileSync(new URL('../styles/compact.css', import.meta.url), 'utf8')
  const promptMacros = readFileSync(new URL('../spaces/canvas/PromptMacros.tsx', import.meta.url), 'utf8')
  const assistantPresets = readFileSync(new URL('../spaces/canvas/AssistantPresets.tsx', import.meta.url), 'utf8')
  const slotRule = promptCss.match(/\.macros-inline-btn\s*\{([^}]*)\}/)?.[1] ?? ''
  const moreRule = promptCss.match(/\.macros-inline-btn\.more\s*\{([^}]*)\}/)?.[1] ?? ''
  const nameRule = promptCss.match(/\.macro-slot-name\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.match(slotRule, /width\s*:\s*var\(--control-h-emphasis\)/)
  assert.match(slotRule, /height\s*:\s*var\(--control-h-emphasis\)/)
  assert.match(moreRule, /width\s*:\s*var\(--control-h-emphasis\)/)
  assert.match(nameRule, /font-size\s*:\s*var\(--text-micro\)/)
  assert.match(nameRule, /font-weight\s*:\s*600/)
  assert.doesNotMatch(compactCss, /\.macro-control\s+\.macros-inline-btn\s*\{[^}]*width\s*:\s*72px/s)
  assert.doesNotMatch(promptMacros, /macro-slot-num/)
  assert.doesNotMatch(assistantPresets, /macro-slot-num/)
  // Рост держит сама дорожка (она в рост кнопки запуска), а сегменты занимают
  // её изнутри: иначе отступы дорожки прибавлялись бы к росту главного ряда.
  assert.match(controlsCss, /\.kind-toggle\s*\{[^}]*height\s*:\s*var\(--control-h-emphasis\)/s)
  assert.ok(canonCovers('.kind-toggle button'), 'форма сегмента типа генерации — из канона')
  assert.match(controlsCss, /\.generate\s*\{[^}]*height\s*:\s*var\(--control-h-emphasis\)/s)
  assert.match(controlsCss, /\.ask\s*\{[^}]*height\s*:\s*var\(--control-h-emphasis\)/s)
})

test('draft macro slots keep the same visual surface as runnable slots', () => {
  const controlsCss = read('../styles/price-params.css')
  const draftRule = controlsCss.match(/\.macros-inline-btn\.draft\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.doesNotMatch(draftRule, /background\s*:/)
  assert.doesNotMatch(draftRule, /color\s*:/)
  assert.doesNotMatch(draftRule, /border(?:-color|-style)?\s*:/)
})
