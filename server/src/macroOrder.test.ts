import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Библиотека макросов шлёт на перенумерацию ТОЛЬКО те макросы, у которых есть
// кнопка (`slotted` в MacroLibrary). Сервер же сверял список со ВСЕМИ макросами
// области — включая те, что остались без кнопки. Один такой макрос делал
// перетаскивание невозможным навсегда: каждый бросок отвечал 409, а починить
// это пользователь не мог ничем.

async function withStore(
  t: { after(fn: () => Promise<void> | void): void },
): Promise<typeof import('./workflows.js')> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-macro-order-'))
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    delete process.env.CANAI_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return import(`./workflows.js?order=${path.basename(dir)}`)
}

const graph = { nodes: [], edges: [] }

test('контроль: обычная перестановка кнопок работает', async (t) => {
  const { workflowStore } = await withStore(t)
  for (let i = 0; i < 3; i++) {
    await workflowStore.saveMacro(`Макрос ${i + 1}`, graph, undefined, i, undefined, 'canvas')
  }
  const before = (await workflowStore.listMacros())
    .filter((m) => (m.scope ?? 'canvas') === 'canvas' && m.slot != null)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))

  const ids = before.map((m) => m.id)
  const moved = [ids[1], ids[0], ids[2]]
  const after = await workflowStore.reorderMacros('canvas', moved)

  const slots = new Map(after.map((m) => [m.id, m.slot]))
  assert.equal(slots.get(moved[0]), 0)
  assert.equal(slots.get(moved[1]), 1)
  assert.equal(slots.get(moved[2]), 2)
})

test('макрос без кнопки не должен ломать перестановку остальных', async (t) => {
  const { workflowStore } = await withStore(t)
  // все девять кнопок заняты
  for (let i = 0; i < 9; i++) {
    await workflowStore.saveMacro(`Макрос ${i + 1}`, graph, undefined, i, undefined, 'canvas')
  }
  // десятый остаётся без кнопки — библиотека рисует его как «Не видно в баре»
  await workflowStore.saveMacro('Сирота', graph, undefined, undefined, undefined, 'canvas')

  const canvas = (await workflowStore.listMacros()).filter((m) => (m.scope ?? 'canvas') === 'canvas')
  const orphans = canvas.filter((m) => m.slot == null)
  assert.equal(orphans.length, 1, 'предпосылка теста: макрос без кнопки существует')

  const slotted = canvas
    .filter((m) => m.slot != null)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  // ровно то, что шлёт клиент: только макросы с кнопками
  const ids = slotted.map((m) => m.id)
  const moved = [ids[1], ids[0], ...ids.slice(2)]

  const after = await workflowStore.reorderMacros('canvas', moved)
  const slots = new Map(after.map((m) => [m.id, m.slot]))
  assert.equal(slots.get(moved[0]), 0)
  assert.equal(slots.get(moved[1]), 1)
  // макрос без кнопки так и остаётся без неё, а не отбирает чужую
  assert.equal(slots.get(orphans[0].id), undefined)
})

test('перестановка отвергается, если список правда разошёлся с диском', async (t) => {
  const { workflowStore, MacroOrderMismatchError } = await withStore(t)
  for (let i = 0; i < 3; i++) {
    await workflowStore.saveMacro(`Макрос ${i + 1}`, graph, undefined, i, undefined, 'canvas')
  }
  const ids = (await workflowStore.listMacros())
    .filter((m) => m.slot != null)
    .map((m) => m.id)

  await assert.rejects(
    () => workflowStore.reorderMacros('canvas', [ids[0], 'выдуманный-id', ids[2]]),
    MacroOrderMismatchError,
  )
  await assert.rejects(
    () => workflowStore.reorderMacros('canvas', [ids[0], ids[0], ids[1]]),
    MacroOrderMismatchError,
  )
})

// ⚠️ Сторожа на потерю макроса (20.08.2026): падение редактора записало поверх
// «Кожи лица» урезанный граф — 3 ноды из 10, и резервной копии не было.
test('заметное похудение макроса попадает в лог, обычная правка — нет', async () => {
  const { macroShrinkNote } = await import('./workflows.js')
  assert.equal(macroShrinkNote('Кожа лица', 10, 3)?.includes('nodes 10 → 3'), true)
  assert.match(macroShrinkNote('Кожа лица', 10, 3) ?? '', /macros\.json\.bak/)
  // убрали одну ноду из десяти — это работа, а не потеря
  assert.equal(macroShrinkNote('Кожа лица', 10, 9), null)
  // половина и меньше — уже повод записать
  assert.ok(macroShrinkNote('Мелкий', 10, 5))
  assert.ok(macroShrinkNote('Мелкий', 10, 4))
  assert.equal(macroShrinkNote('Мелкий', 10, 6), null)
  // у крошечных макросов колебания на одну-две ноды — норма
  assert.equal(macroShrinkNote('Малыш', 3, 1), null)
})

test('число нод считается и у повреждённого графа', async () => {
  const { macroNodeCount } = await import('./workflows.js')
  assert.equal(macroNodeCount({ nodes: [1, 2, 3] }), 3)
  assert.equal(macroNodeCount({ nodes: 'ерунда' }), 0)
  assert.equal(macroNodeCount(null), 0)
  assert.equal(macroNodeCount(undefined), 0)
})
