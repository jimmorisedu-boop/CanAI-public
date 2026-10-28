import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CanvasStore } from './canvasStore'
import { beginGroupDrag, cancelGroupDrag, groupDragFollowers, groupDragPositions, isGroupDragMember } from './groupDrag'
import { createPromptChatDropResult, createPromptChatGroupDrop } from '../promptChatDrop'
import { registerPromptChatDropHandler, requestPromptChatDrop, type PromptChatDropEvent } from '../promptChatDropBus'

// Execute the production gesture handler without Konva's browser/canvas runtime.
// Only DOM hit-testing and rendering are replaced; group/store/drop bus are real.
const source = ts.createSourceFile('itemHelpers.ts', readFileSync(new URL('./itemHelpers.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && ['clientPoint', 'onDragEnd'].includes(node.name?.text ?? ''))
const code = ts.transpileModule(functions.map((node) => node.getText(source).replace(/^export /u, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function fixture(options: { missingFollower?: boolean; missingPointer?: boolean; editable?: boolean; receiver?: boolean } = {}) {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
    { id: 'a', kind: 'image', src: '/media/a.png', x: 10, y: 20, w: 100, h: 100 },
    { id: 'b', kind: 'image', src: '/media/b.png', x: 130, y: 20, w: 100, h: 100 },
  ] })
  store.setSelection(['a', 'b'])
  let pointer = { x: 600, y: 400 }
  function node(id: string) {
    let position = { x: store.getItem(id)!.x, y: 20 }
    return {
      id: () => id, x: () => position.x, y: () => position.y,
      position: (next: { x: number; y: number }) => { position = next },
      getLayer: () => ({ batchDraw() {} }),
      getStage: () => ({ getPointerPosition: () => options.missingPointer ? null : pointer, container: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) }),
    }
  }
  const a = node('a')
  const b = node('b')
  const session = beginGroupDrag(store, 'a', options.missingFollower ? [a] : [a, b])
  a.position({ x: 510, y: 220 })
  b.position({ x: 630, y: 220 })
  const events: PromptChatDropEvent[] = []
  const unregister = registerPromptChatDropHandler(options.receiver === false ? null : {
    drop: (event) => events.push(event), hover() {},
  })
  let commits = 0
  store.looksEditable = () => options.editable !== false
  const noop = () => {}
  const deps = {
    session, store, createPromptChatDropResult, createPromptChatGroupDrop, requestPromptChatDrop,
    cancelGroupDrag, groupDragFollowers, groupDragPositions, isGroupDragMember,
    publishCanvasDrag: noop, clearGuides: noop, notifyPromptChatDropHover: noop, notifyArchiveHover: noop,
    restorePendingCanvasDrag: noop, clearActiveDrag: noop, releaseAltCopy: noop,
    wantsAltCopy: () => false, altHeld: () => false,
    overPromptChat: (point: { x: number }) => point.x >= 500,
    overArchive: () => false, tryPinToAssetBar: () => false,
    commitGestureWithLease: (_store: unknown, _ids: unknown, commit: () => void) => { commits++; commit() },
  }
  const finish = new Function(...Object.keys(deps), `
    let groupDrag = session, groupDragStore = store;
    let settledByGroupDrag = new Set();
    const pendingCanvasDrags = new WeakMap();
    ${code}
    return onDragEnd;
  `)(...Object.values(deps))
  return { store, a, b, events, unregister, get commits() { return commits },
    end(target = a, x = 600) {
      pointer = { x, y: 400 }
      finish(store, target.id(), { target, evt: { clientX: x, clientY: 400 } })
    },
  }
}

test('release over Assistant uses the mouse event after the Stage pointer is cleared', () => {
  const f = fixture({ missingPointer: true })
  try {
    f.end()
    assert.deepEqual(f.events.map((event) => event.kind), ['references'])
    assert.equal(f.commits, 0)
  } finally { f.unregister() }
})

test('one dragend attaches the entire group, including an unmounted follower, without moving originals', () => {
  const f = fixture({ missingFollower: true })
  try {
    f.end()
    const event = f.events[0]
    assert.equal(event?.kind, 'references')
    if (event?.kind !== 'references') return
    assert.deepEqual(event.refs.map((ref) => ref.shapeId), ['a', 'b'])
    assert.deepEqual(f.store.getItems().map(({ x, y }) => ({ x, y })), [{ x: 10, y: 20 }, { x: 130, y: 20 }])
    assert.deepEqual([f.a.x(), f.a.y()], [10, 20])
    assert.equal(f.commits, 0)
  } finally { f.unregister() }
})

test('late follower dragend cannot attach twice or move the group after an accepted drop', () => {
  const f = fixture()
  try {
    f.end()
    f.b.position({ x: 999, y: 999 })
    f.end(f.b, 100)
    assert.equal(f.events.length, 1)
    assert.equal(f.commits, 0)
    assert.equal(f.store.getItem('b')!.x, 130)
  } finally { f.unregister() }
})

test('attaching readable refs does not require permission to move their board objects', () => {
  const f = fixture({ editable: false })
  try {
    f.end()
    assert.equal(f.events.length, 1)
    assert.equal(f.commits, 0)
  } finally { f.unregister() }
})

test('ordinary canvas drop still commits one group movement', () => {
  const f = fixture()
  try {
    f.end(f.a, 100)
    f.end(f.b, 100)
    assert.equal(f.events.length, 0)
    assert.equal(f.commits, 1)
    assert.deepEqual(f.store.getItems().map(({ x, y }) => ({ x, y })), [{ x: 510, y: 220 }, { x: 630, y: 220 }])
    f.store.undo()
    assert.equal(f.store.getItem('b')!.x, 130)
  } finally { f.unregister() }
})

test('an unregistered Assistant cannot silently consume a normal board move', () => {
  const f = fixture({ receiver: false })
  try {
    f.end()
    assert.equal(f.commits, 1)
  } finally { f.unregister() }
})
