import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

// Действия над библиотекой своих помощников: правка, копия, удаление,
// документы знаний и то, чем включённый помощник отвечает в диалоге.
//
// До 02.10.2026 у этих действий не было ни одного теста, а модуль в тот день
// разложили на части (хранилище, документы, пределы, обмен файлом). Здесь
// закреплено то, что обязано было остаться прежним.

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-assistants-'))
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
const assistants = await import('./assistants.js')

const stateFile = path.join(dataDir, 'assistants.json')
const docsDir = path.join(dataDir, 'assistant-docs')
const docFile = (id: string): string => path.join(docsDir, `${id}.txt`)
// ⚠️ Считаем только файлы документов — по имени. Антивирус, проверяя только
// что удалённый файл, на миг оставляет рядом свой «ИМЯ.tmp», и сверка «всё,
// что есть в папке» от этого мигала.
const DOC_FILE = /^[0-9a-f-]{36}\.txt$/u
const docFiles = async (): Promise<string[]> => (await fs.readdir(docsDir).catch(() => [] as string[])).filter((name) => DOC_FILE.test(name)).sort()
const find = async (id: string) => (await assistants.listAssistants()).presets.find((item) => item.id === id)

/** Запись библиотеки не проходит: файл занят. Документы при этом пишутся. */
function lockLibrary(t: TestContext): () => void {
  const realRename = fs.rename
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === stateFile) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return realRename(...args)
  })
  t.mock.method(console, 'error', () => {})
  return () => mock.mock.restore()
}
const notSaved = (error: unknown): boolean => (
  error instanceof assistants.AssistantsStoreError && /^Could not save assistants:/u.test(error.message)
)

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  delete process.env.CANAI_ENV_FILE
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
})

test('правка помощника режет по пределам и не теряет ни документы, ни место в ряду', async () => {
  const created = await assistants.saveAssistant({ name: `  ${'и'.repeat(200)}  `, instructions: 'п'.repeat(30_000), modelId: 'нет-такой' })
  assert.equal(created.name.length, 80)
  assert.equal(created.instructions.length, assistants.MAX_INSTRUCTIONS_CHARS)
  assert.equal(created.modelId, 'gemini', 'незнакомая модель заменяется текстовой по умолчанию')
  assert.equal((await assistants.saveAssistant({ name: '   ', instructions: '', modelId: 'gemini' })).name, 'Assistant')

  const doc = await assistants.addAssistantDoc(created.id, 'бренд.txt', 'Цвета бренда: вермилион.')
  const edited = await assistants.saveAssistant({ id: created.id, name: 'Арт-директор', instructions: 'Проверяй свет.', modelId: 'claude' })
  assert.deepEqual(edited, { ...created, name: 'Арт-директор', instructions: 'Проверяй свет.', modelId: 'claude', docs: [doc] })
})

// Число «N знаков» у документа видит человек, и значить оно обязано одно и то
// же у приложенного в окне и у принятого из файла: знак — кодовая точка, а не
// единица UTF-16, эмодзи — один знак. У приёма это было закреплено, здесь нет.
test('длина приложенного документа считается в знаках', async () => {
  const preset = await assistants.saveAssistant({ name: 'Смайлы', instructions: '', modelId: 'gemini' })
  assert.equal((await assistants.addAssistantDoc(preset.id, 'смайлы.txt', '😀😀')).chars, 2)
  assert.equal((await find(preset.id))?.docs[0]?.chars, 2, 'и в библиотеку записано то же число')
})

test('копия уносит документы файлами: удаление оригинала её знаний не трогает', async () => {
  const source = await assistants.saveAssistant({ name: 'Редактор', instructions: 'Правь текст', modelId: 'gemini' })
  const kept = await assistants.addAssistantDoc(source.id, 'правила.md', 'Правило первое.')
  const lost = await assistants.addAssistantDoc(source.id, 'пропал.txt', 'Этого файла на диске не будет.')
  await fs.rm(docFile(lost.id))

  const copy = await assistants.duplicateAssistant(source.id)
  assert.equal(copy.name, 'Редактор (copy)')
  assert.equal(copy.instructions, 'Правь текст')
  assert.deepEqual(copy.docs.map((doc) => doc.name), ['правила.md'], 'пропавший документ копию не роняет, а пропускается')
  assert.notEqual(copy.docs[0]?.id, kept.id)

  await assistants.deleteAssistant(source.id)
  await assert.rejects(() => fs.access(docFile(kept.id)), 'документы удалённого помощника убраны с диска')
  assert.deepEqual((await assistants.exportAssistant(copy.id)).docs, [{ name: 'правила.md', text: 'Правило первое.' }])
  await assert.rejects(() => assistants.duplicateAssistant(source.id), /Assistant not found/u)
})

test('библиотека не записалась — документы без хозяина на диске не остаются', async (t) => {
  const preset = await assistants.saveAssistant({ name: 'Сценарист', instructions: '', modelId: 'gemini' })
  await assistants.addAssistantDoc(preset.id, 'сцены.txt', 'Сцена первая.')
  const before = await docFiles()
  const unlock = lockLibrary(t)

  await assert.rejects(() => assistants.addAssistantDoc(preset.id, 'ещё.txt', 'Сцена вторая.'), notSaved)
  await assert.rejects(() => assistants.duplicateAssistant(preset.id), notSaved)
  unlock()

  assert.deepEqual(await docFiles(), before)
  assert.deepEqual((await find(preset.id))?.docs.map((doc) => doc.name), ['сцены.txt'])
})

test('включён один помощник или никто; удалённый выключается сам', async () => {
  const preset = await assistants.saveAssistant({ name: 'Включаемый', instructions: '', modelId: 'gemini' })
  assert.equal((await assistants.setActiveAssistant(preset.id)).activeId, preset.id)
  assert.equal((await assistants.setActiveAssistant('нет-такого')).activeId, null, 'несуществующего включить нельзя')
  await assistants.setActiveAssistant(preset.id)
  await assistants.deleteAssistant(preset.id)
  assert.equal((await assistants.listAssistants()).activeId, null)
  assert.equal(await assistants.activeAssistantContext(), null)
})

// Системный промпт включённого помощника — инструкции и тексты документов.
// Больше 40 000 знаков знаний модели не шлём: дальше это деньги на ветер.
test('включённый помощник отвечает своей моделью, инструкциями и документами в пределах бюджета', async () => {
  const preset = await assistants.saveAssistant({ name: 'Знаток', instructions: '  Отвечай по документам.  ', modelId: 'claude' })
  await assistants.addAssistantDoc(preset.id, 'первый.txt', 'я'.repeat(30_000))
  const gone = await assistants.addAssistantDoc(preset.id, 'пропал.txt', 'нет на диске')
  await assistants.addAssistantDoc(preset.id, 'второй.txt', `${'ю'.repeat(9_999)}😀${'э'.repeat(5_000)}`)
  await assistants.addAssistantDoc(preset.id, 'третий.txt', 'до него бюджет не доходит')
  await fs.rm(docFile(gone.id))
  await assistants.setActiveAssistant(preset.id)

  const context = await assistants.activeAssistantContext()
  assert.equal(context?.modelId, 'claude')
  assert.equal(context?.systemPrompt, [
    'Отвечай по документам.',
    `Document “первый.txt”:\n${'я'.repeat(30_000)}`,
    // Остаток бюджета — 10 000 знаков: эмодзи на границе входит целиком.
    `Document “второй.txt”:\n${'ю'.repeat(9_999)}😀`,
  ].join('\n\n'))

  const bare = await assistants.saveAssistant({ name: 'Без всего', instructions: '   ', modelId: 'gemini' })
  await assistants.setActiveAssistant(bare.id)
  assert.deepEqual(await assistants.activeAssistantContext(), { modelId: 'gemini', systemPrompt: '' })
})
