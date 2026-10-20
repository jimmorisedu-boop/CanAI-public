// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { ParamControls } from '../ui/ParamControls'
import { ACTION_LABEL, actionsForItem, actionsForMany } from './inspectorModel'
import { positionPopover, shouldUsePopoverSheet } from './TabletPopover'
import { TabletTopbar } from './TabletTopbar'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const image = (id = 'a'): CanvasItem => ({ id, kind: 'image', x: 0, y: 0, w: 100, h: 100 })

test('верхняя панель держит задачи и экспорт на виду в этом порядке', () => {
  const html = renderToStaticMarkup(createElement(TabletTopbar, {
    state: {
      boardName: 'Моя доска',
      saveNote: 'сохранено',
      selectionCount: 0,
      activeTasks: 0,
      multiSelect: false,
      canUndo: false,
      canRedo: false,
    },
    actions: {
      onExit() {}, onRename() {}, onUndo() {}, onRedo() {}, onAdd() {},
      onToggleSelect() {}, onTasks() {}, onExport() {},
      onTheme() {}, onHelp() {}, onSettings() {}, onFitAll() {}, onZoomActual() {},
    },
  }))
  const tasks = html.indexOf('>Tasks<')
  const exportAction = html.indexOf('>Export<')
  assert.ok(tasks >= 0, 'Tasks should be visible without opening a menu')
  assert.ok(exportAction > tasks, 'Export should follow Tasks')
})

test('тема iPad циклически меняется без открытия настроек', async () => {
  const theme = await import('./tabletTheme') as Record<string, unknown>
  const nextTheme = theme.nextTheme as ((value: string) => string) | undefined
  assert.equal(nextTheme?.('system'), 'light')
  assert.equal(nextTheme?.('light'), 'dark')
  assert.equal(nextTheme?.('dark'), 'system')
})

test('экспорт доски пропускает ссылочные карточки без файла', async () => {
  const boardActions = await import('./useBoardActions') as Record<string, unknown>
  const boardExportItems = boardActions.boardExportItems as ((items: CanvasItem[]) => CanvasItem[]) | undefined
  const link: CanvasItem = { id: 'link', kind: 'link', x: 0, y: 0, w: 100, h: 100 }
  assert.deepEqual(boardExportItems?.([image(), link]).map((item) => item.id), ['a'])
})

test('главное действие показывает название и цену одной строкой', async () => {
  const prompt = await import('./TabletPrompt') as Record<string, unknown>
  const tabletActionText = prompt.tabletActionText as ((
    label: string,
    amount: number | null,
    precision?: number,
    pricingMode?: 'fixed' | 'provider-cost' | 'fal-metered',
  ) => string) | undefined
  assert.equal(tabletActionText?.('Создать', 0.14), 'Создать · $0.14')
  assert.equal(tabletActionText?.('Создать', 2, 2, 'fal-metered'), 'Создать · up to $2.00')
  assert.equal(tabletActionText?.('Спросить', 0.047, 3), 'Спросить · $0.047')
  assert.equal(tabletActionText?.('Создать', null), 'Создать')
})

test('инспектор раскладывает действия по смысловым секциям', async () => {
  const model = await import('./inspectorModel') as Record<string, unknown>
  const actionSection = model.actionSection as ((action: string) => string) | undefined
  assert.equal(actionSection?.('crop'), 'edit')
  assert.equal(actionSection?.('view'), 'edit')
  assert.equal(actionSection?.('resize'), 'arrange')
  assert.equal(actionSection?.('duplicate'), 'arrange')
  assert.equal(actionSection?.('archive'), 'file')
  assert.equal(actionSection?.('delete'), 'danger')
})

test('закрытие popover возвращает фокус кнопке-источнику', async () => {
  const popover = await import('./TabletPopover') as Record<string, unknown>
  const scheduleFocusRestore = popover.scheduleFocusRestore as ((target: { focus(): void } | null, schedule: (run: () => void) => void) => void) | undefined
  let focused = false
  scheduleFocusRestore?.({ focus: () => { focused = true } }, (run) => run())
  assert.equal(focused, true)
})

test('сравнение появляется только у выбранной пары и объясняет действие', () => {
  assert.ok(!actionsForItem(image()).includes('compare'))
  assert.ok(actionsForMany([image('a'), image('b')]).includes('compare'))
  assert.equal(ACTION_LABEL.compare, 'Compare selected')
})

test('iPad называет полку ассетами', () => {
  assert.equal(ACTION_LABEL.pin, 'To assets')
})

test('popover остаётся на экране после изменения размера Split View', () => {
  const anchor = { left: 1100, right: 1144, top: 20, bottom: 64, width: 44, height: 44 }
  assert.deepEqual(
    positionPopover(anchor, { width: 232, height: 300 }, { width: 1180, height: 820 }, 'end'),
    { left: 912, top: 74 },
  )
  assert.deepEqual(
    positionPopover(anchor, { width: 232, height: 300 }, { width: 700, height: 520 }, 'end'),
    { left: 458, top: 74 },
  )
})

test('контекстное меню становится нижним листом, только когда места с обеих сторон нет', () => {
  const anchor = { left: 300, right: 344, top: 220, bottom: 264, width: 44, height: 44 }
  assert.equal(shouldUsePopoverSheet(anchor, 300, 520), true)
  assert.equal(shouldUsePopoverSheet(anchor, 180, 820), false)
})

test('шапка показывает основные действия словами и не возвращает экспорт по меткам', () => {
  const text = source('./TabletTopbar.tsx')
  assert.match(text, />\s*Add\s*</)
  assert.match(text, /state\.multiSelect \? 'Done' : 'Select'/)
  assert.match(text, />\s*Tasks\s*</)
  assert.match(text, /label="1:1"/)
  assert.doesNotMatch(text, /hasMarks|Экспорт по меткам/)
})

test('доска не рисует плавающую панель масштаба и всегда держит создание на виду', () => {
  const text = source('./TabletBoard.tsx')
  const canvas = source('./BoardCanvas.tsx')
  assert.doesNotMatch(text, /<TabletZoom|from '.\/TabletZoom'/)
  assert.doesNotMatch(text, /dockCollapsed|tablet-dock-toggle/)
  assert.match(text, /keyboardOpen/)
  assert.match(canvas, /selectionMode=\{Boolean\(multiSelect\)\}/)
  assert.match(text, /requestAnimationFrame\(apply\)/)
  assert.match(canvas, /follow\.resizeViewport\(next\)/)
  assert.match(canvas, /measuredViewport\.current = null/)
  assert.match(canvas, /fittedRef\.current = false/)
})

test('плавающий док не отрезает полосу холста по всей ширине', () => {
  const css = source('./tablet.css')
  const boardRule = css.match(/\.tablet-board\s*\{[^}]*\}/s)?.[0] ?? ''

  assert.match(boardRule, /inset:\s*0;/)
  assert.doesNotMatch(boardRule, /--tablet-dock-h/)
})

test('выделение оставляет создание доступным и показывает панель у объекта', () => {
  const board = source('./TabletBoard.tsx')
  assert.doesNotMatch(board, /compactDockForSelection|<TabletInspector|with-inspector/)
  assert.match(board, /<TabletContextBar/)
  assert.match(board, /<TabletPrompt/)
})

test('контекстная панель ограничена тремя действиями и безопасным архивом', () => {
  const text = source('./TabletContextBar.tsx')
  assert.match(text, /primary\.slice\(0, 3\)/)
  assert.match(text, /ACTION_LABEL/)
  assert.match(text, /В архив|archive/)
  assert.doesNotMatch(text, /'delete'/)
})

test('пустой архив не показывает неработающую панель массовых действий', () => {
  const text = source('./TabletArchive.tsx')
  assert.match(text, /footer=\{entries\.length > 0/)
  assert.match(text, /Back to board/)
})

test('пустое состояние архива не использует полноэкранный блокирующий слой', async () => {
  const archive = await import('./TabletArchive') as Record<string, unknown>
  const EmptyMessage = archive.TabletArchiveEmptyMessage as ComponentType<{ hasEntries: boolean }> | undefined
  assert.ok(EmptyMessage, 'пустое состояние должно быть отдельным компонентом архива')

  const html = renderToStaticMarkup(createElement(EmptyMessage, { hasEntries: false }))
  assert.match(html, /class="tablet-archive-empty"/)
  assert.doesNotMatch(html, /tablet-state/)
})

test('промпт iPad показывает макросы, помощников и цену вопроса', () => {
  const prompt = source('./TabletPrompt.tsx')
  const css = source('./tablet.css')
  assert.match(prompt, /<TabletMacros/)
  assert.match(prompt, /<TabletAssistantPresets/)
  assert.match(prompt, /<PriceBadge[\s\S]*chatEstimate/)
  assert.doesNotMatch(css, /\.tablet-macros\s*\{[^}]*flex-direction:\s*column/)
})

test('параметры модели на iPad сохраняют подписи и отдельные просторные ячейки', () => {
  const ComfortableParams = ParamControls as ComponentType<Record<string, unknown>>
  const html = renderToStaticMarkup(createElement(ComfortableParams, {
    params: [{
      name: 'resolution',
      label: 'Разрешение',
      widget: 'select',
      default: '720p',
      options: [{ value: '720p', label: '720p' }],
    }],
    values: {},
    onChange() {},
    compact: true,
    comfortable: true,
  }))

  assert.match(html, /param-controls compact comfortable/)
  assert.match(html, />Разрешение</)
})

test('основные настройки и макросы промпта лежат в разных строках', async () => {
  const prompt = await import('./TabletPrompt') as Record<string, unknown>
  const OptionRows = prompt.TabletPromptOptionRows as ComponentType<{
    controls: ReactNode
    macros: ReactNode
  }> | undefined
  assert.ok(OptionRows, 'строки настроек должны быть отдельным компонентом компоновки')

  const html = renderToStaticMarkup(createElement(OptionRows, {
    controls: createElement('span', null, 'Типы и варианты'),
    macros: createElement('span', null, 'Макросы'),
  }))
  assert.match(html, /tablet-prompt-primary-row[\s\S]*Типы и варианты/)
  assert.match(html, /tablet-prompt-macro-row[\s\S]*Макросы/)
})

test('планшет подключает общие правила фокуса и доступности', () => {
  const main = source('./main.tsx')
  const css = source('./tablet.css')
  assert.match(main, /styles\/focus\.css/)
  assert.match(main, /styles\/typography-motion\.css/)
  assert.match(css, /\.tablet-count button[\s\S]*border-radius:\s*50%/)
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/)
  assert.match(css, /@media \(prefers-contrast: more\)/)
})

test('задачи разделяют активные и недавние результаты', () => {
  const text = source('./TabletTasks.tsx')
  assert.match(text, /Generations · Active/)
  assert.match(text, /Started generations appear here/)
  assert.match(text, /No active tasks/)
  assert.doesNotMatch(text, /Nothing is counted/)
})

/**
 * ⚠️ Карточка упавшей генерации живёт в МИРОВЫХ координатах доски, поэтому её
 * крестик уменьшался вместе с холстом — на общем плане от кнопки оставалась
 * точка, в которую пальцем не попасть (жалоба 09.09.2026 «очень маленький
 * крестик у плашки, которая появляется, если генерация не получилась»).
 * Приём тот же, что у метки и кнопок видео: экранный размер держится обратным
 * масштабом, а начало отсчёта — угол карточки, иначе кнопка вылезает за край.
 */
test('крестик упавшей генерации держит палец, а не масштаб доски', () => {
  const view = source('./BoardItemView.tsx')
  const css = source('./tablet.css')
  const rule = css.match(/\.tablet-pending-close\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.match(view, /const screenScale = 1 \/ Math\.max\(scale, 0\.15\)/u)
  assert.match(
    view,
    /className="ui-icon-btn tablet-pending-close"[\s\S]{0,200}transform: `scale\(\$\{screenScale\}\)`/u,
    'крестик обязан считать свой размер экранным',
  )
  assert.match(rule, /height:\s*44px/, 'цель пальца на планшете — 44px')
  assert.match(rule, /transform-origin:\s*top right/)
  // Пальцем не наводят: у канона фон появляется по ховеру, а тут нужен в покое.
  assert.match(rule, /background:\s*var\(--surface-2\)/)
})

/**
 * ⚠️ У помощника на планшете не было ни одного способа начать разговор
 * заново: вкладка показывала ОДИН диалог — тот, что сервер отдал первым
 * (жалоба 14.09.2026 «нельзя сделать новый чат»). На компьютере этим заведует
 * шапка ленты; здесь та же работа одной строкой, но хранилище общее.
 */
test('у помощника на планшете заводится новый диалог и переключается старый', () => {
  const prompt = source('./TabletPrompt.tsx')
  const chats = source('./TabletAssistantChats.tsx')

  assert.match(prompt, /<TabletAssistantChats/, 'ряд диалогов должен стоять во вкладке помощника')
  assert.match(chats, /promptChatStore\.createConversation/)
  assert.match(chats, /promptChatStore\.selectConversation/)
  assert.match(chats, /aria-label="New conversation"/)
})

/**
 * ⚠️ Нажатие на кнопку уводит фокус из поля, iPad убирает клавиатуру, и полка
 * тут же переезжает вниз на её высоту — `click` приходит уже не на кнопку, а
 * человек видит, что «помощник не реагирует» (14.09.2026). Все остальные
 * кнопки этой полки давно гасят действие по умолчанию; главные — не гасили.
 *
 * Здесь же закреплён канон цены: она часть КНОПКИ (`paid-action`), а не
 * самостоятельная серая пилюля у правого края.
 */
test('главные кнопки полки держат нажатие при уходе клавиатуры и цену по канону', () => {
  const prompt = source('./TabletPrompt.tsx')
  const css = source('./tablet.css')

  const buttons = [...prompt.matchAll(
    /className="ui-btn primary tablet-create paid-action"([\s\S]*?)<\/button>/gu,
  )]
  assert.equal(buttons.length, 2, 'кнопок запуска две: «Создать» и «Спросить»')
  for (const [, body] of buttons) {
    assert.match(body, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/u)
    assert.match(body, /<PriceBadge[\s\S]*?variant="action"/u)
    assert.match(body, /className="tablet-action-label paid-action-label"/u)
  }

  assert.ok(
    !/\.tablet-action-price\s*\{/u.test(css),
    'своей коробки у цены внутри кнопки быть не должно — форму задаёт канон',
  )
  assert.match(css, /\.tablet-screen \.paid-action \.price-badge\.is-action\s*\{/u)
})

/** Написанное не пропадает от неудачной отправки, а отказ говорит словами. */
test('вопрос помощнику остаётся в поле, пока его не приняли', () => {
  const prompt = source('./TabletPrompt.tsx')
  const ask = prompt.match(/async function ask\(\)[\s\S]*?\r?\n {2}\}/u)?.[0] ?? ''

  assert.ok(ask, 'не найдена отправка вопроса помощнику')
  assert.ok(
    ask.indexOf('await askAssistant') < ask.indexOf("setPrompt('')"),
    'поле чистим только после того, как вопрос принят',
  )
  assert.match(ask, /catch[\s\S]*?setError\(/u, 'отказ показывается в панели, а не всплывашкой на две секунды')
})

/** Выбор модели диалога — такое же поле под палец, как все остальные. */
test('выбор модели диалога держит палец и не приближает страницу', () => {
  const css = source('./tablet.css')
  const rule = css.match(/\.tablet-assistant-model\s*\{([^}]*)\}/u)?.[1] ?? ''
  const fields = css.match(/\.tablet-screen select,[\s\S]*?\{([^}]*)\}/u)?.[1] ?? ''

  assert.match(rule, /min-height:\s*var\(--tablet-tap\)/u)
  // ⚠️ Ниже 16px Safari приближает страницу при фокусе. Правило общее для всех
  // полей планшета: приписками у каждого поля его дважды забывали.
  assert.match(fields, /font-size:\s*max\(16px/u)
})
