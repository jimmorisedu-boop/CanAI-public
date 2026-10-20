import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { commitGestureWithLease } from './gestureCommit'
import type { CanvasStore } from './canvasStore'

type Store = Pick<CanvasStore, 'canMutateItems' | 'looksEditable' | 'withSelection'>

function stubStore(over: Partial<Store>): Store {
  return {
    canMutateItems: () => true,
    looksEditable: () => true,
    withSelection: async (_ids: readonly string[], work: () => void | Promise<void>) => {
      await work()
      return true
    },
    ...over,
  } as Store
}

test('своя аренда есть — жест пишется СИНХРОННО, без круга до сервера', () => {
  const calls: string[] = []
  commitGestureWithLease(
    stubStore({ withSelection: async () => { calls.push('lease'); return true } }),
    ['a'],
    () => calls.push('commit'),
    () => calls.push('revert'),
  )
  // Синхронность важна: иначе перенос на ЛОКАЛЬНОЙ доске стал бы отложенным,
  // а история отмены — гонкой с микрозадачами.
  assert.deepEqual(calls, ['commit'])
})

test('аренда ещё в пути — жест ДОЖИДАЕТСЯ её, а не откатывается', async () => {
  const calls: string[] = []
  let release: () => void = () => {}
  const store = stubStore({
    canMutateItems: () => false,
    looksEditable: () => true,
    withSelection: async (_ids: readonly string[], work: () => void | Promise<void>) => {
      await new Promise<void>((resolve) => { release = resolve })
      await work()
      return true
    },
  })
  commitGestureWithLease(store, ['a'], () => calls.push('commit'), () => calls.push('revert'))
  // ⚠️ Это и есть жалоба «перестал переноситься контент»: пока ответ сервера
  // в пути, откатывать нельзя — объект прыгнул бы из-под руки обратно.
  assert.deepEqual(calls, [])
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['commit'])
})

test('объект держит живой коллега — откат сразу, ждать нечего', () => {
  const calls: string[] = []
  commitGestureWithLease(
    stubStore({
      canMutateItems: () => false,
      looksEditable: () => false,
      withSelection: async () => { calls.push('lease'); return false },
    }),
    ['a'],
    () => calls.push('commit'),
    () => calls.push('revert'),
  )
  assert.deepEqual(calls, ['revert'])
})

test('сервер отказал в аренде — объект возвращается на место', async () => {
  const calls: string[] = []
  commitGestureWithLease(
    stubStore({
      canMutateItems: () => false,
      looksEditable: () => true,
      withSelection: async () => false,
    }),
    ['a'],
    () => calls.push('commit'),
    () => calls.push('revert'),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['revert'])
})

function bodyOf(source: ts.SourceFile, name: string): string {
  let body = ''
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name && node.body) {
      body = node.body.getText(source)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(body, `не найдено тело ${name}`)
  return body
}

// ⚠️ Сторож на возврат прежнего поведения: раньше onDragEnd и onTransformEnd
// откатывали жест по одному лишь `!canMutateItems`, не спрашивая, держит ли
// объект кто-то живой. Аренду просят ПАРАЛЛЕЛЬНО жесту, и к отпусканию она
// почти никогда не успевает — то есть откатывался КАЖДЫЙ перенос и КАЖДОЕ
// изменение размера на сетевой доске.
test('фиксация жестов холста идёт только через commitGestureWithLease', () => {
  const source = ts.createSourceFile(
    'itemHelpers.ts',
    readFileSync(new URL('./itemHelpers.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  for (const fn of ['onDragEnd', 'onTransformEnd', 'commitTextTransform']) {
    const text = bodyOf(source, fn)
    assert.match(text, /commitGestureWithLease\(/, `${fn} обязана фиксировать жест через аренду`)
    assert.doesNotMatch(
      text,
      /if \(!store\.canMutateItems\(/,
      `${fn} не имеет права откатывать жест по отсутствию своей аренды`,
    )
  }
})
