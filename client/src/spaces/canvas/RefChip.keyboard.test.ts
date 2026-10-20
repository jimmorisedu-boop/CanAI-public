import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { CanvasStore } from './konva/canvasStore'
import { hits } from '../../ui/hotkeys'
import { itemToRef } from './konva/selection'
import { removeComposerReference } from './referenceComposer'
import { isMarkDigit } from './konva/markInput'
import { refChipFallback, retryRefSrc } from './refChipFallback'
import { screenPreviewSrc } from './konva/screenPreview'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const requireClient = createRequire(path.join(root, 'client/package.json'))
const ts = requireClient('typescript')
const effects: Array<() => void | (() => void)> = []
const listeners = new Map<string, Array<(event: any) => void>>()
const document = { querySelector: () => null }
const window = {
  addEventListener(type: string, listener: (event: any) => void) {
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  },
  removeEventListener(type: string, listener: (event: any) => void) {
    listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== listener))
  },
  clearTimeout() {}, setTimeout() { return 1 },
}
const react = {
  useEffect: (fn: () => void) => effects.push(fn),
  useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }),
}
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const stub = new Proxy({}, { get: (_, key) => key === '__esModule' ? true : () => undefined })
function load(file: string, mocks: Record<string, any>) {
  const exports = {}
  const code = ts.transpileModule(read(file), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, window, document,
    require: (name: string) => name === 'react' ? (mocks.react ?? react) : mocks[name] ?? stub,
  }, { filename: file })
  return exports as any
}
const keyboard = load('client/src/spaces/canvas/konva/useCanvasHotkeys.ts', {
  '../../../ui/hotkeys': { hits },
  '../compare/compareBus': { getCompareSession: () => null },
  '../timeline/timelineBus': { getTimelineTarget: () => null, timelineBlocksCanvas: () => false },
  './markInput': { isMarkDigit },
  './pasteArbiter': { canvasPasteArbiter: { cancel() {} } },
  // ⚠️ Не заглушка: удаление ходит через аренду (см. boardLeaseActions), и с
  // пустышкой Delete молча ничего не делал бы — ровно та беда, от которой
  // этот тест и сторожит.
  './boardLeaseActions': { runWithBoardLease: (_store: any, _ids: any, work: () => void) => { work() } },
})
const chipModule = load('client/src/spaces/canvas/RefChip.tsx', {
  'react/jsx-runtime': { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' },
  './RefChipPreview': { useRefChipPreview: () => ({ anchorRef() {}, hoverProps: {}, preview: null }) },
})

const brokenSetterCalls: Array<{ index: number; value: any }> = []
let brokenHookIndex = 0
const brokenReact = {
  useEffect: () => {},
  useState: (value: any) => {
    // RefChip calls useState(attempt) first and useState(failed) second.
    const index = brokenHookIndex++
    const current = index === 0 ? 0 : true
    return [current, (next: any) => brokenSetterCalls.push({ index, value: next })]
  },
  useRef: (value: any) => ({ current: value }),
}
const brokenChipModule = load('client/src/spaces/canvas/RefChip.tsx', {
  react: brokenReact,
  'react/jsx-runtime': { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' },
  './RefChipPreview': { useRefChipPreview: () => ({ anchorRef() {}, hoverProps: {}, preview: null }) },
  './refChipFallback': { refChipFallback, retryRefSrc },
  './konva/screenPreview': { screenPreviewSrc },
})
const promptSource = read('client/src/spaces/canvas/PromptBar.tsx')
const promptTree = ts.createSourceFile('PromptBar.tsx', promptSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let removeRefSource = ''
function findRemove(node: any) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'removeRef') removeRefSource = node.getText(promptTree)
  ts.forEachChild(node, findRemove)
}
findRemove(promptTree)
assert.ok(removeRefSource, 'actual nested PromptBar.removeRef found')
const removeRefCode = ts.transpileModule(removeRefSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function storeFixture() {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
    { id: 'first', kind: 'text', x: 0, y: 0, w: 200, h: 100, text: 'Первая заметка' },
    { id: 'second', kind: 'text', x: 240, y: 0, w: 200, h: 100, text: 'Вторая заметка' },
  ] })
  return store
}
function mountKeyboard(store: CanvasStore) {
  effects.length = 0; listeners.clear()
  keyboard.useCanvasHotkeys(store, true, { w: 1200, h: 800 })
  const dispose = effects[0]() as () => void
  return { dispose, dispatch: (event: any) => { for (const listener of listeners.get('keydown') ?? []) listener(event) } }
}
function event(key: string, extra: any = {}) {
  return { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, target: { tagName: 'DIV', isContentEditable: false },
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extra }
}

test('сорванный preview-чип называет файл и повторяет загрузку по клику', () => {
  brokenHookIndex = 0
  brokenSetterCalls.length = 0
  const ref = {
    shapeId: 'broken-cloud',
    kind: 'image' as const,
    label: 'изображение',
    src: '/api/cloud-assets/assets/ast_missing',
  }
  const chip = brokenChipModule.RefChip({ refItem: ref, onRemove: () => {} })

  assert.equal(chip.props.className, 'ref-chip is-broken')
  assert.match(chip.props['aria-label'], /ast_missing.*Image failed to load.*Click to retry loading/)
  chip.props.onClick({ button: 0 })
  assert.equal(brokenSetterCalls[0]?.index, 1, 'клик сначала снимает broken-состояние')
  assert.equal(brokenSetterCalls[0]?.value, false)
  assert.equal(brokenSetterCalls[1]?.index, 0, 'клик увеличивает номер попытки')
  assert.equal(brokenSetterCalls[1]?.value(0), 1)
})

for (const spec of [
  { key: 'Delete', selected: 'all', type: 'keydown' },
  { key: 'Backspace', selected: 'all', type: 'keydown' },
  { key: 'Delete', selected: 'first', type: 'keydown' },
  { key: 'ContextMenu', selected: 'all', type: 'contextmenu' },
]) {
 test(`${spec.key} on a reference chip only removes the reference (${spec.selected})`, () => {
  const { key, type } = spec
  const store = storeFixture(), hook = mountKeyboard(store)
  hook.dispatch(event('a', { ctrlKey: true }))
  if (spec.selected === 'first') store.setSelection(['first'])
  const removeRef = vm.runInNewContext(removeRefCode + '\nremoveRef', {
    store, replacementSessionRef: { current: null }, discussOpen: false, manualRefs: [],
    // Снятие чипа — единственное место, где приложение правит написанный
    // человеком промпт: перенумеровывает @-ссылки (promptTagRenumbering.test).
    removeComposerReference, refsRef: { current: [] }, prompt: '',
    setPrompt: () => {}, pushPromptHistory: () => {},
  })
  const chip = chipModule.RefChip({ refItem: itemToRef(store.getItem('first')!)!, onRemove: () => removeRef('first') })
  const keyEvent = event(key)
  const before = { items: store.getItems().map(item => item.id), selected: [...store.getSelectedIds()] }
  if (type === 'contextmenu') chip.props.onContextMenu(keyEvent)
  else chip.props.onKeyDown(keyEvent)
  const afterChip = { items: store.getItems().map(item => item.id), selected: [...store.getSelectedIds()] }
  // Same event propagates from the actual RefChip handler to the actual window hook.
  if (type === 'keydown' && !keyEvent.stopped) hook.dispatch(keyEvent)
  const afterWindow = { items: store.getItems().map(item => item.id), selected: [...store.getSelectedIds()] }
  assert.deepEqual(afterChip.items, before.items)
  assert.deepEqual(afterWindow.items, before.items, 'chip key must not delete any canvas item')
  assert.equal(store.getSelectedIds().has('first'), false)
  hook.dispose()
 })
}

test('Delete on canvas and Undo still edit the actual store', () => {
  const store = storeFixture(), hook = mountKeyboard(store)
  store.setSelection(['second'])
  hook.dispatch(event('Delete'))
  assert.deepEqual(store.getItems().map(item => item.id), ['first'])
  hook.dispatch(event('z', { ctrlKey: true }))
  assert.deepEqual(store.getItems().map(item => item.id), ['first', 'second'])
  hook.dispose()
})
