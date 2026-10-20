import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EVERYONE, assistantsBench, failure } from './assistantsStoreTestKit.js'

// Восстановление библиотеки помощников из запасной копии: основной файл не
// разбирается, а assistants.json.bak цел. Запись, отказ и занятый файл — в
// assistantsStore.test.ts.
//
// ⚠️ Раньше нечитаемый файл считался пустым списком, и первая же запись
// хоронила и его, и копию (находка проверки 02.10.2026). Теперь список берётся
// из копии, испорченный файл откладывается рядом, а копия встаёт на его место.

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-assistants-recovery-'))
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
const assistants = await import('./assistants.js')
const { parseAssistantsState } = await import('./assistantsFormat.js')

const {
  stateFile, backupFile, text, journal, names, stored, asideFiles, storeRefusal, disk, reset, library, truncate,
} = assistantsBench(dataDir, assistants)

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  delete process.env.CANAI_ENV_FILE
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
})

test('испорченный файл — не пустой список: помощники берутся из запасной копии, испорченный отложен рядом', async (t) => {
  await reset(t)
  const { first } = await library()
  const backup = await text(backupFile)
  const broken = await truncate(stateFile)

  assert.deepEqual(await names(), EVERYONE, 'список не пуст: он из запасной копии')
  const aside = await asideFiles()
  assert.equal(aside.length, 1, 'испорченный файл не потерян')
  assert.match(aside[0] ?? '', /^assistants\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/u, 'в имени — отметка времени')
  assert.equal(await text(path.join(dataDir, aside[0] ?? '')), broken)
  assert.equal(await text(stateFile), backup, 'на место файла вернулась копия')
  assert.match(await journal(), /cannot be parsed .* list restored from backup:  assistants 3/u)
  assert.ok((await journal()).includes(aside[0] ?? '-'), 'в журнале названо, куда отложен испорченный файл')

  // То самое действие, которое раньше добивало библиотеку: запись после сбоя.
  await assistants.importAssistant({ name: 'Новый', instructions: '', modelId: 'gemini', docs: [] })
  assert.deepEqual(await names(), [...EVERYONE, 'Новый'])
  assert.deepEqual(stored(await text(backupFile)), EVERYONE, 'в копии — помощники, а не обрезок')
  assert.deepEqual(
    (await assistants.exportAssistant(first)).docs,
    [{ name: 'бренд.txt', text: 'Цвета бренда: вермилион.' }],
    'документы прежних помощников остались при хозяине',
  )
  assert.equal((await asideFiles()).length, 1, 'повторно откладывать нечего')
})

// ⚠️ Находка проверки 02.10.2026: запасная копия на шаг старше файла. Если
// последним перед порчей было «убрать документ» или удаление помощника, копия
// ещё числит документы, файлы которых то действие уже стёрло. Вернувшийся из
// неё помощник показывал их в окне, а в ответы и в файл обмена они не
// попадали — «тот же самый, только поглупел».
test('после восстановления помощник не числит документы, файлов которых уже нет', async (t) => {
  await reset(t)
  const { first, docId } = await library()
  const kept = await assistants.addAssistantDoc(first, 'правила.txt', 'Правило первое.')
  await assistants.removeAssistantDoc(first, docId) // файл «бренд.txt» стёрт, а копия его ещё числит
  await truncate(stateFile)

  const docs = async () => (await assistants.listAssistants()).presets.find((item) => item.id === first)?.docs
  assert.deepEqual(await docs(), [kept], 'пропавший документ из списка убран, уцелевший остался')
  assert.match(await journal(), /Documents whose files are no longer on disk were removed from the list:  assistant “Арт-директор” — «бренд\.txt»$/mu)
  // На место файла встал уже выверенный список: следующее чтение убранное не вернёт.
  assert.deepEqual(parseAssistantsState(await text(stateFile)).presets[0]?.docs, [kept])
  assert.deepEqual(await docs(), [kept])
  assert.deepEqual(
    (await assistants.exportAssistant(first)).docs,
    [{ name: 'правила.txt', text: 'Правило первое.' }],
    'окно и файл обмена говорят одно',
  )
})

test('помощник, удалённый перед порчей, возвращается из копии без стёртых документов', async (t) => {
  await reset(t)
  const { first } = await library()
  for (let index = 1; index <= 11; index += 1) await assistants.addAssistantDoc(first, `глава-${index}.txt`, 'текст')
  await assistants.deleteAssistant(first)
  await truncate(stateFile)

  const state = await assistants.listAssistants()
  assert.deepEqual(state.presets.map((item) => item.name), EVERYONE, 'удаление в копию не попало — помощник вернулся')
  assert.deepEqual(state.presets[0]?.docs, [], 'а файлы его документов стёрты — в списке их нет')
  assert.deepEqual(await assistants.activeAssistantContext(), { modelId: 'gemini', systemPrompt: 'Проверяй композицию' })
  // Строка журнала обозрима: десять названий, остальные — числом.
  assert.match(await journal(), /assistant “Арт-директор” — «бренд\.txt», «глава-1\.txt», .*«глава-9\.txt» and 2$/mu)
})

test('занятый файл документа — не пропавший: из списка он не убирается', async (t) => {
  await reset(t)
  const { first, docId } = await library()
  const backup = await text(backupFile)
  await truncate(stateFile)
  const realAccess = fs.access
  const busy = t.mock.method(fs, 'access', async (...args: Parameters<typeof fs.access>) => {
    if (String(args[0]).endsWith(`${docId}.txt`)) throw failure('EBUSY')
    return realAccess(...args)
  })
  const state = await assistants.listAssistants()
  assert.equal(busy.mock.callCount(), 1, 'наличие файла документа спрашивают через fs.access — иначе подмена ничего не проверяет')
  busy.mock.restore()

  assert.deepEqual(state.presets.find((item) => item.id === first)?.docs.map((doc) => doc.id), [docId])
  assert.equal(await text(stateFile), backup, 'убирать нечего — на место файла встала копия слово в слово')
  assert.doesNotMatch(await journal(), /из списка убраны/u)
})

test('восстановление не удалось — отказ, файлы как были, лишних копий не остаётся', async (t) => {
  await reset(t)
  await library()
  await truncate(stateFile)
  const before = await disk()
  const refused = storeRefusal(/corrupted and could not be restored/u)

  // Испорченный файл не удалось отложить — на его место ничего не пишем.
  const copy = t.mock.method(fs, 'copyFile', async () => { throw failure('EPERM') })
  await assert.rejects(() => assistants.listAssistants(), refused)
  copy.mock.restore()
  assert.deepEqual(await disk(), before)

  // Отложили, но вернуть копию на место не вышло — отложенный файл убираем.
  const realRename = fs.rename
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === stateFile) throw failure('EPERM')
    return realRename(...args)
  })
  await assert.rejects(() => assistants.listAssistants(), refused)
  rename.mock.restore()
  assert.deepEqual(await disk(), before)

  assert.deepEqual(await names(), EVERYONE, 'следующая попытка восстанавливает список')
})
