import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_KEY,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_MIN_SPREAD_PX,
  clampUiScale,
  pinchTargetsChrome,
  pinchedUiScale,
  readUiScale,
  roundUiScale,
  writeUiScale,
} from './uiScale.js'
import { adjustTabletUiScale, useTabletUiScale } from './useTabletUiScale.js'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

function mountTabletScaleHook(storage: any) {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const dispatched: any[] = []
  const styleValues = new Map<string, string>()
  const fakeWindow: any = {
    localStorage: storage,
    addEventListener(name: string, listener: (event: any) => void) {
      const current = listeners.get(name) ?? new Set<(event: any) => void>()
      current.add(listener)
      listeners.set(name, current)
    },
    removeEventListener(name: string, listener: (event: any) => void) {
      listeners.get(name)?.delete(listener)
    },
    dispatchEvent(event: any) {
      dispatched.push(event)
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
  }
  const fakeDocument: any = {
    documentElement: { style: { setProperty(name: string, value: string) { styleValues.set(name, value) } } },
  }
  const previousWindow = (globalThis as any).window
  const previousDocument = (globalThis as any).document
  ;(globalThis as any).window = fakeWindow
  ;(globalThis as any).document = fakeDocument

  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previousDispatcher = internals.ReactCurrentDispatcher.current
  const effects: Array<() => void | (() => void)> = []
  internals.ReactCurrentDispatcher.current = { useEffect: (effect: () => any) => effects.push(effect) }
  try {
    useTabletUiScale()
  } finally {
    internals.ReactCurrentDispatcher.current = previousDispatcher
  }
  const cleanup = effects[0]?.()
  const restore = () => {
    cleanup?.()
    if (previousWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previousWindow
    if (previousDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = previousDocument
  }
  return {
    styleValues,
    dispatched,
    emit(name: string, event: any) {
      for (const listener of listeners.get(name) ?? []) listener(event)
    },
    restore,
  }
}

/**
 * ⚠️ Зум страницы у Safari несимметричен: приблизить щипком можно, а уменьшить
 * меньше ста процентов нельзя — страница уже вписана в ширину экрана. Со
 * стороны это и выглядит так, будто интерфейс только растёт (жалоба
 * 09.09.2026: «когда делается щипок на интерфейсе, интерфейс не только
 * увеличивался, но и уменьшался»). Поэтому масштаб свой, и он ходит в обе
 * стороны от единицы.
 */
test('щипок меняет масштаб в обе стороны и упирается в свои пределы', () => {
  assert.ok(UI_SCALE_MIN < UI_SCALE_DEFAULT && UI_SCALE_DEFAULT < UI_SCALE_MAX)

  assert.equal(pinchedUiScale(1, 200, 240), 1.2, 'развели пальцы — интерфейс крупнее')
  assert.equal(pinchedUiScale(1, 200, 160), 0.8, 'свели — мельче, и это главное')
  assert.equal(pinchedUiScale(1, 200, 100), UI_SCALE_MIN, 'свели сильнее — заметно мельче')
  assert.equal(pinchedUiScale(1, 200, 40), UI_SCALE_MIN, 'дальше предела не пускаем')
  assert.equal(pinchedUiScale(1, 200, 2000), UI_SCALE_MAX)

  // Считаем от масштаба НА НАЧАЛО жеста: иначе каждый кадр домножался бы на
  // предыдущий и рука улетала бы в упор за один щипок.
  assert.equal(pinchedUiScale(1.2, 100, 100), 1.2)
})

test('дрожь пальцев масштаб не трогает', () => {
  assert.equal(pinchedUiScale(1, UI_SCALE_MIN_SPREAD_PX - 1, 90), 1, 'слишком тесный щипок не считаем')
  assert.equal(pinchedUiScale(1, 200, 0), 1)
  assert.equal(clampUiScale(Number.NaN), UI_SCALE_DEFAULT)
  assert.equal(roundUiScale(1.23456), 1.23)
})

/**
 * ⚠️ Хранилище бросает исключение в приватном режиме и при запрете на данные
 * сайта. Падать из-за размера интерфейса нельзя — тогда не откроется вообще
 * ничего.
 */
test('масштаб переживает перезагрузку и не падает без хранилища', () => {
  const box = new Map<string, string>()
  const storage = {
    getItem: (key: string) => box.get(key) ?? null,
    setItem: (key: string, value: string) => { box.set(key, value) },
  }

  assert.equal(readUiScale(storage), UI_SCALE_DEFAULT, 'пустое хранилище — обычный масштаб')
  writeUiScale(storage, 0.9)
  assert.equal(box.get(UI_SCALE_KEY), '0.9')
  assert.equal(readUiScale(storage), 0.9)

  box.set(UI_SCALE_KEY, 'ерунда')
  assert.equal(readUiScale(storage), UI_SCALE_DEFAULT)
  box.set(UI_SCALE_KEY, '99')
  assert.equal(readUiScale(storage), UI_SCALE_MAX, 'чужое значение подрезаем, а не принимаем')

  const broken = {
    getItem: () => { throw new Error('нет доступа к данным сайта') },
    setItem: () => { throw new Error('нет доступа к данным сайта') },
  }
  assert.equal(readUiScale(broken), UI_SCALE_DEFAULT)
  assert.doesNotThrow(() => writeUiScale(broken, 1.1))
  assert.equal(readUiScale(null), UI_SCALE_DEFAULT)
})

test('кнопки масштаба сохраняют последнее значение в памяти при сломанном хранилище', () => {
  const values = new Map<string, string>()
  const broken = {
    getItem: () => { throw new Error('private mode') },
    setItem: () => { throw new Error('private mode') },
  }
  const previousWindow = (globalThis as any).window
  const previousDocument = (globalThis as any).document
  ;(globalThis as any).window = {
    localStorage: broken,
    dispatchEvent: (event: Event) => { values.set('event', event.type); return true },
  }
  ;(globalThis as any).document = {
    documentElement: { style: { setProperty: (name: string, value: string) => values.set(name, value) } },
  }
  try {
    adjustTabletUiScale(0.1)
    adjustTabletUiScale(0.1)
    assert.equal(values.get('--tablet-ui-scale'), '1.2')
    assert.equal(values.get('--tablet-panel-scale'), '1.2')
    assert.equal(values.get('event'), 'canai-tablet-ui-scale')
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previousWindow
    if (previousDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = previousDocument
  }
})

/**
 * ⚠️ Доска не участвует: у неё свой щипок и свои мировые координаты. Смысл
 * масштаба ровно в том, чтобы ужать панели и отдать освободившееся место
 * доске, — значит один палец на доске отменяет весь жест.
 */
test('щипок принадлежит панелям, только если мимо доски легли ОБА пальца', () => {
  const element = (chain: string[]) => ({
    closest: (selector: string) => (chain.includes(selector) ? {} : null),
  })
  const panel = element([])
  const board = element(['.tablet-board'])
  const fullscreen = element(['.tablet-full'])
  const dockHandle = element(['.tablet-dock-handle'])
  const dockResize = element(['.tablet-dock-resize'])

  assert.equal(pinchTargetsChrome([panel, panel]), true)
  assert.equal(pinchTargetsChrome([panel, board]), false)
  assert.equal(pinchTargetsChrome([board, board]), false)
  // Полноэкранные режимы рисуют материал, а не панели: там щипок про материал.
  assert.equal(pinchTargetsChrome([fullscreen, fullscreen]), false)
  assert.equal(pinchTargetsChrome([dockHandle, panel]), true, 'второй палец переключает перемещение дока на щипок')
  assert.equal(pinchTargetsChrome([dockResize, panel]), true, 'щипок доступен на всей панели')
  assert.equal(pinchTargetsChrome([panel]), false, 'один палец — это не щипок')
  assert.equal(pinchTargetsChrome([panel, null]), false)
})

/**
 * ⚠️ Масштаб умножает РАЗМЕРНЫЕ ТОКЕНЫ, а не переписывает каждое правило:
 * панели собраны из них, поэтому ужимается вся полка целиком, а не одни кнопки
 * внутри неё. Радиусы не трогаем — скругление это форма, а форму канон менять
 * по поверхностям запрещает.
 */
test('масштаб доходит до размеров панелей, но не до их формы', () => {
  const css = source('./tablet.css')
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')))

  assert.match(root, /--tablet-ui-scale:\s*1;/)
  for (const token of ['--tablet-control-h', '--tablet-type-body', '--space-3', '--control-h-compact', '--text-control']) {
    assert.match(
      root,
      new RegExp(`${token}:\\s*calc\\([0-9]+px \\* var\\(--tablet-ui-scale\\)\\)`, 'u'),
      `${token} обязан следовать за масштабом интерфейса`,
    )
  }
  assert.doesNotMatch(root, /--radius-[a-z]+:[^;]*--tablet-ui-scale/u, 'скругления масштаб не трогает')

  // ⚠️ Поля ввода держат 16px независимо от масштаба: ниже этого Safari сам
  // приближает страницу при фокусе — то есть вернул бы ровно ту помеху,
  // из-за которой всё и затевалось.
  assert.match(source('./tabletPrompt.css'), /font-size:\s*max\(16px,/u)
})

/**
 * ⚠️ Зум Safari надо гасить, иначе человек получит СРАЗУ ДВА масштаба: наш и
 * его. Слушатель движения обязан быть неленивым, иначе preventDefault молча
 * ничего не делает.
 */
test('подписка гасит зум страницы и не перерисовывает интерфейс на каждый кадр', () => {
  const hook = source('./useTabletUiScale.ts')

  assert.match(hook, /addEventListener\('touchmove', onMove, captureActive\)/u)
  assert.match(hook, /event\.preventDefault\(\)/u)
  assert.match(hook, /addEventListener\('gesturestart'/u)
  assert.match(hook, /style\.setProperty\(SCALE_PROPERTY/u)
  assert.match(hook, /style\.setProperty\(PANEL_SCALE_PROPERTY/u)
  assert.match(hook, /dispatchEvent\(event\)/u)
  assert.doesNotMatch(hook, /useState/u, 'масштаб идёт в стиль, а не в состояние React')
})

test('щипок с близкого старта ждёт порог, глушит Safari и отдаёт приоритет доске', () => {
  const storageBox = new Map<string, string>()
  storageBox.set(UI_SCALE_KEY, '1.2')
  const storage = {
    getItem: (key: string) => storageBox.get(key) ?? null,
    setItem: (key: string, value: string) => storageBox.set(key, value),
  }
  const hook = mountTabletScaleHook(storage)
  const target = (chain: string[] = []) => ({
    closest: (selector: string) => chain.some((entry) => selector.includes(entry)) ? {} : null,
  })
  const chrome = target()
  const board = target(['.tablet-board'])
  const touches = (spread: number, touchTarget = chrome) => [
    { clientX: 100 - spread, clientY: 100, target: touchTarget },
    { clientX: 100 + spread, clientY: 100, target: touchTarget },
  ]
  let prevented = 0
  const emit = (name: string, spread: number, touchTarget = chrome) => {
    hook.emit(name, {
      touches: touches(spread, touchTarget),
      target: touchTarget,
      cancelable: true,
      preventDefault: () => { prevented += 1 },
    })
  }

  try {
    // Initial spread is below the jitter floor. We still claim the candidate,
    // but do not cancel the browser until a real pinch is visible.
    emit('touchstart', 10)
    const beforeMove = hook.dispatched.length
    emit('gesturestart', 10)
    assert.equal(prevented, 1, 'Safari gesture is blocked while candidate is reserved')
    emit('touchmove', 15)
    assert.equal(prevented, 1, 'jitter below threshold does not cancel page interaction')
    assert.equal(hook.dispatched.length, beforeMove, 'no style churn before activation')

    emit('touchmove', 30)
    assert.equal(prevented, 2, 'activation move prevents the native zoom')
    assert.equal(hook.styleValues.get('--tablet-ui-scale'), '1.2')
    assert.equal(hook.styleValues.get('--tablet-panel-scale'), '1.2')
    emit('touchmove', 60)
    assert.equal(hook.styleValues.get('--tablet-ui-scale'), '1.4', 'scale is clamped at the upper bound')
    emit('touchend', 60)
    assert.equal(storageBox.get(UI_SCALE_KEY), '1.4')

    // Once a panel pinch is active, a retargeted board touch cancels it and
    // leaves the board's own pointer pinch untouched.
    emit('touchstart', 30)
    const beforeBoardMove = hook.styleValues.get('--tablet-ui-scale')
    emit('touchmove', 60, board)
    assert.equal(prevented, 3, 'board retarget is never prevented by panel scale')
    assert.equal(hook.styleValues.get('--tablet-ui-scale'), beforeBoardMove)
    storageBox.set(UI_SCALE_KEY, '1')
    emit('touchstart', 100)
    emit('touchmove', 50)
    assert.equal(hook.styleValues.get('--tablet-panel-scale'), '0.5', 'сведение пальцев вдвое уменьшает всю панель вдвое')
    emit('touchend', 50)
    assert.equal(storageBox.get(UI_SCALE_KEY), '0.5')
  } finally {
    hook.restore()
  }
})

test('жесты в полях ввода не меняют масштаб и не подавляют события Safari', () => {
  const hook = mountTabletScaleHook({ getItem: () => '1', setItem: () => {} })
  const panel = { closest: () => null }
  try {
    for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]']) {
      const field = { closest: (query: string) => query.includes(selector) ? {} : null }
      assert.equal(pinchTargetsChrome([field, panel]), false, selector)
      let prevented = 0
      const before = hook.dispatched.length
      for (const name of ['touchstart', 'gesturestart', 'touchmove', 'gesturechange', 'touchend']) {
        hook.emit(name, {
          target: field,
          touches: [
            { clientX: 50, clientY: 100, target: field },
            { clientX: 200, clientY: 100, target: panel },
          ],
          cancelable: true,
          preventDefault: () => { prevented += 1 },
        })
      }
      assert.equal(prevented, 0, `${selector}: native gestures remain available`)
      assert.equal(hook.dispatched.length, before, `${selector}: no panel resize`)
    }
  } finally {
    hook.restore()
  }
})
