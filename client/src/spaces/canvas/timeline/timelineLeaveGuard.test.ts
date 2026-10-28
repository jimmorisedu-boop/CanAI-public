import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import ts from 'typescript'
import { registerConfirmHost, type ConfirmRequest } from '../../../ui/confirmBus'
import { clearTimelineNotice } from './timelineNotice'
import { registerTimelineLeaveGuard, requestTimelineLeave } from './timelineLeaveGuard'

function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const state = { active: true, dirty: true, busy: false, closed: 0 }
  const questions: Array<{ request: ConfirmRequest; resolve(value: boolean): void }> = []
  registerConfirmHost((request, resolve) => questions.push({ request, resolve }))
  const dispose = registerTimelineLeaveGuard({
    active: () => state.active, dirty: () => state.dirty, busy: () => state.busy,
    discard: () => { state.closed++; state.active = false },
  })
  t.after(() => { dispose(); registerConfirmHost(null); clearTimelineNotice() })
  return { state, questions, dispose }
}

test('выход с неприменённым монтажом ждёт решения, отмена сохраняет сеанс', async t => {
  const f = fixture(t)
  const leaving = requestTimelineLeave()
  assert.equal(f.questions.length, 1)
  assert.equal(f.state.closed, 0)
  assert.equal(f.questions[0]!.request.confirmLabel, 'Leave without applying')
  f.questions[0]!.resolve(false)
  assert.equal(await leaving, false)
  assert.equal(f.state.closed, 0)
  assert.equal(f.state.active, true)
})

test('только явный выход без применения закрывает неприменённый монтаж', async t => {
  const f = fixture(t)
  const leaving = requestTimelineLeave()
  f.questions[0]!.resolve(true)
  assert.equal(await leaving, true)
  assert.equal(f.state.closed, 1)
})

test('повторные нажатия выхода используют один вопрос и один discard', async t => {
  const f = fixture(t)
  const first = requestTimelineLeave()
  assert.equal(requestTimelineLeave(), first)
  assert.equal(f.questions.length, 1)
  f.questions[0]!.resolve(true)
  await first
  assert.equal(f.state.closed, 1)
})

test('выход заблокирован во время экспорта клипов', async t => {
  const f = fixture(t)
  f.state.busy = true
  assert.equal(await requestTimelineLeave(), false)
  assert.equal(f.questions.length, 0)
  assert.equal(f.state.closed, 0)
})

test('просмотр без правок и уже применённый монтаж не требуют подтверждения', async t => {
  const f = fixture(t)
  f.state.dirty = false
  assert.equal(await requestTimelineLeave(), true)
  assert.equal(f.questions.length, 0)
  f.state.dirty = true
  assert.equal(await requestTimelineLeave(), true, 'закрытый после Apply target не оставляет ложный dirty')
  assert.equal(f.questions.length, 0)
})

test('старое подтверждение не закрывает другой редактор после смены владельца', async t => {
  const f = fixture(t)
  const leaving = requestTimelineLeave()
  f.dispose()
  let closed = 0
  const disposeNew = registerTimelineLeaveGuard({ active: () => true, dirty: () => true, busy: () => false, discard: () => closed++ })
  f.questions[0]!.resolve(true)
  assert.equal(await leaving, false)
  assert.equal(f.state.closed, 0)
  assert.equal(closed, 0)
  disposeNew()
})

test('перезагрузка и закрытие вкладки предупреждают о черновике; cleanup снимает защиту', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const listeners = new Map<string, (event: BeforeUnloadEvent) => void>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (name: string, listener: (event: BeforeUnloadEvent) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } })
  let dirty = true
  let prevented = 0
  const event = { preventDefault: () => prevented++, returnValue: undefined } as unknown as BeforeUnloadEvent
  const dispose = registerTimelineLeaveGuard({ active: () => true, dirty: () => dirty, busy: () => false, discard: () => {} })
  try {
    listeners.get('beforeunload')!(event)
    assert.equal(prevented, 1)
    dirty = false
    listeners.get('beforeunload')!(event)
    assert.equal(prevented, 1)
    dispose()
    assert.equal(listeners.size, 0)
  } finally {
    dispose()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

// Execute the actual navigation callbacks from both editions against the real guard.
function navigationCallback(file: string, name: string, jsx = false): string {
  const source = ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let arrow: ts.ArrowFunction | undefined
  const visit = (node: ts.Node) => {
    if (jsx && ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrowFunction(node.initializer.expression)) arrow = node.initializer.expression
    if (!jsx && ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      const value = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
      if (value && ts.isArrowFunction(value)) arrow = value
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(arrow, name)
  return ts.transpile('return (' + arrow.getText(source) + ')', {target: ts.ScriptTarget.ES2022})
}

const navigationRoots = ['../../../']
const localOverrideRoot = '../../../../../local-edition/overrides/client/src/'
if (fs.existsSync(new URL(localOverrideRoot + 'App.tsx', import.meta.url))) navigationRoots.push(localOverrideRoot)

for (const root of navigationRoots) {
  const edition = root === localOverrideRoot ? 'local override' : 'current edition'
  test(edition + 'desktop board navigation preserves a cancelled montage', async t => {
    const f = fixture(t)
    let navigated = 0
    const leave = new Function('requestTimelineLeave', 'leaveMacroEditor', navigationCallback(root + 'App.tsx', 'leaveBoard'))(requestTimelineLeave, (next: () => void) => { next(); return true })
    const result = leave(() => { navigated++ })
    f.questions[0]!.resolve(false)
    assert.equal(await result, false)
    assert.equal(navigated, 0)
    assert.equal(f.state.closed, 0)
  })
  for (const event of ['onExit', 'onOpenProject']) {
    test(edition + 'tablet ' + event + ' waits before unmounting the board', async t => {
      const f = fixture(t)
      const screens: unknown[] = []
      const leave = new Function('requestTimelineLeave', 'setScreen', navigationCallback(root + 'tablet/TabletApp.tsx', event, true))(requestTimelineLeave, (screen: unknown) => screens.push(screen))
      leave({ id: 'other' })
      assert.equal(screens.length, 0)
      f.questions[0]!.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(screens.length, 0)
      assert.equal(f.state.closed, 0)
    })
  }
}

for (const root of navigationRoots) {
  test(root + 'macro mode switches preserve an open montage', async t => {
    const f = fixture(t)
    let switched = 0
    const leave = new Function('withViewTransition', 'macroEditRef', 'setMacroEdit', 'macroLeaveController', navigationCallback(root + 'App.tsx', 'leaveMacroEditor'))((run: () => void) => run(), {current: null}, () => {}, {})
    assert.equal(await leave(() => { switched++ }), true)
    assert.equal(switched, 1)
    assert.equal(f.questions.length, 0)
    assert.equal(f.state.closed, 0)
  })
}

