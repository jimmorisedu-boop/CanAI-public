// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
// @ts-expect-error Тесты проверяют договор исходника без DOM-рантайма.
import { readFileSync } from 'node:fs'

import * as viewportModel from './visualViewportModel'
import React from 'react'
import { usePromptFieldHeight } from './usePromptFieldHeight'
import { usePromptDock } from './usePromptDock'
import { bindTabletKeyboardButton } from './tabletKeyboardButton'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('queued prompt dock measurements survive a board handoff', () => {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previousDispatcher = internals.ReactCurrentDispatcher.current
  const previousWindow = (globalThis as any).window
  const previousObserver = globalThis.ResizeObserver
  const previousStyle = globalThis.getComputedStyle
  const effects: Array<() => (() => void)> = []
  let queuedMeasure: (() => void) | undefined
  let disconnected = false
  const bodyNode = { clientWidth: 1024, clientHeight: 768 }
  const dockNode = { getBoundingClientRect: () => ({ height: 160 }) }
  const body = { current: bodyNode } as any
  const dock = { current: dockNode } as any
  ;(globalThis as any).window = {
    localStorage: { getItem: () => null },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.getComputedStyle = ((node: unknown) => {
    assert.equal(node, dockNode, 'a queued measurement must receive the observed element')
    return { getPropertyValue: () => '1' }
  }) as any
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { queuedMeasure = callback }
    observe() {}
    disconnect() { disconnected = true }
  } as any
  internals.ReactCurrentDispatcher.current = {
    useState: (initial: any) => {
      let value = typeof initial === 'function' ? initial() : initial
      return [value, (next: any) => { value = typeof next === 'function' ? next(value) : next }]
    },
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => (() => void)) => effects.push(effect),
  }
  let cleanup: (() => void) | undefined
  try {
    usePromptDock(dock, body, 0, true)
    cleanup = effects[0]()
    assert.ok(queuedMeasure)
    body.current = null
    dock.current = null
    assert.doesNotThrow(() => queuedMeasure!())
    cleanup()
    cleanup = undefined
    assert.equal(disconnected, true)
  } finally {
    cleanup?.()
    internals.ReactCurrentDispatcher.current = previousDispatcher
    if (previousWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previousWindow
    globalThis.ResizeObserver = previousObserver
    globalThis.getComputedStyle = previousStyle
  }
})

test('ручка поля растёт вверх и учитывает масштаб панели и пределы экрана', () => {
  assert.equal(viewportModel.promptFieldHeightFromDrag(44, -100, 1, 320), 144)
  assert.equal(viewportModel.promptFieldHeightFromDrag(44, -100, 0.5, 320), 244)
  assert.equal(viewportModel.promptFieldHeightFromDrag(144, 200, 1, 320), 44)
  assert.equal(viewportModel.promptFieldHeightFromDrag(144, -500, 0.5, 220), 220)
})

test('ручка поля захватывает один указатель и прекращает растяжение при щипке и отмене', () => {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previousDispatcher = internals.ReactCurrentDispatcher.current
  const previousWindow = (globalThis as any).window
  const previousStyle = globalThis.getComputedStyle
  let currentHeight: number | null = null
  let expandCount = 0
  const listeners = new Map<string, () => void>()
  const effects: Array<() => (() => void)> = []
  ;(globalThis as any).window = {
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => '0.5' })) as any
  internals.ReactCurrentDispatcher.current = {
    useState: () => [currentHeight, (value: number) => { currentHeight = value }],
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => (() => void)) => effects.push(effect),
  }
  let cleanup: (() => void) | undefined
  try {
    const field = { current: { getBoundingClientRect: () => ({ height: 22 }) } } as any
    const { handle } = usePromptFieldHeight(field, 320, () => { expandCount++ })
    cleanup = effects[0]()
    const captured: number[] = []
    const pointer = (id: number, y: number, primary = true) => ({
      pointerId: id, clientY: y, button: 0, isPrimary: primary,
      preventDefault() {}, currentTarget: { setPointerCapture: (value: number) => captured.push(value) },
    }) as any
    handle.onPointerDown(pointer(1, 400))
    handle.onPointerDown(pointer(2, 390, false))
    handle.onPointerMove(pointer(2, 200, false))
    assert.equal(currentHeight, 44)
    assert.deepEqual(captured, [1])
    assert.equal(expandCount, 1)
    handle.onPointerMove(pointer(1, 350))
    assert.equal(currentHeight, 144)
    listeners.get('canai-tablet-ui-scale')!()
    handle.onPointerMove(pointer(1, 250))
    assert.equal(currentHeight, 144, 'щипок не должен одновременно растягивать поле')
    handle.onPointerDown(pointer(3, 400))
    handle.onPointerCancel()
    handle.onPointerUp(pointer(3, 300))
    assert.equal(currentHeight, 44, 'отменённый указатель не завершает resize')
  } finally {
    cleanup?.()
    internals.ReactCurrentDispatcher.current = previousDispatcher
    if (previousWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previousWindow
    globalThis.getComputedStyle = previousStyle
  }
  assert.equal(listeners.size, 0)
})

/**
 * ⚠️ Клавиатуру зовёт ТОЛЬКО кнопка клавиатуры (просьба 09.09.2026, повторная:
 * 'клавиатура все еще появляется когда нажимаешь в поле промпта, а должна по
 * нажатию на иконку клавиатуры'). Прежний тест закреплял обратное — что поле
 * тоже начинает ввод, — то есть защищал ровно ту помеху, на которую жалуются.
 *
 * ⚠️ Одного правила мало: поле ввода фокусируется касанием само, мимо наших
 * обработчиков. Пока ввод не разрешён, поле стоит `readOnly` — читать и
 * прокручивать написанное можно, клавиатуру Safari при этом не поднимает.
 */
test('клавиатуру поднимает только её кнопка, а поле до этого только читают', () => {
  const focusesTextarea = viewportModel.promptFocusesTextarea as
    ((trigger: 'panel' | 'keyboard' | 'textarea' | 'editor') => boolean) | undefined

  assert.equal(focusesTextarea?.('panel'), false)
  assert.equal(focusesTextarea?.('editor'), false)
  assert.equal(focusesTextarea?.('textarea'), false)
  assert.equal(focusesTextarea?.('keyboard'), true)

  const prompt = source('./TabletPrompt.tsx')
  assert.match(prompt, /readOnly=\{!typingArmed\}/u, 'поле закрыто для ввода, пока его не открыли')
  assert.doesNotMatch(prompt, /onBlur=\{\(\) => setTypingArmed\(false\)\}/u, 'временный уход фокуса к системной клавиатуре не закрывает ввод')
  assert.doesNotMatch(prompt, /addEventListener\('pointerdown', leaveEditor/u, 'системное управление клавиатурой не должно выключать редактируемость глобальным обработчиком')
  assert.match(prompt, /aria-label="Model for this conversation"/u)
  assert.match(prompt, /promptChatStore\.setModel\(promptChatProjectId, event.target.value\)/u)
  const keyboardStart = prompt.indexOf('tablet-prompt-keyboard')
  const keyboardButton = prompt.slice(keyboardStart, prompt.indexOf('<IconKeyboard', keyboardStart))
  assert.ok(keyboardStart >= 0 && keyboardButton.length > 0, 'кнопка клавиатуры должна существовать')
  const keyboardHandler = prompt.slice(prompt.indexOf('return bindTabletKeyboardButton'), prompt.indexOf('const { models }'))
  assert.match(keyboardHandler, /setTypingArmed\(true\)/u)
  // Состояние React доедет только следующим кадром, а фокус нужен в этом же
  // жесте: без снятия запрета прямо на узле клавиатура не поднимется.
  assert.match(keyboardHandler, /field\.readOnly = false[\s\S]*field\.focus\(/u)
  assert.match(keyboardHandler, /field\.blur\(\)[\s\S]*field\.readOnly = true/u, 'повторное нажатие закрывает клавиатуру')
})

test('клавиатура активируется в native touchend один раз, а щипок и отмена не открывают её', () => {
  const listeners = new Map<string, (event: any) => void>()
  const scopeListeners = new Map<string, () => void>()
  const options = new Map<string, any>()
  const button = { disabled: false,
    addEventListener: (name: string, fn: (event: any) => void, option: any) => { listeners.set(name, fn); options.set(name, option) },
    removeEventListener: (name: string) => listeners.delete(name),
  } as any
  const scope = { addEventListener: (name: string, fn: () => void) => scopeListeners.set(name, fn), removeEventListener: (name: string) => scopeListeners.delete(name) } as any
  let activations = 0
  const cleanup = bindTabletKeyboardButton(button, () => activations++, scope)
  const touch = { clientX: 10, clientY: 10 }
  let prevented = false
  const end = { touches: [], preventDefault() { prevented = true } }
  try {
    assert.equal(options.get('touchend').passive, false)
    listeners.get('touchstart')!({ touches: [touch] })
    listeners.get('touchend')!(end)
    assert.equal(activations, 1, 'активация синхронна исходному touchend')
    assert.equal(prevented, true)
    listeners.get('click')!({ detail: 1, preventDefault() {} })
    assert.equal(activations, 1, 'совместимый click не закрывает только что открытую клавиатуру')
    listeners.get('touchstart')!({ touches: [touch] })
    listeners.get('touchend')!(end)
    assert.equal(activations, 2, 'следующий настоящий тап вызывает закрытие')
    listeners.get('touchstart')!({ touches: [touch] })
    scopeListeners.get('canai-tablet-ui-scale')!()
    listeners.get('touchend')!(end)
    assert.equal(activations, 2)
    listeners.get('touchstart')!({ touches: [touch] })
    listeners.get('touchcancel')!({})
    listeners.get('touchend')!(end)
    assert.equal(activations, 2)
    listeners.get('click')!({ detail: 0, preventDefault() {} })
    assert.equal(activations, 3, 'клавиатурная активация кнопки доступна')
  } finally { cleanup() }
  assert.equal(listeners.size + scopeListeners.size, 0)
})

/**
 * ⚠️ 'Мимо' — это мимо САМОГО меню, а не мимо всей полки промпта (просьба
 * 09.09.2026: 'настройка моделей должна прятаться при любом клике мимо неё,
 * даже если в окно промпта'). Кнопка модели — единственное исключение: она
 * читает состояние на click и иначе открывала бы меню заново.
 */
test('меню параметров закрывается касанием мимо него, включая поле промпта', () => {
  const prompt = source('./TabletPrompt.tsx')
  const handler = prompt.slice(
    prompt.indexOf('const onPointerDown = (event: PointerEvent)'),
    prompt.indexOf('const onKeyDown = (event: KeyboardEvent)'),
  )

  assert.ok(handler.length > 0, 'обработчик касания мимо меню должен существовать')
  assert.match(handler, /settingsPopRef\.current/u)
  assert.doesNotMatch(handler, /promptRef\.current/u)
  assert.match(handler, /modelBtnRef\.current\?\.contains\(/u)
})

test('переход фокуса внутри inline меню модели не сворачивает промпт', () => {
  const disposition = viewportModel.promptBlurDisposition as
    ((input: {
      settingsOpen: boolean
      relatedTargetInside: boolean
      activeElementInside: boolean
    }) => 'keep' | 'collapse') | undefined

  assert.equal(disposition?.({ settingsOpen: true, relatedTargetInside: false, activeElementInside: false }), 'keep')
  assert.equal(disposition?.({ settingsOpen: false, relatedTargetInside: true, activeElementInside: true }), 'keep')
  assert.equal(disposition?.({ settingsOpen: false, relatedTargetInside: false, activeElementInside: false }), 'collapse')
})

test('первый тап по модели раскрывает меню вместе со свернутым dock', async () => {
  const promptSource = source('./TabletPrompt.tsx')
  const modelButtonStart = promptSource.indexOf('tablet-model-btn')
  const modelButtonEnd = promptSource.indexOf('\n          >', modelButtonStart)
  const modelButton = promptSource.slice(modelButtonStart, modelButtonEnd)
  assert.ok(modelButtonStart >= 0, 'кнопка модели должна существовать')
  assert.match(
    modelButton,
    /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/u,
    'кнопка модели не должна менять геометрию dock до click',
  )

  const prompt = await import('./TabletPrompt') as Record<string, unknown>
  const modelButtonAction = prompt.tabletModelButtonAction as
    ((expanded: boolean, settingsOpen: boolean) => { expanded: boolean; settingsOpen: boolean }) | undefined

  assert.deepEqual(modelButtonAction?.(false, false), { expanded: true, settingsOpen: true })
  assert.deepEqual(modelButtonAction?.(true, false), { expanded: true, settingsOpen: true })
  assert.deepEqual(modelButtonAction?.(true, true), { expanded: true, settingsOpen: false })
})

test('TabletPrompt подключает scoped CSS и имеет явные контролы ввода/раскрытия', () => {
  const prompt = source('./TabletPrompt.tsx')
  const main = source('./main.tsx')

  assert.match(main, /import ['"]\.\/tabletPrompt\.css['"]/u)
  assert.match(prompt, /tablet-prompt-keyboard/)
  assert.match(prompt, /Show keyboard/)
  assert.match(prompt, /tablet-prompt-disclosure/)
  assert.doesNotMatch(prompt, /autoFocus/)
})

test('меню параметров получает верхнюю позицию, если над доком нет места', () => {
  const prompt = source('./TabletPrompt.tsx')
  const css = source('./tabletPrompt.css')

  assert.match(prompt, /settingsPlacement/)
  assert.match(prompt, /--tablet-settings-top/)
  assert.match(prompt, /visualViewport/)
  assert.match(css, /\.tablet-settings-pop\.viewport-top[\s\S]*top: var\(--tablet-settings-top/)
  assert.match(css, /\.tablet-settings-pop\.viewport-top[\s\S]*max-height: min\(54vh, var\(--tablet-settings-max-height/)
})

test('scoped CSS ограничивает панель по viewport и оставляет вторичные секции за раскрытием', () => {
  const css = source('./tabletPrompt.css')

  assert.match(css, /\.tablet-prompt-scroll[\s\S]*overflow-y:\s*auto/)
  assert.match(css, /--tablet-prompt-visible-height/)
  assert.match(css, /\.tablet-prompt\.collapsed[\s\S]*#tablet-panel-assistant/)
  assert.match(css, /\.tablet-prompt\.viewport-keyboard-open[\s\S]*#tablet-panel-assistant/)
})

test('появление клавиатуры не меняет камеру планшетной доски', () => {
  const board = source('./TabletBoard.tsx')
  assert.doesNotMatch(
    board,
    /if \(!visualViewport\.keyboardOpen[\s\S]{0,500}store\.setCamera\(/,
  )
})
