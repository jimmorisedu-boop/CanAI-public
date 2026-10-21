import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readAllStyles } from '../../testStyles'

test('помощник — второе окно того же промпт-бара, а не колонка', () => {
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const actionDock = readFileSync(new URL('./ActionDock.tsx', import.meta.url), 'utf8')
  const canvasSpace = readFileSync(new URL('./CanvasSpace.tsx', import.meta.url), 'utf8')

  const bar = promptBar.indexOf('prompt-bar ${isFocused')
  // Роль у переключателя — group, а не tablist: панели под «вкладками» нет,
  // поле ввода у обоих окон общее (см. accessibility.test). Разметка вкладок
  // вынесена в ActionDock, поэтому проверяем и host, и общий компонент.
  const tabs = promptBar.indexOf('<ActionDockModeTabs', bar)
  const shelf = promptBar.indexOf('<AssistantShelf', tabs)
  assert.ok(bar >= 0, 'не найден промпт-бар')
  assert.ok(tabs > bar, 'вкладки должны быть внутри бара')
  assert.ok(shelf > tabs, 'лента помощника показывается под вкладками')
  assert.match(actionDock, /role="group" aria-label=\{t\('Mode'\)\}/)
  assert.match(actionDock, /aria-pressed={mode === 'make'}/)

  assert.ok(!canvasSpace.includes('PromptChatPanel'), 'отдельной колонки быть не должно')
  assert.ok(!canvasSpace.includes('has-prompt-chat'), 'канвас не должен сжиматься из-за чата')
})

test('окна взаимоисключающие: параметры генерации не висят над разговором', () => {
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')

  // Секция и сам ряд настроек остаются единичными и целиком скрываются в чате.
  // Компактное раскрытие не должно создавать второй экземпляр состояния.
  assert.match(promptBar, /\{mode === 'make' && \(\s*<PromptSettingsSection[\s\S]*?<PromptSettingsRow/)
  assert.match(promptBar, /\{mode === 'make' && \(\s*<button\s+className="generate paid-action"/)
  assert.match(promptBar, /className="ask paid-action"[\s\S]*?<PriceBadge[\s\S]*variant="action"/)
  assert.match(promptBar, /className="generate paid-action"[\s\S]*?<PriceBadge[\s\S]*variant="action"/)
  assert.match(promptBar, /className="paid-action-label">\{t\('Send'\)\}</)
  // Подпись в Make зависит от операции: обычное «Создать» или пакетное
  // «Изменить N изображений». Семантика и числа проверяются в ActionDock.test.
  assert.match(promptBar, /className="paid-action-label">\{createLabel === 'Generate' \? t\('Generate'\) : createLabel\}</)
  assert.match(promptBar, /amount=\{chatEstimate\?\.costUsd \?\? null\}/)
  assert.doesNotMatch(promptBar, /chatEstimate\?\.costUsd != null && \(\s*<PriceBadge/)
  assert.doesNotMatch(promptBar, /className="ask-action-group"/)
})

test('платные действия держат подпись и лаконичную цену на одной строке', () => {
  const styles = readAllStyles()
  const paidAction = styles.match(/(?:^|\n)\.paid-action\s*\{([^}]+)\}/)?.[1]
  const actionPrice = styles.match(/\.paid-action \.price-badge\.is-action\s*\{([^}]+)\}/)?.[1]

  assert.match(paidAction ?? '', /align-items:\s*center/)
  assert.match(paidAction ?? '', /height:\s*var\(--control-h-emphasis\)/)
  assert.match(actionPrice ?? '', /border-left:/)
  assert.match(actionPrice ?? '', /line-height:\s*1/)
  assert.match(styles, /\.ask\.paid-action\s*\{[\s\S]*?background:\s*var\(--accent\)/)
})

test('в окне помощника — переключатели помощников, а не нодовые цепочки', () => {
  // Решение пользователя 18.08.2026: скрипт из нод здесь был лишней сложностью.
  // Кнопка теперь включает модель с её инструкциями и документами.
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')

  assert.match(promptBar, /<AssistantPresets/)
  assert.doesNotMatch(promptBar, /cascade|Cascade/, 'машинерия цепочек не должна вернуться')
})

test('канвас не сжимается: отдельная панель не отнимает ширину', () => {
  const styles = readAllStyles()

  assert.ok(
    !/\.canvas-workspace\.has-prompt-chat\s*\{/.test(styles),
    'правило сжатия канваса под колонку должно отсутствовать',
  )
  const shelf = styles.match(/\.assistant-shelf\s*\{([^}]+)\}/)?.[1]
  assert.ok(shelf, 'не найден стиль окна помощника')
  assert.match(shelf, /max-height:\s*70vh/)
})

test('drawer остаётся компактным и не возвращает старое подтверждение нового диалога', () => {
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const assistantShelf = readFileSync(new URL('./AssistantShelf.tsx', import.meta.url), 'utf8')
  const styles = readAllStyles()
  const drawer = styles.match(/\.prompt-chat-drawer\s*\{([^}]+)\}/)?.[1]
  const head = styles.match(/\.assistant-shelf-head\s*\{([^}]+)\}/)?.[1]

  assert.match(drawer ?? '', /width:\s*min\(290px,\s*86%\)/)
  assert.match(head ?? '', /min-height:\s*48px/)
  assert.ok(!promptBar.includes("window.confirm('Начать новый диалог?"))
  assert.ok(!assistantShelf.includes('archives'))
  assert.ok(!promptBar.includes('compilePromptChatRequest'))
  assert.ok(!styles.includes('.prompt-chat-history'))
})

test('индикатор помощника виден на вкладке как минимальная точка', () => {
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const actionDock = readFileSync(new URL('./ActionDock.tsx', import.meta.url), 'utf8')
  const styles = readAllStyles()

  assert.match(promptBar, /<ActionDockModeTabs[\s\S]*signal=\{signal\}/)
  assert.match(actionDock, /className="pane-signal"/)
  assert.match(actionDock, /title=\{signalLabel/)
  assert.ok(styles.includes('.pane-signal'), 'не найден стиль индикатора')
  assert.ok(
    styles.includes('.pane-tabs button.signal-ready'),
    'готовый ответ должен подсвечивать вкладку',
  )
})

test('ассеты по-прежнему закреплены справа', () => {
  const styles = readAllStyles()
  const assetBarRule = styles.match(/\.asset-bar\s*\{([^}]+)\}/)?.[1]
  const assetSlotsRule = styles.match(/\.asset-slots-grid\s*\{([^}]+)\}/)?.[1]

  assert.match(assetBarRule ?? '', /right:\s*16px/)
  assert.match(assetSlotsRule ?? '', /flex-wrap:\s*wrap/)
  assert.match(assetSlotsRule ?? '', /align-content:\s*flex-end/)
  assert.match(assetSlotsRule ?? '', /align-items:\s*flex-end/)
})

test('на 768 px действия шапки становятся иконками и не растягивают страницу', () => {
  const styles = readAllStyles()
  const mobile = styles.slice(styles.indexOf('@media (max-width: 899px)'))

  assert.match(mobile, /\.assistant-button,[\s\S]*\.settings-button/)
  assert.match(mobile, /\.canvas-export-btn[\s\S]*width:\s*34px/)
  assert.match(mobile, /\.canvas-export-btn span[\s\S]*display:\s*none/)
  assert.match(mobile, /\.fal-balance-val[\s\S]*display:\s*none/)
})

// ⚠️ «В строку» обязана назначать порядок референсов из подсказки. Без этого
// выигрывает память промпт-бара (orderedIdsRef), а она считается ещё и по
// выделению канваса — и рефы возвращаются переставленными. Промпт при этом
// адресует их по номерам, так что перестановка меняет смысл задания.
test('«В строку» назначает порядок референсов из подсказки, а не наследует', () => {
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const takeOver = promptBar.indexOf('if (takeOverRefs) {')
  assert.ok(takeOver > 0, 'не найдена ветка захвата референсов')
  const block = promptBar.slice(takeOver, takeOver + 900)
  assert.match(
    block,
    /orderedIdsRef\.current = canvasComposerRef\.current\.refs\.map\(\(ref\) => ref\.shapeId\)/,
    'порядок подсказки должен назначаться явно',
  )
})

