import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

/**
 * Изменение размера нескольких объектов не рвёт связь (пункт 1.5 аудита
 * сетевой доски 24.09.2026, находка П-7).
 *
 * Transformer шлёт `transform` КАЖДОЙ ноде группы на каждое движение мыши, и
 * каждая из них собирала кадр всей группы и отправляла коллегам: 10 объектов
 * — около 600 сообщений в секунду, а сервер команды рвёт соединение после
 * 3000 в минуту. Считалось это поиском по всей доске на каждый объект — до
 * 0,76 с на движение мыши при сотне объектов, и на локальной доске тоже.
 */

// Исполняем сам обработчик из исходника; подменяем только часы и соседей.
async function handler(file: string, name: string, deps: Record<string, unknown>) {
  const path = new URL(file, import.meta.url)
  const source = ts.createSourceFile(file, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found: ts.FunctionDeclaration | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(found, name)
  const js = ts.transpileModule(found.getText(source).replace(/^export /u, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(deps), `${js}; return ${name}`)(...Object.values(deps))
}

function board(count: number, collaborative: boolean) {
  const ids = Array.from({ length: count }, (_, index) => `item_${index}`)
  const frames: Array<Array<{ id: string; w: number }>> = []
  let searches = 0
  const layer = {
    find: (match: (node: FakeNode) => boolean) => {
      searches += 1
      return nodes.filter(match)
    },
  }
  interface FakeNode {
    id(): string; x(): number; y(): number; scaleX(): number; scaleY(): number
    rotation(): number; getLayer(): typeof layer
  }
  const nodes: FakeNode[] = ids.map((id) => ({
    id: () => id, x: () => 0, y: () => 0, scaleX: () => 1.5, scaleY: () => 1.5,
    rotation: () => 0, getLayer: () => layer,
  }))
  const store = {
    getSelectedIds: () => new Set(ids),
    canMutateItems: () => true,
    getItem: (id: string) => ({ id, w: 100, h: 50 }),
    getPending: () => [],
    getCollaboration: () => collaborative
      ? { setPreview: (items: Array<{ id: string; w: number }> | null) => { if (items) frames.push(items) } }
      : null,
  }
  return { store, nodes, frames, searches: () => searches }
}

async function preview(clock: { now: number }) {
  return handler('./itemHelpers.ts', 'onTransformPreview', {
    transformPreviewSentAt: new WeakMap(),
    GESTURE_FRAME_MS: 50,
    snapTransform: () => {},
    Date: { now: () => clock.now },
  })
}

test('движение мыши при изменении размера группы — один кадр на всю группу', async () => {
  const clock = { now: 1_000 }
  const onTransformPreview = await preview(clock)
  const group = board(10, true)
  // Одно движение мыши: Transformer зовёт обработчик у каждой ноды группы.
  for (const node of group.nodes) onTransformPreview(group.store, node.id(), node)
  assert.equal(group.frames.length, 1, 'кадр один, а не по кадру на объект')
  assert.equal(group.frames[0]!.length, 10, 'и в нём вся группа')
  assert.equal(group.frames[0]![3]!.w, 150, 'с живым размером')
  assert.equal(group.searches(), 1, 'один обход доски на кадр, а не по обходу на объект')
})

test('кадры изменения размера уходят не чаще, чем у переноса', async () => {
  const clock = { now: 1_000 }
  const onTransformPreview = await preview(clock)
  const group = board(10, true)
  const move = () => { for (const node of group.nodes) onTransformPreview(group.store, node.id(), node) }
  move()
  clock.now += 20
  move()
  assert.equal(group.frames.length, 1, 'через 20 мс кадра нет')
  clock.now += 40
  move()
  assert.equal(group.frames.length, 2, 'через 60 мс — следующий')
})

test('на локальной доске кадров не собирают вовсе', async () => {
  const clock = { now: 1_000 }
  const onTransformPreview = await preview(clock)
  const group = board(100, false)
  for (const node of group.nodes) onTransformPreview(group.store, node.id(), node)
  assert.equal(group.searches(), 0, 'слать некому — и искать нечего')
})

/**
 * ⚠️ Трансформер завершает жест по объекту за раз, и каждый объект уходил
 * своим updateItem: изменение размера группы давало по шагу отмены на объект
 * и по правке на объект на сетевой доске (находка С-3 аудита 24.09.2026).
 */
test('изменение размера группы завершается одной правкой на всю группу', async () => {
  const updates: Array<Array<{ id: string; patch: { w?: number; h?: number } }>> = []
  const store = {
    getCollaboration: () => null,
    getItem: (id: string) => ({ id, w: 100, h: 50 }),
    getPending: () => [],
    getSelectedIds: () => new Set(['a', 'b', 'c']),
    updateItems: (changes: Array<{ id: string; patch: { w?: number; h?: number } }>) => updates.push(changes),
    updateItem: () => { throw new Error('по объекту за раз — это и была беда') },
  }
  const leases: string[][] = []
  const commitGestureWithLease = (_store: unknown, ids: string[], commit: () => void) => {
    leases.push(ids)
    commit()
  }
  const queueTransformCommit = await handler('./itemHelpers.ts', 'queueTransformCommit', {
    transformBatches: new WeakMap(),
    commitGestureWithLease,
  })
  const onTransformEnd = await handler('./itemHelpers.ts', 'onTransformEnd', {
    clearGuides: () => {},
    queueTransformCommit,
    commitGestureWithLease,
  })
  const node = () => {
    let sx = 2
    let sy = 3
    return {
      x: () => 10, y: () => 20, rotation: () => 0,
      scaleX: (value?: number) => (value === undefined ? sx : (sx = value)),
      scaleY: (value?: number) => (value === undefined ? sy : (sy = value)),
      position: () => {}, getLayer: () => null,
    }
  }
  for (const id of ['a', 'b', 'c']) onTransformEnd(store, id, node())
  assert.equal(updates.length, 0, 'до конца такта жест ещё собирается')
  await Promise.resolve()
  assert.equal(updates.length, 1, 'одна правка на всю группу')
  assert.deepEqual(updates[0]!.map(({ id }) => id), ['a', 'b', 'c'])
  assert.deepEqual(updates[0]![0]!.patch, { x: 10, y: 20, rotation: 0, w: 200, h: 150 })
  assert.deepEqual(leases, [['a', 'b', 'c']], 'и одна проверка права на всю группу')
})
