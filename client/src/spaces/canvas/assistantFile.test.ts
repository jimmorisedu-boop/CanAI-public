import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types.js'
import {
  buildAssistantFile,
  CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT,
  cloudAssistantInstructions,
  readAssistantFile,
  resolveAssistantModel,
} from './assistantFile.js'
import { LibraryFileError, countChars, maxFileChars, serializeLibraryFile } from './libraryFile.js'

const textModels = [
  { id: 'gemini', name: 'Gemini 3.8 Flash', kind: 'text', params: [] },
  { id: 'claude', name: 'Claude Opus 5.5', kind: 'text', params: [] },
] as unknown as CatalogModel[]

const assistant = {
  name: 'Арт-директор', instructions: 'Проверяй композицию', modelId: 'claude',
  docs: [{ name: 'бренд.txt', text: 'Цвета бренда: вермилион.' }],
}

test('помощник уходит в файл целиком — вместе с текстами документов знаний', () => {
  const file = buildAssistantFile(assistant, textModels)
  assert.equal(file.format, 'canai-assistant')
  assert.equal(file.modelName, 'Claude Opus 5.5')
  const back = readAssistantFile(JSON.stringify(file))
  assert.deepEqual(back, file)
})

test('негодный файл помощника — отказ словами', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['не JSON', '<html>', /not a CanAI file/],
    ['файл макроса', '{"format":"canai-macro","name":"x"}', /macro file/],
    ['без названия', '{"format":"canai-assistant","version":1,"instructions":"x"}', /no helper name/],
    ['новее приложения', '{"format":"canai-assistant","version":5,"name":"x"}', /newer CanAI version/],
    ['встроенный файл', JSON.stringify({ format: 'canai-assistant', version: 1, name: 'x', docs: [{ name: 'a', text: 'data:application/pdf;base64,AAAA' }] }), /embedded pictures/],
  ]
  for (const [label, text, expected] of bad) {
    assert.throws(() => readAssistantFile(text), (error: unknown) => error instanceof LibraryFileError && expected.test(error.message), label)
  }
})

test('пустые и негодные документы в файле пропускаются, а не хоронят помощника', () => {
  const file = readAssistantFile(JSON.stringify({
    format: 'canai-assistant', version: 1, name: 'Мой', instructions: 7, modelId: null,
    docs: [null, { name: 'пусто', text: '   ' }, { text: 'годный' }, 'строка'],
  }))
  assert.equal(file.instructions, '')
  assert.deepEqual(file.docs, [{ name: 'Document', text: 'годный' }])
})

test('модель помощника у получателя: та же, одноимённая или названная замена', () => {
  assert.deepEqual(resolveAssistantModel(buildAssistantFile(assistant, textModels), textModels, null), { modelId: 'claude', note: null })
  const renamed = { ...buildAssistantFile(assistant, textModels), modelId: 'claude-sonnet' }
  assert.deepEqual(resolveAssistantModel(renamed, textModels, null), { modelId: 'claude', note: null }, 'другой id, то же имя')
  const unknown = { ...renamed, modelName: 'Модель из будущего' }
  assert.deepEqual(resolveAssistantModel(unknown, textModels, 'gemini'), {
    modelId: 'gemini', note: 'Model “Модель из будущего” is not here - “Gemini 3.8 Flash” is selected',
  })
})

// ⚠️ У помощника сетевой доски нет документов знаний, а инструкции ограничены.
// Молча обрезанный помощник выглядел бы как «тот же самый, только поглупел».
test('на сетевой доске знания дописываются в инструкции, и об этом сказано', () => {
  const merged = cloudAssistantInstructions(buildAssistantFile(assistant, textModels))
  assert.ok(merged.instructions.startsWith('Проверяй композицию'))
  assert.ok(merged.instructions.includes('# Knowledge: бренд.txt\nЦвета бренда: вермилион.'))
  assert.match(String(merged.note), /added to the instructions/)
})

test('знания, которые не помещаются, не теряются молча', () => {
  const big = buildAssistantFile({ ...assistant, docs: [{ name: 'том.txt', text: 'я'.repeat(40_000) }] }, textModels)
  const merged = cloudAssistantInstructions(big)
  assert.equal(Array.from(merged.instructions).length, CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT)
  assert.match(String(merged.note), /kept 24,000 of 40,0\d\d characters/)
})

test('помощник без документов и в пределах длины переносится без замечаний', () => {
  const plain = buildAssistantFile({ ...assistant, docs: [] }, textModels)
  assert.deepEqual(cloudAssistantInstructions(plain), { instructions: 'Проверяй композицию', note: null })
})

test('инструкции длиннее предела сетевой доски режутся по знакам, и об этом сказано', () => {
  // Граница приходится на эмодзи: резка по единицам UTF-16 оставила бы в конце его половину.
  const long = buildAssistantFile({ ...assistant, instructions: `${'я'.repeat(CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT - 1)}🙂🙂 хвост`, docs: [] }, textModels)
  const cut = cloudAssistantInstructions(long)
  assert.equal(countChars(cut.instructions), CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT)
  assert.ok(cut.instructions.endsWith('я🙂'))
  assert.match(String(cut.note), /^Instructions exceed 24,000 characters — the beginning is kept$/)
})

// ⚠️ Находка проверки 02.10.2026: помощник своей доски с дюжиной документов по
// 200 000 знаков сохранялся в файл на 2,39 млн знаков, а обратно не загружался —
// «Файл слишком большой»: предел чтения был общий с макросом, 2 млн.
test('помощник с большими документами сохраняется в файл, который читается обратно', () => {
  const docs = Array.from({ length: 12 }, (_, index) => ({ name: `том-${index + 1}.txt`, text: `строка «${index}»\n`.repeat(20_000).slice(0, 200_000) }))
  const file = buildAssistantFile({ ...assistant, docs }, textModels)
  const text = serializeLibraryFile(file)
  assert.ok(text.length > maxFileChars('macro'), `файл крупнее прежнего предела: ${text.length}`)
  assert.deepEqual(readAssistantFile(text), file)
})

// ⚠️ Разбор молча оставлял первые двадцать документов: свой сервер уже не мог
// сказать «Документов в файле 25 — взято 20», а помощник сетевой доски просто
// недосчитывался знаний. Пределы держит тот, кто принимает, — и говорит о них.
test('документы из файла доходят до принимающего все: резать и говорить об этом — его дело', () => {
  const docs = Array.from({ length: 25 }, (_, index) => ({ name: `док-${index + 1}`, text: `знание ${index + 1}` }))
  const file = readAssistantFile(JSON.stringify(buildAssistantFile({ ...assistant, docs }, textModels)))
  assert.equal(file.docs.length, 25)
  const merged = cloudAssistantInstructions(file)
  assert.ok(merged.instructions.includes('# Knowledge: док-25\nзнание 25'), 'на сетевой доске в инструкции идут все')
})

// ⚠️ Текст со слова «data:» в начале принимался за встроенную картинку: помощник
// с документом-YAML не загружался — «В файле есть встроенные картинки».
test('документ знаний в виде YAML и инструкции со слова «Data:» — обычный текст', () => {
  const yaml = { name: 'бренд.yaml', text: 'data:\n  brand: вермилион\n  tone: спокойный' }
  const file = buildAssistantFile({ ...assistant, instructions: 'Data: use the brand palette', docs: [yaml, { name: 'заметка', text: 'data: 2026-10-01, продажи выросли' }] }, textModels)
  assert.deepEqual(readAssistantFile(JSON.stringify(file)), file)
})

// ⚠️ Находка проверки 02.10.2026: помощник с документом, который целиком —
// встроенный файл, сохранялся без слов (файл на 282 знака), а обратно не
// читался: «В файле есть встроенные картинки». Что разбор не примет, то в файл
// и не идёт — отказ словами, с названием документа.
test('помощник со встроенным файлом в файл не сохраняется — отказ словами', () => {
  const refused = (patch: Record<string, unknown>, expected: RegExp, label: string) => assert.throws(
    () => buildAssistantFile({ ...assistant, ...patch }, textModels),
    (error: unknown) => error instanceof LibraryFileError && expected.test(error.message),
    label,
  )
  refused(
    { docs: [assistant.docs[0], { name: 'логотип.txt', text: 'data:image/png;base64,iVBORw0KGgo=' }] },
     /^The document "логотип\.txt" is an embedded file \(data:\.\.\.\), not text\. With it, the assistant is not saved to a file/,
    'документ',
  )
   refused({ instructions: 'data:text/plain,Ты редактор', docs: [] }, /^The assistant has a built-in file/, 'инструкции')
   refused({ name: ' data:image/png;base64,AAAA' }, /^The assistant has a built-in file/, 'имя')
  // Что сохранилось, то читается: правило одно на запись и на чтение.
  const kept = buildAssistantFile({ ...assistant, instructions: 'Используй data:image/png;base64,AAAA как пример' }, textModels)
  assert.deepEqual(readAssistantFile(serializeLibraryFile(kept)), kept)
})

test('чужой номер модели из файла в замечание целиком не попадает', () => {
  const file = readAssistantFile(JSON.stringify({ format: 'canai-assistant', version: 1, name: 'Мой', instructions: '', modelId: 'м'.repeat(5000) }))
  assert.equal(Array.from(file.modelId).length, 200)
  assert.ok(String(resolveAssistantModel(file, textModels, null).note).length < 300)
})
