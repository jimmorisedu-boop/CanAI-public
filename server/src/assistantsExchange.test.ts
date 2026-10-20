import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Помощник файлом: выгрузка отдаёт его целиком, вместе с ТЕКСТАМИ документов
// знаний, а приём кладёт пресет и документы одной операцией. Раньше тексты
// документов наружу не отдавала ни одна ручка — без них обмен терял бы самое
// ценное (просьба владельца 01.10.2026: «предусмотри возможность их сохранять
// и обмениваться друг между другом»).

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-assistants-exchange-'))
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
const assistants = await import('./assistants.js')
const { isInlineFile } = await import('./assistantsExchange.js')
const { CATALOG } = await import('./catalog.js')
const { MAX_NAME_CHARS, countChars, cutChars } = await import('./assistantLimits.js')

const stateFile = path.join(dataDir, 'assistants.json')
const docsDir = path.join(dataDir, 'assistant-docs')
// ⚠️ Считаем только свои файлы — по имени. Антивирус, проверяя только что
// удалённый или заменённый файл, на миг оставляет рядом свой «ИМЯ.tmp», и
// сверка «всё, что есть в папке» от этого мигала.
const DOC_FILE = /^[0-9a-f-]{36}\.txt$/u
const OWN_TEMP = /^assistants\.json(?:\.bak)?\.[0-9a-f-]{36}\.tmp$/u
const docFiles = async (): Promise<string[]> => (await fs.readdir(docsDir).catch(() => [] as string[])).filter((name) => DOC_FILE.test(name)).sort()
const names = async (): Promise<string[]> => (await assistants.listAssistants()).presets.map((item) => item.name)
/** Одинокая половина эмодзи в конце — след резки по единицам UTF-16. */
const endsWithHalf = (text: string): boolean => /[\ud800-\udbff]$/.test(text)

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  delete process.env.CANAI_ENV_FILE
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
})

test('помощник выгружается с текстами документов и принимается обратно отдельным помощником', async () => {
  const source = await assistants.saveAssistant({ name: 'Арт-директор', instructions: 'Проверяй композицию', modelId: 'gemini' })
  await assistants.addAssistantDoc(source.id, 'бренд.txt', 'Цвета бренда: вермилион.')

  const exported = await assistants.exportAssistant(source.id)
  assert.deepEqual(exported, {
    name: 'Арт-директор', instructions: 'Проверяй композицию', modelId: 'gemini',
    docs: [{ name: 'бренд.txt', text: 'Цвета бренда: вермилион.' }],
  })

  const { preset: imported, notes } = await assistants.importAssistant(exported)
  assert.deepEqual(notes, [], 'всё вошло целиком — сообщать не о чем')
  assert.notEqual(imported.id, source.id)
  assert.equal(imported.docs.length, 1)
  assert.notEqual(imported.docs[0]?.id, source.docs[0]?.id, 'документ копируется файлом, а не ссылкой на чужой')

  // Удалили исходного — знания копии целы.
  await assistants.deleteAssistant(source.id)
  assert.deepEqual((await assistants.exportAssistant(imported.id)).docs, exported.docs)
})

// ⚠️ Молча обрезанный помощник выглядит «тем же самым, только поглупевшим»:
// человек видит «загружен» и узнаёт о потере по ответам. Каждая потеря при
// приёме обязана быть названа словами — и ничего сверх неё.
test('приём режет по пределам помощника и о каждой потере говорит словами', async () => {
  const { preset, notes } = await assistants.importAssistant({
    name: `  ${'и'.repeat(200)}  `,
    instructions: 'п'.repeat(30_000),
    modelId: 'модель-которой-нет',
    docs: [
      { name: 'пусто', text: '   ' },
      { name: 'том', text: 'я'.repeat(assistants.MAX_SINGLE_DOC_CHARS + 50) },
      ...Array.from({ length: assistants.MAX_IMPORT_DOCS + 4 }, (_, index) => ({ name: `док-${index}`, text: 'текст' })),
    ],
  })
  assert.equal(preset.name.length, MAX_NAME_CHARS)
  assert.equal(preset.instructions.length, assistants.MAX_INSTRUCTIONS_CHARS)
  assert.equal(preset.modelId, 'gemini', 'незнакомая модель заменяется текстовой по умолчанию')
  assert.equal(preset.docs.length, assistants.MAX_IMPORT_DOCS, 'пустой документ места не занимает, лишние отброшены')
  assert.equal(preset.docs[0]?.chars, assistants.MAX_SINGLE_DOC_CHARS)

  const fallback = CATALOG.find((model) => model.id === 'gemini')?.name
  const expected = [
    /^Name exceeds 80 characters; using the beginning$/u,
    /^Instructions exceed 24,000 characters; using the beginning$/u,
    new RegExp(`^Model “модель-которой-нет” is not available here; selected “${fallback}”$`, 'u'),
    /^Documents in file 25 — using 20$/u,
    /^Document “том” exceeds 200,000 characters; using the beginning$/u,
  ]
  assert.equal(notes.length, expected.length, notes.join(' | '))
  for (const pattern of expected) assert.ok(notes.some((note) => pattern.test(note)), `нет фразы ${pattern}`)
})

// ⚠️ Находка проверки 02.10.2026: у помощника сетевой доски инструкции до
// 24 000 знаков (туда же дописываются знания из файла), а своя доска хранила
// 20 000 — и при переносе файлом хвост пропадал без единого слова.
test('помощник сетевой доски входит на свою целиком: 23 500 знаков инструкций не режутся', async () => {
  const instructions = `${'п'.repeat(23_490)} — хвост`
  const { preset, notes } = await assistants.importAssistant({ name: 'С сетевой доски', instructions, modelId: 'gemini', docs: [] })
  assert.equal(preset.instructions, instructions)
  assert.deepEqual(notes, [])
  // Правка в окне помощника режет по тому же пределу.
  const saved = await assistants.saveAssistant({ id: preset.id, name: preset.name, instructions, modelId: 'gemini' })
  assert.equal(saved.instructions, instructions)
})

test('предел считается в знаках: эмодзи на границе не рвётся пополам', async () => {
  const limit = assistants.MAX_INSTRUCTIONS_CHARS
  const instructions = `${'а'.repeat(limit - 1)}😀хвост`
  const { preset, notes } = await assistants.importAssistant({
    name: 'Эмодзи', instructions, modelId: 'gemini', docs: [{ name: 'смайлы', text: '😀😀' }],
  })
  assert.ok(preset.instructions.endsWith('😀'), 'последний знак вошёл целиком')
  assert.ok(!endsWithHalf(preset.instructions))
  assert.equal(countChars(preset.instructions), limit)
  assert.equal(notes.length, 1)
  assert.equal(preset.docs[0]?.chars, 2, 'длина документа — в знаках, а не в единицах UTF-16')

  const saved = await assistants.saveAssistant({ name: 'Эмодзи руками', instructions, modelId: 'gemini' })
  assert.equal(saved.instructions, preset.instructions)

  // ⚠️ То же правило стоит и на ЧТЕНИИ файла. Знаков здесь ровно предел, а
  // единиц UTF-16 больше: резка по единицам отрывала бы у такого помощника
  // хвост при каждом обращении к библиотеке — записан целиком, а прочитан уже
  // без последнего знака, и без единого слова.
  const named = await assistants.saveAssistant({ name: '😀'.repeat(MAX_NAME_CHARS), instructions, modelId: 'gemini' })
  assert.equal(countChars(named.name), MAX_NAME_CHARS)
  const fromDisk = (await assistants.listAssistants()).presets.find((item) => item.id === named.id)
  assert.equal(fromDisk?.instructions, named.instructions, 'чтение файла режет инструкции иначе, чем запись')
  assert.equal(fromDisk?.name, named.name, 'чтение файла режет название иначе, чем запись')

  // Сама резка: пара суррогатов — один знак, короткая строка не трогается.
  assert.equal(cutChars('а😀б', 2), 'а😀')
  assert.equal(cutChars('😀😀', 1), '😀')
  assert.equal(cutChars('коротко', 100), 'коротко')
  assert.equal(countChars('а😀б'), 3)
})

// ⚠️ Раньше отказ приходил посреди приёма: первые документы уже лежали на
// диске, а помощника в библиотеке не было — файлы оставались без хозяина.
test('встроенный файл вместо текста — отказ, после которого не остаётся ни документов, ни помощника', async () => {
  const before = await docFiles()
  await assert.rejects(
    () => assistants.importAssistant({
      name: 'Плохой', instructions: '', modelId: 'gemini',
      docs: [{ name: 'ok1', text: 'раз' }, { name: 'ok2', text: 'два' }, { name: 'bad', text: 'data:application/pdf;base64,AAAA' }],
    }),
    (error: unknown) => error instanceof assistants.AssistantFileError && /embedded file/u.test(error.message),
  )
  assert.deepEqual(await docFiles(), before, 'документы отказанного помощника на диск не попали')
  assert.ok(!(await names()).includes('Плохой'), 'отказанный помощник в библиотеку не попал')
})

test('библиотека не записалась посреди приёма — документы без хозяина убраны', async (t) => {
  const before = await docFiles()
  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === stateFile) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return realRename(...args)
  })
  t.mock.method(console, 'error', () => {})
  await assert.rejects(
    () => assistants.importAssistant({
      name: 'Не записался', instructions: '', modelId: 'gemini',
      docs: [{ name: 'раз', text: 'раз' }, { name: 'два', text: 'два' }],
    }),
    (error: unknown) => error instanceof assistants.AssistantsStoreError && /Could not save assistants/u.test(error.message),
  )
  renameMock.mock.restore()
  assert.deepEqual(await docFiles(), before)
  assert.ok(!(await names()).includes('Не записался'))
  assert.deepEqual((await fs.readdir(dataDir)).filter((name) => OWN_TEMP.test(name)), [], 'временных файлов не осталось')
})

// ⚠️ Одного слова «data:» в начале мало: так начинается документ в виде YAML
// и обычная фраза — их принимали за встроенную картинку и не пускали
// помощника целиком.
const INLINE_CASES: Array<[text: string, inline: boolean]> = [
  ['data:image/png;base64,AAAA', true],
  ['  data:application/pdf;base64,AAAA', true],
  ['data:image/svg+xml;charset=utf-8,<svg/>', true],
  ['DATA:IMAGE/JPEG;BASE64,/9j/', true],
  ['data:;base64,AAAA', true],
  ['data:\n  brand: вермилион\n', false],
  ['Data: use the brand palette in every answer', false],
  ['data: 2026-10-01, продажи выросли', false],
  ['Используй data: из таблицы', false],
]

test('текст, который начинается со слова «data:», — обычный документ, а не встроенный файл', async () => {
  for (const [text, inline] of INLINE_CASES) assert.equal(isInlineFile(text), inline, JSON.stringify(text))

  const plain = INLINE_CASES.filter(([, inline]) => !inline).map(([text], index) => ({ name: `док-${index}`, text }))
  const { preset, notes } = await assistants.importAssistant({ name: 'YAML', instructions: 'Data: бренд', modelId: 'gemini', docs: plain })
  assert.equal(preset.docs.length, plain.length)
  assert.deepEqual(notes, [])
  assert.deepEqual((await assistants.exportAssistant(preset.id)).docs.map((doc) => doc.text), plain.map((doc) => doc.text))
})

// До сервера файл проходит проверку приложения. Если сервер строже — файл
// пройдёт одну дверь и упрётся во вторую, уже с другим сообщением.
// ⚠️ Тексты на грани нужны нарочно: прежнее выражение сервера считало
// встроенным файлом и «data:,…» без типа, а приложение такой текст пропускало —
// на девяти очевидных примерах выше это расхождение не видно.
const INLINE_EDGES = [
  'data:,просто текст после запятой',
  'data:;charset=utf-8,текст без типа',
  'data:;charset=utf-8;base64,AAAA',
  'data:text/plain,привет',
  'data:image/_x,1',
  'data:image/png',
  'data:a/b,c',
  ' \n data:image/png;base64,AAAA',
]

test('сервер не строже приложения в том, что считать встроенным файлом', async () => {
  const { hasInlineMedia } = await import('../../client/src/spaces/canvas/libraryFile.js')
  for (const text of [...INLINE_CASES.map(([value]) => value), ...INLINE_EDGES]) {
    if (isInlineFile(text)) assert.ok(hasInlineMedia(text), `приложение пропустит, а сервер откажет: ${JSON.stringify(text)}`)
  }
  // Своё дело сервер при этом делает: настоящий встроенный файл не проходит.
  assert.ok(isInlineFile('data:application/pdf;base64,JVBERi0x'))
})

// Общего модуля у приложения и сервера нет, поэтому числа живут в трёх
// местах. Разъедутся — помощник снова начнёт молча терять хвост инструкций:
// при сохранении в окне правки или при переносе файлом с сетевой доски.
test('предел инструкций один: у сервера, у окна правки и у помощника сетевой доски', () => {
  const numberIn = (source: string, pattern: RegExp): number => Number(source.match(pattern)?.[1]?.replaceAll('_', ''))
  const editor = readFileSync(new URL('../../client/src/spaces/canvas/AssistantPresetEditor.tsx', import.meta.url), 'utf8')
  assert.equal(
    numberIn(editor, /const INSTRUCTIONS_LIMIT = ([\d_]+)/),
    assistants.MAX_INSTRUCTIONS_CHARS,
    'окно правки помощника держит другой предел, чем сервер',
  )
  assert.match(editor, /maxLength=\{INSTRUCTIONS_LIMIT\}/, 'предел не стоит на поле инструкций')

  const cloud = readFileSync(new URL('../../client/src/spaces/canvas/assistantFile.ts', import.meta.url), 'utf8')
  const cloudLimit = numberIn(cloud, /CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT = ([\d_]+)/)
  assert.ok(Number.isFinite(cloudLimit), 'не найден предел помощника сетевой доски (CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT)')
  assert.ok(
    assistants.MAX_INSTRUCTIONS_CHARS >= cloudLimit,
    'своя доска хранит меньше инструкций, чем сетевая: помощник, перенесённый файлом, потеряет хвост',
  )
})

test('выгрузка несуществующего помощника — отказ словами', async () => {
  await assert.rejects(() => assistants.exportAssistant('нет-такого'), /Assistant not found/u)
})
