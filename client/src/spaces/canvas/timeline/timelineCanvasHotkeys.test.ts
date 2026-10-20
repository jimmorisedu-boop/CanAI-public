import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { CanvasStore } from '../konva/canvasStore'
import { hits } from '../../../ui/hotkeys'
import { isMarkDigit } from '../konva/markInput'
import * as timelineBus from './timelineBus'

// Хоткеи холста и режим правки клипа. Пока оверлей виден, клавиатура его —
// Delete не имеет права удалять объекты под затемнением. Но в презентации
// «холст» (клавиша G) оверлей спрятан, цель в шине жива, и человек разглядывает
// снятый кадр на доске: хоткеи холста обязаны работать, а Escape — достаться
// оверлею (он вернёт себя) и НЕ снять заодно выделение с кадра.
//
// Хук холста собирается из исходника, как в RefChip.keyboard.test.ts: React в
// тесте подменён, а шина — настоящая, та же, что в приложении.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const ts = createRequire(path.join(root, 'client/package.json'))('typescript')
const effects: Array<() => void | (() => void)> = []
const listeners = new Map<string, Array<(event: unknown) => void>>()
const fakeWindow = {
  addEventListener(type: string, listener: (event: unknown) => void) {
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  },
  removeEventListener(type: string, listener: (event: unknown) => void) {
    listeners.set(type, (listeners.get(type) ?? []).filter((value) => value !== listener))
  },
  clearTimeout() {},
  setTimeout() { return 1 },
}
const fakeReact = {
  useEffect: (fn: () => void) => effects.push(fn),
  useState: (value: unknown) => [value, () => {}],
  useRef: (value: unknown) => ({ current: value }),
}
const stub = new Proxy({}, { get: (_, key) => (key === '__esModule' ? true : () => undefined) })

function loadHotkeys(): { useCanvasHotkeys: (...args: unknown[]) => unknown } {
  const file = 'client/src/spaces/canvas/konva/useCanvasHotkeys.ts'
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mocks: Record<string, unknown> = {
    react: fakeReact,
    '../../../ui/hotkeys': { hits },
    '../compare/compareBus': { getCompareSession: () => null },
    '../timeline/timelineBus': timelineBus,
    './markInput': { isMarkDigit },
    './pasteArbiter': { canvasPasteArbiter: { cancel() {} } },
    './boardLeaseActions': { runWithBoardLease: (_store: unknown, _ids: unknown, work: () => void) => { work() } },
  }
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    window: fakeWindow,
    document: { querySelector: () => null },
    require: (name: string) => mocks[name] ?? stub,
  }, { filename: file })
  return exports as { useCanvasHotkeys: (...args: unknown[]) => unknown }
}

const hotkeys = loadHotkeys()

function board() {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
    { id: 'clip', kind: 'video', x: 0, y: 0, w: 320, h: 180, src: '/media/clip.mp4' },
    { id: 'clip2', kind: 'video', x: 400, y: 0, w: 320, h: 180, src: '/media/clip2.mp4' },
    { id: 'frame', kind: 'image', x: 0, y: 220, w: 320, h: 180, src: '/media/frame.png' },
  ] })
  effects.length = 0
  listeners.clear()
  hotkeys.useCanvasHotkeys(store, true, { w: 1200, h: 800 })
  const dispose = effects[0]() as () => void
  return {
    store,
    dispose,
    press(key: string, extra: Record<string, unknown> = {}) {
      const event = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        target: { tagName: 'DIV', isContentEditable: false },
        ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true },
        ...extra,
      }
      for (const listener of listeners.get('keydown') ?? []) listener(event)
      return event
    },
  }
}

function endSession(): void {
  timelineBus.setTimelineTarget(null)
  timelineBus.setTimelinePresentation('overlay')
}

test('режима нет: Escape снимает выделение, Delete удаляет (база не сломана)', () => {
  endSession()
  const { store, press, dispose } = board()
  store.setSelection(['frame'])
  press('Escape')
  assert.equal(store.getSelectedIds().size, 0)
  store.setSelection(['frame'])
  press('Delete')
  assert.equal(store.getItem('frame'), undefined)
  dispose()
})

test('оверлей виден: хоткеи холста молчат, Delete ничего не удаляет', () => {
  endSession()
  const { store, press, dispose } = board()
  timelineBus.setTimelineTarget('clip')
  store.setSelection(['frame'])
  press('Delete')
  press('a', { ctrlKey: true })
  press('Escape')
  assert.ok(store.getItem('frame'), 'объект под оверлеем цел')
  assert.deepEqual([...store.getSelectedIds()], ['frame'], 'выделение не тронуто')
  dispose()
  endSession()
})

test('презентация «холст»: Delete и Ctrl+A работают, как обычно', () => {
  endSession()
  const { store, press, dispose } = board()
  timelineBus.setTimelineTarget('clip')
  timelineBus.setTimelinePresentation('canvas')
  press('a', { ctrlKey: true })
  assert.equal(store.getSelectedIds().size, 3, 'выделить всё')
  store.setSelection(['frame'])
  press('Delete')
  assert.equal(store.getItem('frame'), undefined, 'снятый кадр на доске удаляется')
  dispose()
  endSession()
})

test('презентация «холст»: Escape достаётся оверлею и выделение кадра не снимает', () => {
  endSession()
  const { store, press, dispose } = board()
  timelineBus.setTimelineTarget('clip')
  timelineBus.setTimelinePresentation('canvas')
  store.setSelection(['frame'])
  const event = press('Escape')
  assert.deepEqual([...store.getSelectedIds()], ['frame'], 'кадр остался выделенным')
  assert.equal(event.defaultPrevented, false, 'холст клавишу не присвоил')
  dispose()
  endSession()
})

test('презентация «холст»: T не подменяет клип живого сеанса другим', () => {
  endSession()
  const { store, press, dispose } = board()
  timelineBus.setTimelineTarget('clip')
  timelineBus.setTimelinePresentation('canvas')
  store.setSelection(['clip2'])
  press('t')
  assert.equal(timelineBus.getTimelineTarget(), 'clip')
  dispose()
  endSession()
})

test('режима нет: T открывает правку выделенного клипа', () => {
  endSession()
  const { store, press, dispose } = board()
  store.setSelection(['clip2'])
  press('t')
  assert.equal(timelineBus.getTimelineTarget(), 'clip2')
  dispose()
  endSession()
})
