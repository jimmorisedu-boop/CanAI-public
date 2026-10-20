import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { BoardCanvas } from './BoardCanvas'
import { BoardItemView } from './BoardItemView'
import { OrientationGate } from './OrientationGate'
import { BoardObjectNavigator } from './BoardObjectNavigator'
import { clampPromptDock } from './usePromptDock'
import { useBoardFingerGestures } from './useBoardFingerGestures'
import { TabletBoard } from './TabletBoard'
import { TabletTopbar } from './TabletTopbar'
import { TabletContextBar } from './TabletContextBar'
import { TabletArrangeControls } from './TabletArrangeControls'
import { TabletPopover } from './TabletPopover'
import { TabletResize } from './TabletResize'
import { createBoardHistory, useBoardHistoryKeyboard } from './boardHistory'
import { MediaPlaybackControls } from '../ui/MediaPlaybackControls'

const listeners = new Map<string, Set<(event: any) => void>>()
class FakeElement {
  constructor(public tagName = 'DIV', public area = 'board') {}
  closest(selector: string) {
    if (selector.includes('inert') && this.area === 'inert') return this
    if (selector.includes('dialog') && this.area === 'modal') return this
    if (selector.includes('textarea') && this.tagName === 'TEXTAREA') return this
    if (selector.includes('.tablet-board') && this.area === 'board') return this
    if (selector.includes('.tablet-screen') && this.area === 'chrome') return this
    return null
  }
}
Object.assign(globalThis, {
  window: {
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener(name: string, fn: any) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set) },
    removeEventListener(name: string, fn: any) { listeners.get(name)?.delete(fn) },
  },
  Element: FakeElement, HTMLElement: FakeElement,
  CSS: { escape: (id: string) => id },
  document: { body: { nodeType: 1 }, activeElement: null, getElementById: () => null, elementFromPoint: () => null, querySelector: () => null,
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  requestAnimationFrame: () => 1,
})

const item = { id: 'first', kind: 'text' as const, text: 'Before', x: 0, y: 0, w: 100, h: 100 }
function makeStore() {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, items: [item], camera: { x: 0, y: 0, scale: 1 }, assets: [], archive: [], pending: [] })
  return store
}

// Only React scheduling and browser surfaces are doubled. Tests invoke actual
// component event closures against CanvasStore; no production test hooks.
function renderHooks<T>(render: () => T, slots: any[] = []) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previous = internals.ReactCurrentDispatcher.current
  const effects: Array<() => void | (() => void)> = []
  const effectEntries: Array<{ fn: () => any; deps: any[] }> = []
  let cursor = 0
  const effect = (fn: any, deps: any[]) => { effects.push(fn); effectEntries.push({ fn, deps }) }
  internals.ReactCurrentDispatcher.current = {
    useRef: (value: unknown) => slots[cursor++] ??= ({ current: value }),
    useState: (value: any) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = typeof value === 'function' ? value() : value
      return [slots[at], (next: any) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
    useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useContext: (context: any) => context._currentValue,
    useId: () => 'interaction-test',
  }
  try { return { value: render(), effects, effectEntries } } finally { internals.ReactCurrentDispatcher.current = previous }
}
function findElement(tree: any, type: any): any {
  if (!React.isValidElement(tree)) return undefined
  if (tree.type === type) return tree
  for (const child of React.Children.toArray((tree.props as any).children)) {
    const found = findElement(child, type)
    if (found) return found
  }
}
function allElements(tree: any, result: any[] = []): any[] {
  if (tree?.$$typeof === Symbol.for('react.portal')) {
    return allElements(tree.children, result)
  }
  if (!React.isValidElement(tree)) return result
  result.push(tree)
  for (const child of React.Children.toArray((tree.props as any).children)) allElements(child, result)
  return result
}
function textContent(tree: any): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (!React.isValidElement(tree)) return ''
  return React.Children.toArray((tree.props as any).children).map(textContent).join('')
}
function canvas(store: CanvasStore, readOnly = false, onLongPress = (_id: string) => {}, onDoubleTap = (_id: string) => {}, onResizeGesture = (_id: string, _at: { x: number; y: number }) => {}) {
  const rendered = renderHooks(() => BoardCanvas({ store, readOnly, onLongPress, onDoubleTap, onResizeGesture })).value as any
  const node = { style: { transform: '' }, classList: { add() {}, remove() {} } }
  const released: number[] = []
  rendered.ref.current = {
    clientWidth: 1024, clientHeight: 768, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture: (id: number) => released.push(id),
    querySelector: () => node,
  }
  return { props: rendered.props, node, released, rendered }
}
const point = (x: number, y: number, pointerId = 1) => ({ clientX: x, clientY: y, pointerId, target: new FakeElement(), pointerType: 'touch' })
function swipe(target = new FakeElement()) {
  const touches = (x: number) => [0, 10, 20].map((dx) => ({ clientX: x + dx, clientY: 0, target }))
  for (const fn of listeners.get('touchstart') ?? []) fn({ touches: touches(200), target })
  for (const fn of listeners.get('touchmove') ?? []) fn({ touches: touches(100), target })
}

test('finger taps fire on first release exactly once for two, three and four fingers', () => {
  const calls: string[] = []
  const hook = renderHooks(() => useBoardFingerGestures({
    undo: () => calls.push('undo'), redo: () => calls.push('redo'),
    chrome: () => calls.push('chrome'), clipboard: () => calls.push('clipboard'),
  }, true))
  const cleanups = hook.effects.map((effect) => effect())
  const target = new FakeElement()
  const emit = (name: string, count: number) => {
    const touches = Array.from({ length: count }, (_, i) => ({ clientX: 100 + i * 20, clientY: 100, target }))
    for (const fn of listeners.get(name) ?? []) fn({ touches, target, cancelable: true, preventDefault() {} })
  }
  try {
    for (const [count, action] of [[2, 'undo'], [3, 'redo'], [4, 'chrome']] as const) {
      calls.length = 0
      target.area = count === 4 ? 'chrome' : 'board'
      for (let n = 1; n <= count; n++) emit('touchstart', n)
      emit('touchend', count - 1)
      assert.deepEqual(calls, [action], 'no wait for the last finger')
      for (let n = count - 2; n >= 0; n--) emit('touchend', n)
      assert.deepEqual(calls, [action], 'no duplicate or lower-count action')
    }
  } finally { for (const cleanup of cleanups) cleanup?.() }
})

test('stylus marquee selects intersecting objects without moving camera or writing history', () => {
  const store = makeStore()
  const { props } = canvas(store)
  props.onPointerDown({ ...point(-20, -20), pointerType: 'pen' })
  props.onPointerMove({ ...point(120, 120), pointerType: 'pen' })
  props.onPointerUp({ ...point(120, 120), pointerType: 'pen' })
  assert.deepEqual([...store.getSelectedIds()], ['first'])
  assert.deepEqual(store.getCamera(), { x: 0, y: 0, scale: 1 })
  assert.equal(store.canUndo(), false)
})

test('finger plus stylus draws a frame over an object without starting pinch or drag', () => {
  const store = makeStore(), { props } = canvas(store)
  props.onPointerDown(point(200, 200, 1))
  props.onPointerDown({ ...point(10, 10, 2), pointerType: 'pen' })
  props.onPointerMove({ ...point(120, 120, 2), pointerType: 'pen' })
  props.onPointerUp({ ...point(120, 120, 2), pointerType: 'pen' })
  props.onPointerUp(point(200, 200, 1))
  assert.deepEqual([...store.getSelectedIds()], ['first'])
  assert.deepEqual(store.getCamera(), { x: 0, y: 0, scale: 1 })
  assert.equal(store.canUndo(), false)
})

test('pointercancel discards transient drag without history, drop, or capture', () => {
  const store = makeStore()
  const { props, node, released } = canvas(store)
  props.onPointerDown(point(10, 10))
  props.onPointerMove(point(90, 10))
  assert.notEqual(node.style.transform, '')
  props.onPointerCancel(point(90, 10))
  assert.equal(store.getItem('first')!.x, 0)
  assert.equal(store.canUndo(), false)
  assert.equal(node.style.transform, '')
  assert.deepEqual(released, [1])
  props.onPointerUp(point(90, 10))
  assert.equal(store.getItem('first')!.x, 0)
})

test('double tap on an image opens the viewer after selection without changing object geometry or history', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: [{ id: 'photo', kind: 'image', src: '/media/photo.png', x: 40, y: 50, w: 240, h: 180 }] })
  const opened: string[] = []
  const { props } = canvas(store, false, undefined, (id) => opened.push(id))
  props.onPointerDown(point(80, 90)); props.onPointerUp(point(80, 90))
  assert.deepEqual([...store.getSelectedIds()], ['photo'])
  props.onPointerDown(point(81, 90)); props.onPointerUp(point(81, 90))
  assert.deepEqual(opened, ['photo'])
  assert.deepEqual(store.getItem('photo'), { id: 'photo', kind: 'image', src: '/media/photo.png', x: 40, y: 50, w: 240, h: 180 })
  assert.equal(store.canUndo(), false)
})

test('double tap on text remains a regular selection and never opens a media viewer', () => {
  const store = makeStore()
  const opened: string[] = []
  const { props } = canvas(store, false, undefined, (id) => opened.push(id))
  props.onPointerDown(point(20, 20)); props.onPointerUp(point(20, 20))
  props.onPointerDown(point(20, 20)); props.onPointerUp(point(20, 20))
  assert.deepEqual(opened, [])
  assert.deepEqual([...store.getSelectedIds()], ['first'])
})

test('pinch cancels a pending double tap and changes only the camera', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: [{ id: 'photo', kind: 'image', src: '/media/photo.png', x: 40, y: 50, w: 240, h: 180 }] })
  const opened: string[] = []
  const { props } = canvas(store, false, undefined, (id) => opened.push(id))
  props.onPointerDown(point(80, 90)); props.onPointerUp(point(80, 90))
  props.onPointerDown(point(80, 90, 1)); props.onPointerDown(point(180, 90, 2))
  props.onPointerMove(point(40, 90, 1)); props.onPointerMove(point(220, 90, 2))
  props.onPointerUp(point(40, 90, 1)); props.onPointerUp(point(220, 90, 2))
  assert.deepEqual(opened, [])
  assert.equal(store.getItem('photo')!.x, 40)
  assert.notEqual(store.getCamera().scale, 1)
  assert.equal(store.canUndo(), false)
})

test('pointercancel over an archive drop target never archives the object', () => {
  const store = makeStore()
  const previous = document.elementFromPoint
  let hitTests = 0
  document.elementFromPoint = () => { hitTests++; return { closest: (selector: string) => selector.includes('archive') ? {} : null } as any }
  try {
    const { props } = canvas(store)
    props.onPointerDown(point(10, 10)); props.onPointerMove(point(500, 10)); props.onPointerCancel(point(500, 10))
    assert.equal(hitTests, 0)
    assert.equal(store.getArchive().length, 0)
    assert.equal(store.getItem('first')!.x, 0)
    assert.equal(store.canUndo(), false)
  } finally { document.elementFromPoint = previous }
})

test('three fingers reserve the sequence through final release, leaving camera unchanged', () => {
  const store = makeStore()
  const { props } = canvas(store)
  props.onPointerDown(point(200, 200, 1)); props.onPointerDown(point(300, 200, 2)); props.onPointerDown(point(250, 250, 3))
  props.onPointerMove(point(100, 200, 1)); props.onPointerMove(point(200, 200, 2)); props.onPointerMove(point(150, 250, 3))
  props.onPointerUp(point(150, 250, 3)); props.onPointerMove(point(120, 200, 1))
  assert.deepEqual(store.getCamera(), { x: 0, y: 0, scale: 1 })
  props.onPointerUp(point(100, 200, 1)); props.onPointerUp(point(200, 200, 2))
  assert.equal(store.canUndo(), false)
})

test('readonly drag over an item pans without changing the document', () => {
  const store = makeStore()
  const { props } = canvas(store, true)
  props.onPointerDown(point(10, 10)); props.onPointerMove(point(90, 10)); props.onPointerUp(point(90, 10))
  assert.equal(store.getCamera().x, 80)
  assert.equal(store.getItem('first')!.x, 0)
  assert.equal(store.canUndo(), false)
})

test('three-finger history leaves editable and modal history alone', () => {
  const store = makeStore()
  store.updateItem('first', { text: 'After' })
  const hook = renderHooks(() => useBoardFingerGestures({
    undo: () => store.undo(), redo: () => store.redo(), clipboard: () => {}, chrome: () => {},
  }, true))
  const cleanups = hook.effects.map((effect) => effect())
  try {
    swipe(new FakeElement('TEXTAREA'))
    assert.equal(store.getItem('first')!.text, 'After')
    swipe(new FakeElement('DIV', 'modal'))
    assert.equal(store.getItem('first')!.text, 'After')
    swipe()
    assert.equal(store.getItem('first')!.text, 'Before')
  } finally { for (const cleanup of cleanups) cleanup?.() }
})

test('orientation changes keep children at the same mounted tree position', () => {
  const child = React.createElement('main', { id: 'persistent-board' })
  const landscape = renderHooks(() => OrientationGate({ children: child })).value as any
  window.innerWidth = 768; window.innerHeight = 1024
  try {
    const portrait = renderHooks(() => OrientationGate({ children: child })).value as any
    const firstChild = (tree: any) => React.Children.toArray(tree.props.children)[0] as any
    assert.equal(landscape.type, portrait.type)
    assert.equal(firstChild(landscape).type, firstChild(portrait).type)
    assert.equal(firstChild(portrait).props.children, child)
  } finally { window.innerWidth = 1024; window.innerHeight = 768 }
})

test('readonly selected video exposes playback but no mutation or generation cancellation', () => {
  const store = makeStore()
  const result = renderHooks(() => BoardItemView({ item: { ...item, kind: 'video', src: '/media/test.mp4' },
    selected: true, scale: 1, store, readOnly: true } as any)).value
  const nodes: any[] = []
  const visit = (node: any) => { if (!React.isValidElement(node)) return; nodes.push(node); React.Children.forEach((node.props as any).children, visit) }
  visit(result)
  assert.equal(nodes.some((node) => node.type === 'video' && node.props.controls), false)
  assert.equal(nodes.some((node) => node.type === MediaPlaybackControls), true)
  assert.equal(nodes.some((node) => node.type === 'button'), false)
})

async function mountedLocalBoard() {
  let store!: CanvasStore
  let stateChange!: (state: string) => void
  const runtime = { kind: 'lan', openBoard(_id: string, value: CanvasStore, onState: any) {
    store = value
    stateChange = onState
    store.loadDoc(makeStore().toDoc())
    return { dispose() {} }
  } }
  const slots: any[] = []
  const props = { projectId: 'local-1', boardName: 'Test', onExit() {}, onRenamed() {}, runtime, canEdit: true, canManage: true } as any
  const render = () => renderHooks(() => TabletBoard(props), slots)
  const initial = render()
  const dispose = initial.effectEntries.find(({ deps }) => deps?.includes(runtime))!.fn()
  await Promise.resolve()
  stateChange('ready')
  const rendered = render()
  const cleanups = rendered.effectEntries.filter(({ deps }) => deps?.[1] === true && typeof deps[0]?.undo === 'function').map(({ fn }) => fn())
  return { store, render, stateChange, props, rendered, cleanup() { cleanups.forEach((fn) => fn?.()); dispose?.() } }
}

test('history callbacks retained by toast cannot mutate after readonly or board disposal', async () => {
  const board = await mountedLocalBoard()
  const undo = findElement(board.rendered.value, TabletTopbar).props.actions.onUndo
  board.store.updateItem('first', { text: 'Mine' })
  board.stateChange('readonly')
  board.render()
  undo()
  assert.equal(board.store.getItem('first')!.text, 'Mine')
  board.cleanup()
  undo()
})

test('old toast history stays invalid after another session opens on the same mounted board', async () => {
  const board = await mountedLocalBoard()
  const oldUndo = findElement(board.rendered.value, TabletTopbar).props.actions.onUndo
  board.cleanup()
  const reopened = board.render()
  const dispose = reopened.effectEntries.find(({ deps }) => deps?.includes(board.props.runtime))!.fn()
  await Promise.resolve()
  board.stateChange('ready'); board.render()
  board.store.updateItem('first', { text: 'New session' })
  try {
    oldUndo()
    assert.equal(board.store.getItem('first')!.text, 'New session')
  } finally { dispose?.() }
})

test('local and paired keyboard undo/redo share the same commands and skip editable inputs', () => {
  for (const kind of ['lan', 'paired'] as const) {
    const store = makeStore()
    const session = { dispose() {} }
    const history = createBoardHistory(store, kind, () => session, () => true)
    store.updateItem('first', { text: 'After' })
    const hook = renderHooks(() => useBoardHistoryKeyboard(history, true))
    const cleanups = hook.effects.map((effect) => effect())
    const key = (target: FakeElement, shiftKey = false) => {
      for (const fn of listeners.get('keydown') ?? []) fn({ key: 'я', code: 'KeyZ', ctrlKey: true, shiftKey, target, preventDefault() {} })
    }
    try {
      key(new FakeElement('TEXTAREA'))
      assert.equal(store.getItem('first')!.text, 'After')
      key(new FakeElement())
      assert.equal(store.getItem('first')!.text, 'Before')
      key(new FakeElement(), true)
      assert.equal(store.getItem('first')!.text, 'After')
    } finally { cleanups.forEach((fn) => fn?.()) }
  }
})

test('keyboard traverses offscreen objects, extends mixed selection, and opens their actions', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: [item,
    { ...item, id: 'far', kind: 'image', src: '/media/a.png', x: 5000, text: undefined }] })
  const activated: string[] = []
  const { props } = canvas(store, false, (id) => activated.push(id))
  assert.equal(props.tabIndex, 0)
  assert.equal(typeof props.onKeyDown, 'function')
  const target = new FakeElement()
  const key = (key: string, extra = {}) => props.onKeyDown({ key, target, currentTarget: target, preventDefault() {}, ...extra })
  key('Home')
  assert.deepEqual([...store.getSelectedIds()], ['first'])
  key('ArrowRight', { shiftKey: true })
  assert.deepEqual([...store.getSelectedIds()], ['first', 'far'])
  assert.notEqual(store.getCamera().x, 0, 'offscreen chosen image becomes visible')
  key('Enter')
  assert.deepEqual(activated, ['far'])
  assert.equal(store.canUndo(), false, 'selection and viewport are not document mutations')
})

test('keyboard cursor advances from the object deselected by Space', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: ['a', 'b', 'c'].map((id, index) => ({ ...item, id, x: index * 150 })) })
  const { props } = canvas(store)
  const target = new FakeElement()
  const key = (key: string) => props.onKeyDown({ key, target, currentTarget: target, preventDefault() {} })
  key('Home'); key('ArrowRight'); key(' ')
  assert.deepEqual([...store.getSelectedIds()], [])
  key('ArrowRight')
  assert.deepEqual([...store.getSelectedIds()], ['c'])
  assert.equal(store.canUndo(), false)
})

test('external selection replaces the keyboard cursor and Shift range anchor', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: ['a', 'b', 'c'].map((id, index) => ({ ...item, id, x: index * 150 })) })
  const { props } = canvas(store)
  const target = new FakeElement()
  const key = (key: string, shiftKey = false) => props.onKeyDown({ key, shiftKey, target, currentTarget: target, preventDefault() {} })
  key('Home')
  store.setSelection(['c']) // the same store entry point used by pointer/native select
  key(' ')
  assert.deepEqual([...store.getSelectedIds()], [])
  key('ArrowLeft', true)
  assert.deepEqual([...store.getSelectedIds()], ['b', 'c'])
  assert.equal(store.canUndo(), false)
})

test('object navigator is optional and its touch checkboxes include culled content', () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: [item,
    { ...item, id: 'far', kind: 'video', src: '/media/a.mp4', x: 5000, text: undefined }] })
  const { rendered } = canvas(store)
  const findNamed = (tree: any): any => {
    if (!React.isValidElement(tree)) return undefined
    if (typeof tree.type === 'function' && tree.type.name === 'BoardObjectNavigator') return tree
    return React.Children.toArray((tree.props as any).children).map(findNamed).find(Boolean)
  }
  assert.equal(findNamed(rendered), undefined, 'navigator does not cover the board by default')
  const navigator = renderHooks(() => BoardObjectNavigator({ store, reveal() {}, onActivate() {} })).value as any
  const group = findElement(navigator, 'div').props.children
  const list = React.Children.toArray(group).find((node: any) => node.props?.className === 'tablet-object-list') as any
  const labels = React.Children.toArray(list.props.children).filter((node: any) => node.type === 'label') as any[]
  assert.equal(labels.length, 2)
  for (const label of labels) findElement(label, 'input').props.onChange()
  assert.deepEqual([...store.getSelectedIds()], ['first', 'far'])
})

test('prompt placement stays reachable after rotation and keyboard opening', () => {
  assert.deepEqual(clampPromptDock({ x: 900, y: 800, width: 860 }, { width: 768, height: 500 }, 300), { x: 12, y: 192, width: 744 })
  assert.deepEqual(clampPromptDock({ x: -50, y: -80, width: 100 }, { width: 1024, height: 768 }, 160), { x: 12, y: 8, width: 320 })
  assert.deepEqual(clampPromptDock({ x: 600, y: 200, width: 800 }, { width: 1024, height: 768 }, 150, 0.5), { x: 600, y: 200, width: 800 }, 'половинный масштаб занимает 400px, ширина раскладки остаётся 800px')
  const enlarged = clampPromptDock({ x: 700, y: 600, width: 800 }, { width: 768, height: 500 }, 300, 1.4)
  assert.equal(enlarged.width * 1.4, 744)
  assert.equal(enlarged.x, 12)
  assert.equal(enlarged.y, 192)
  const anchored = { x: 200, y: 300, width: 800, bottom: 20 }
  const before = clampPromptDock(anchored, { width: 1024, height: 768 }, 300)
  const after = clampPromptDock(anchored, { width: 1024, height: 768 }, 150, 0.5)
  assert.equal(before.y + 300, after.y + 150, 'нижний край не меняется при уменьшении')
})

test('hold then drag on blank canvas selects instead of panning; movement before hold keeps panning', () => {
  const previous = window.setTimeout
  let hold: (() => void) | undefined
  window.setTimeout = ((fn: () => void) => { hold = fn; return 1 }) as any
  try {
    const store = makeStore(), { props } = canvas(store)
    props.onPointerDown(point(-20, -20))
    hold?.()
    props.onPointerMove(point(120, 120)); props.onPointerUp(point(120, 120))
    assert.deepEqual([...store.getSelectedIds()], ['first'])
    assert.deepEqual(store.getCamera(), { x: 0, y: 0, scale: 1 })
    assert.equal(store.canUndo(), false)
    props.onPointerDown(point(200, 200))
    props.onPointerMove(point(250, 200)); hold?.(); props.onPointerUp(point(250, 200))
    assert.equal(store.getCamera().x, 50)
  } finally { window.setTimeout = previous }
})

test('readonly keyboard can select and reveal but Enter does not open mutation actions', () => {
  const store = makeStore()
  let activated = false
  const { props } = canvas(store, true, () => { activated = true })
  const target = new FakeElement()
  props.onKeyDown({ key: 'Home', target, currentTarget: target, preventDefault() {} })
  props.onKeyDown({ key: 'Enter', target, currentTarget: target, preventDefault() {} })
  assert.deepEqual([...store.getSelectedIds()], ['first'])
  assert.equal(activated, false)
  assert.equal(store.canUndo(), false)
})

test('TabletBoard mixed selection keeps links in its count and contextual actions', async () => {
  const board = await mountedLocalBoard()
  try {
    board.store.loadDoc({ ...board.store.toDoc(), items: [item,
      { ...item, id: 'link', kind: 'link', text: undefined, link: { url: 'https://example.com' } }] })
    board.store.setSelection(['first', 'link'])
    const rendered = board.render()
    assert.equal(findElement(rendered.value, TabletTopbar).props.state.selectionCount, 2)
    assert.deepEqual(findElement(rendered.value, TabletContextBar).props.items.map((item: any) => item.id), ['first', 'link'])
  } finally { board.cleanup() }
})

test('tablet Actions previews row settings and commits once when the panel closes', () => {
  const store = new CanvasStore()
  const items = [
    { ...item, id: 'a', x: 0, y: 0, w: 100, h: 80 },
    { ...item, id: 'b', x: 280, y: 20, w: 90, h: 60 },
    { ...item, id: 'c', x: 40, y: 220, w: 120, h: 70 },
  ]
  store.loadDoc({ ...store.toDoc(), items })
  const slots: any[] = []
  const props = {
    store,
    items,
    selectionRect: { left: 120, right: 520, top: 80, bottom: 380, width: 400, height: 300 } as DOMRect,
    busyNote: null,
    onAction() {},
  }
  const initial = renderHooks(() => TabletContextBar(props), slots).value
  const arrangeButton = allElements(initial).find((node) => node.type === 'button' && textContent(node) === 'Arrange')
  assert.ok(arrangeButton, 'the live context bar exposes Arrange for a multi-selection')
  const beforeOpen = store.getItems().map((value) => ({ ...value }))
  arrangeButton.props.onClick({ currentTarget: new FakeElement() })
  assert.deepEqual(store.getItems(), beforeOpen, 'opening Arrange must not mutate the board')

  const open = renderHooks(() => TabletContextBar(props), slots).value
  const popover = allElements(open).find((node) => node.type === TabletPopover && node.props?.label === 'Arrange selection')
  assert.ok(popover, 'Arrange opens the shared panel from the live context bar')
  const panel = allElements(open).find((node) => node.type === TabletArrangeControls)
  assert.ok(panel, 'the live context bar owns the shared staged arrange controls')
  const controlSlots: any[] = []
  const controls = renderHooks(() => TabletArrangeControls(panel.props), controlSlots).value
  const row = allElements(controls).find((node) => node.type === 'button' && textContent(node) === 'Row')
  assert.ok(row)
  row.props.onClick()
  assert.notDeepEqual(store.getRenderableItems().map((value) => ({ id: value.id, x: value.x, y: value.y })), beforeOpen.map((value) => ({ id: value.id, x: value.x, y: value.y })), 'row previews immediately')
  assert.deepEqual(store.getItems(), beforeOpen, 'preview leaves durable items unchanged')
  assert.equal(store.canUndo(), false, 'preview does not create history')

  const staged = renderHooks(() => TabletArrangeControls(panel.props), controlSlots).value
  const gap = allElements(staged).find((node) => node.type === 'input' && node.props?.['aria-label'] === 'Gap')
  assert.ok(gap)
  gap.props.onChange({ target: { value: '48' } })
  const noApply = allElements(renderHooks(() => TabletArrangeControls(panel.props), controlSlots).value)
    .find((node) => node.type === 'button' && textContent(node) === 'Apply')
  assert.equal(noApply, undefined)
  popover.props.onClose()
  assert.notDeepEqual(store.getItems().map((value) => ({ id: value.id, x: value.x, y: value.y })), beforeOpen.map((value) => ({ id: value.id, x: value.x, y: value.y })))
  assert.equal(store.canUndo(), true)
})


test('long-press on an image opens resize and clears pointer state so handles are not a second finger', async () => {
  const store = makeStore()
  store.loadDoc({ ...store.toDoc(), items: [{ id: 'photo', kind: 'image', src: '/media/photo.png', x: 40, y: 50, w: 240, h: 180 }] })
  const resized: string[] = []
  const longPressed: string[] = []
  const { props } = canvas(store, false, (id) => longPressed.push(id), () => {}, (id) => resized.push(id))
  props.onPointerDown(point(100, 110))
  await new Promise((resolve) => setTimeout(resolve, 550))
  assert.deepEqual(resized, ['photo'])
  assert.deepEqual(longPressed, [])
  assert.equal(store.getItem('photo')!.x, 40)
})

test('resize previews without saving, commits once, and unmount restores the hidden original', () => {
  const store = makeStore()
  const photo = { id: 'photo', kind: 'image' as const, src: '/media/photo.png', x: 0, y: 0, w: 240, h: 180 }
  store.loadDoc({ ...store.toDoc(), items: [photo] })
  const slots: any[] = []
  const original = { style: { visibility: '' } }
  const host = { closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => original }) }
  const released: number[] = []
  const target = { setPointerCapture() {}, releasePointerCapture(id: number) { released.push(id) } }
  const event = (x: number, y: number, id = 1) => ({ clientX: x, clientY: y, pointerId: id, button: 0, currentTarget: target, stopPropagation() {}, preventDefault() {} })
  const render = () => renderHooks(() => TabletResize({ store, itemId: 'photo', onMenu() {}, onClose() {} }), slots)
  let result = render()
  const tree = result.value as any
  tree.ref.current = host
  const handle = React.Children.toArray(tree.props.children).find((child: any) => child.props?.className === 'tablet-resize-handle se') as any
  const cleanup = result.effects.map(effect => effect()).filter(Boolean)
  handle.props.onPointerDown(event(250, 190))
  handle.props.onPointerMove(event(370, 280))
  assert.equal(original.style.visibility, 'hidden')
  assert.equal(store.getItem('photo')!.w, 240, 'preview is not a board mutation')
  handle.props.onPointerUp(event(370, 280, 2))
  assert.equal(store.canUndo(), false, 'unrelated pointer cannot commit')
  handle.props.onPointerUp(event(370, 280))
  assert.equal(store.getItem('photo')!.w, 360)
  assert.equal(store.getItem('photo')!.h, 270)
  assert.equal(original.style.visibility, '')
  store.undo()
  assert.equal(store.getItem('photo')!.w, 240)
  assert.equal(store.canUndo(), false)
  handle.props.onPointerDown(event(250, 190))
  assert.equal(original.style.visibility, 'hidden')
  for (const dispose of cleanup) dispose?.()
  assert.equal(original.style.visibility, '')
  assert.deepEqual(released, [1, 1])
})
