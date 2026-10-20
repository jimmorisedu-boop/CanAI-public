import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EVERYONE, assistantsBench, failure } from './assistantsStoreTestKit.js'

// Библиотека помощников на диске и её запасная копия: запись, отказ и занятый
// файл. Восстановление из копии — в assistantsRecovery.test.ts.
//
// ⚠️ Находка проверки 02.10.2026: нечитаемый assistants.json считался ПУСТЫМ.
// Человек видел «помощников ещё нет», делал любое действие с записью — и перед
// ней в .bak ложился уже испорченный файл, а следом библиотека из одного
// нового помощника. Пропадали и список, и копия, заведённая ровно на этот
// случай. Прежний тест .bak проверял только обычную запись и этого не ловил.

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-assistants-store-'))
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
const assistants = await import('./assistants.js')
const store = await import('./assistantsStore.js')
const { parseAssistantsState } = await import('./assistantsFormat.js')

const {
  stateFile, backupFile, text, journal, names, stored, asideFiles, tempFiles, storeRefusal, disk, reset, library, truncate,
} = assistantsBench(dataDir, assistants)

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  delete process.env.CANAI_ENV_FILE
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
})

test('файла нет — список пуст; в запасную копию ложится прежнее состояние, и только оно', async (t) => {
  await reset(t)
  assert.deepEqual(await assistants.listAssistants(), { presets: [], activeId: null })

  await assistants.saveAssistant({ name: 'Первый', instructions: '', modelId: 'gemini' })
  await assert.rejects(() => fs.access(backupFile), 'копировать ещё нечего: до первой записи файла не было')

  const before = await text(stateFile)
  await assistants.saveAssistant({ name: 'Второй', instructions: '', modelId: 'gemini' })
  assert.equal(await text(backupFile), before, 'копия — слово в слово то, что лежало до записи')
  assert.deepEqual(stored(await text(stateFile)), ['Первый', 'Второй'])
  assert.deepEqual(await tempFiles(), [], 'временных файлов не осталось')
})

// Копия — страховка, а не условие записи. Её файл может держать антивирус или
// открытый редактор: из-за этого человек не должен терять возможность
// сохранить помощника.
test('запасная копия не легла — библиотека всё равно записывается, прежняя копия цела', async (t) => {
  await reset(t)
  await library()
  const backup = await text(backupFile)
  const realRename = fs.rename
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === backupFile) throw failure('EPERM')
    return realRename(...args)
  })
  await assistants.saveAssistant({ name: 'Новый', instructions: '', modelId: 'gemini' })
  rename.mock.restore()

  assert.deepEqual(await names(), [...EVERYONE, 'Новый'])
  assert.equal(await text(backupFile), backup, 'прежняя копия не тронута')
  assert.deepEqual(await tempFiles(), [], 'временных файлов не осталось')
})

test('не разбираются оба файла — отказ словами и никакой записи', async (t) => {
  await reset(t)
  const { first, docId } = await library()
  await truncate(stateFile)
  await truncate(backupFile)
  const before = await disk()

  const refused = storeRefusal(/^The assistant list cannot be read:/u)
  const doc = { name: 'док', text: 'текст' }
  await assert.rejects(() => assistants.listAssistants(), refused)
  await assert.rejects(() => assistants.saveAssistant({ name: 'Новый', instructions: '', modelId: 'gemini' }), refused)
  await assert.rejects(() => assistants.importAssistant({ name: 'Из файла', instructions: '', modelId: 'gemini', docs: [doc] }), refused)
  await assert.rejects(() => assistants.exportAssistant(first), refused)
  await assert.rejects(() => assistants.duplicateAssistant(first), refused)
  await assert.rejects(() => assistants.setActiveAssistant(null), refused)
  await assert.rejects(() => assistants.addAssistantDoc(first, 'ещё.txt', 'текст'), refused)
  await assert.rejects(() => assistants.removeAssistantDoc(first, docId), refused)
  await assert.rejects(() => assistants.deleteAssistant(first), refused)

  assert.deepEqual(await disk(), before, 'на диске не изменилось ничего: ни файлы библиотеки, ни документы')
  // Диалог с помощником при этом не падает: вопрос уходит как без помощника.
  assert.equal(await assistants.activeAssistantContext(), null)
  // В журнал — один раз на беду, а не на каждое обращение.
  assert.equal((await journal()).split('\n').filter((line) => line.includes('assistant list cannot be read')).length, 1)
})

test('файл испорчен, а запасной копии нет — отказ, а не пустой список', async (t) => {
  await reset(t)
  await fs.writeFile(stateFile, '{"presets":[{"id":"a","name":"Обре')
  const before = await disk()
  const refused = storeRefusal(/assistant list cannot be read/u)
  await assert.rejects(() => assistants.listAssistants(), refused)
  await assert.rejects(() => assistants.saveAssistant({ name: 'Новый', instructions: '', modelId: 'gemini' }), refused)
  assert.deepEqual(await disk(), before, 'ни копии из обрезка, ни новой библиотеки поверх него')
})

test('файл, который не разбирается, не перезаписывается и в запасную копию не попадает', async (t) => {
  await reset(t)
  await library()
  const backup = await text(backupFile)
  const broken = await truncate(stateFile)

  // Запись без чтения: в обычной работе так не бывает, это страховка.
  await assert.rejects(
    () => store.withAssistantsLock(() => store.writeAssistantsState({ presets: [], activeId: null })),
    storeRefusal(/did not overwrite it/u),
  )
  assert.equal(await text(stateFile), broken)
  assert.equal(await text(backupFile), backup, 'хорошая копия цела')
})

test('занятый файл — не испорченный: копией его не подменяем и ничего не трогаем', async (t) => {
  await reset(t)
  const { first } = await library()
  const before = await disk()
  const realRead = fs.readFile as (...args: unknown[]) => Promise<unknown>
  let locked = stateFile
  const busy = t.mock.method(fs, 'readFile', async (...args: unknown[]) => {
    if (args[0] === locked) throw failure('EBUSY')
    return realRead(...args)
  })
  const refused = storeRefusal(/^The assistant list cannot be read: its file is locked/u)
  await assert.rejects(() => assistants.listAssistants(), refused)
  await assert.rejects(() => assistants.setActiveAssistant(null), refused)
  locked = ''
  assert.deepEqual(await disk(), before)
  const state = await assistants.listAssistants()
  assert.equal(state.activeId, first, 'после блокировки — свежий список, а не тот, что на шаг старше')

  // Файл испорчен, а занята запасная копия: она не «повреждена» — ждём её.
  const broken = await truncate(stateFile)
  locked = backupFile
  await assert.rejects(() => assistants.listAssistants(), refused)
  locked = ''
  assert.equal(await text(stateFile), broken)
  assert.deepEqual(await asideFiles(), [])
  busy.mock.restore()
  assert.deepEqual(await names(), EVERYONE, 'копия освободилась — список вернулся из неё')
})

test('что считается библиотекой: записи без id и не тот вид файла — порча, а не пустота', () => {
  const broken = [
    '', '   ', 'null', '[]', '{}', '{"presets":{}}', '{"presets":[null]}', '{"presets":[{"name":"без id"}]}',
    '{"presets":[{"id":"a","docs":[{"name":"документ без id"}]}]}',
  ]
  for (const raw of broken) assert.throws(() => parseAssistantsState(raw), `не библиотека: ${JSON.stringify(raw)}`)

  // Метка порядка байтов от Блокнота файл не портит; недостающее берёт умолчания.
  const state = parseAssistantsState(`${String.fromCharCode(0xfeff)}{"presets":[{"id":"a","docs":[{"id":"d"}]}],"activeId":"нет такого"}`)
  assert.deepEqual(state, {
    presets: [{ id: 'a', name: 'Assistant', instructions: '', modelId: 'gemini', docs: [{ id: 'd', name: 'document', chars: 0 }], slot: 0 }],
    activeId: null,
  })
})
