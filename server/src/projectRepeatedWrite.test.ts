import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// ⚠️ Вкладка сохранила доску, сервер записал, а ответ до неё не дошёл: сорвалось
// соединение, истекли 30 секунд ожидания, сервер упал сразу после записи.
// Вкладка повторяет запись со старым номером ревизии — и раньше получала
// конфликтную копию «из-за другой вкладки», которой не было вовсе. Защищать
// надо ровно от чужих записей, а не от своих же.

const TAB = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB = '22222222-2222-4222-8222-222222222222'
const doc = (x: number) => ({ version: 1, items: [], camera: { x, y: 0, scale: 1 } })

test('повтор своей же записи принимается, чужая запись по-прежнему даёт копию', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-repeated-write-'))
  const previousDataDir = process.env.CANAI_DATA_DIR
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previousDataDir
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
  })
  const { createProject, listProjects, loadProjectSnapshot, mutateProjectSnapshot, saveProjectSnapshot } = await import('./projects.js')

  // 1. Ответ потерялся — повтор со старым номером принимается без копии.
  const board = await createProject('Шабашка')
  assert.deepEqual(await saveProjectSnapshot(board.id, doc(1), 0, TAB), { status: 'saved', revision: 1 })
  assert.deepEqual(
    await saveProjectSnapshot(board.id, doc(2), 0, TAB),
    { status: 'saved', revision: 2, repeatedFrom: 0 },
  )
  // И ещё раз: ответы терялись дважды подряд — всё это записи той же вкладки.
  assert.deepEqual(
    await saveProjectSnapshot(board.id, doc(3), 0, TAB),
    { status: 'saved', revision: 3, repeatedFrom: 0 },
  )
  assert.deepEqual(await loadProjectSnapshot(board.id), { snapshot: doc(3), revision: 3 })
  assert.equal((await listProjects()).some((item) => item.id.startsWith('conflict-')), false, 'копия не нужна')

  // 2. Между записями вкладки доску писала ДРУГАЯ вкладка — копия обязательна.
  assert.deepEqual(await saveProjectSnapshot(board.id, doc(4), 3, OTHER_TAB), { status: 'saved', revision: 4 })
  const clash = await saveProjectSnapshot(board.id, doc(5), 3, TAB)
  assert.equal(clash.status, 'conflict')
  if (clash.status !== 'conflict') throw new Error('ожидался конфликт')
  assert.deepEqual(clash.lastWriter, { kind: 'other-tab', key: OTHER_TAB, base: 3 })
  assert.deepEqual(await loadProjectSnapshot(board.id), { snapshot: doc(4), revision: 4 }, 'чужая правка цела')

  // 3. Результат на доску поставил сам сервер — это тоже не своя запись.
  const delivered = await createProject('Доставка')
  assert.deepEqual(await saveProjectSnapshot(delivered.id, doc(1), 0, TAB), { status: 'saved', revision: 1 })
  assert.equal(await mutateProjectSnapshot(delivered.id, () => doc(9)), 'saved')
  const afterDelivery = await saveProjectSnapshot(delivered.id, doc(2), 1, TAB)
  assert.equal(afterDelivery.status, 'conflict')
  if (afterDelivery.status !== 'conflict') throw new Error('ожидался конфликт')
  assert.deepEqual(afterDelivery.lastWriter, { kind: 'server' })

  // 4. Без ключа сеанса узнать «свою» запись нечем — правило прежнее, строгое.
  const anonymous = await createProject('Без ключа')
  assert.deepEqual(await saveProjectSnapshot(anonymous.id, doc(1), 0), { status: 'saved', revision: 1 })
  const strict = await saveProjectSnapshot(anonymous.id, doc(2), 0)
  assert.equal(strict.status, 'conflict')
  if (strict.status !== 'conflict') throw new Error('ожидался конфликт')
  assert.deepEqual(strict.lastWriter, { kind: 'unknown' })

  // 5. Отметка о писателе живёт в индексе (переживает перезапуск), но наружу не уходит.
  const index = JSON.parse(await fs.readFile(path.join(dir, 'projects.json'), 'utf8')) as Array<{ id: string; writer?: unknown }>
  assert.deepEqual(index.find((item) => item.id === board.id)?.writer, { key: OTHER_TAB, base: 3 })
  assert.equal(Object.hasOwn((await listProjects()).find((item) => item.id === board.id) ?? {}, 'writer'), false)
})

test('конфликт объясняет себя в журнале', async () => {
  const { conflictLine, repeatedWriteLine } = await import('./projectWriteLog.js')
  const line = conflictLine({
    projectId: 'f585c602',
    sessionKey: TAB,
    expectedRevision: 3,
    serverRevision: 4,
    lastWriter: { kind: 'other-tab', key: OTHER_TAB, base: 3 },
    openTabs: 1,
    holder: `${TAB}~вкладка`,
    copyName: 'Шабашка — конфликтная копия',
  })
  assert.match(line, /tab 11111111 wrote over revision 3, and on server already 4/u)
  assert.match(line, /another tab 22222222/u)
  // Одна открытая вкладка при «другой вкладке» в записях — две вкладки под одним именем.
  assert.match(line, /Open tabs: 1/u)
  assert.match(
    repeatedWriteLine({ projectId: 'f585c602', sessionKey: TAB, from: 0, to: 2 }),
    /repeated an entry whose response did not reach it \(revision 0 → 2\)/u,
  )
})
