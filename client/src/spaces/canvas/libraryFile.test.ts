import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  LibraryFileError, cleanName, countChars, cutChars, hasInlineMedia, isInlineData, maxFileChars, own, parseJson,
  readLibraryFile, serializeLibraryFile,
} from './libraryFile.js'
import { pickLibraryFile, saveLibraryFile } from './libraryFileIO.js'

// Общие правила обмена файлом — для макросов и помощников разом.

const refused = (expected: RegExp) => (error: unknown): boolean => (
  error instanceof LibraryFileError && expected.test(error.message)
)

// ⚠️ Прежняя проверка считала встроенной картинкой любой текст со слова «data:»
// в начале: помощник с документом-YAML не загружался, а макрос с такой заметкой
// не сохранялся в файл — оба с сообщением про картинки.
test('встроенный файл — только настоящий data-URL, а не слово «data:» в начале текста', () => {
  const plain = [
    'data:\n  brand: вермилион\n  tone: спокойный',
    'Data: use the brand palette in every answer',
    'data: 2026-10-01, продажи выросли',
    'Используй data: из таблицы',
    'data:', 'database: postgres', '',
  ]
  for (const text of plain) assert.equal(isInlineData(text), false, JSON.stringify(text))
  const inline = [
    'data:image/png;base64,AAAA', '  data:image/png;base64,AAAA', 'DATA:IMAGE/JPEG;BASE64,/9j/',
    'data:image/svg+xml;charset=utf-8,<svg/>', 'data:application/pdf;base64,JVBERi0=', 'data:;base64,AAAA',
    'data:video/mp4;base64,AAAA', 'data:text/plain,привет',
  ]
  for (const text of inline) assert.equal(isInlineData(text), true, JSON.stringify(text))
})

// (Что свой сервер в этом признаке не строже приложения, сверяет сторож на его
// стороне — server/src/assistantsExchange.test.ts.)

// ⚠️ Прежний обход останавливался на двенадцатом уровне: встроенная картинка на
// тринадцатом доезжала до библиотеки.
test('встроенный файл находится на любой глубине, а обход не падает на глубоком мусоре', () => {
  const nest = (depth: number, core: unknown): unknown => {
    let value = core
    for (let level = 0; level < depth; level++) value = level % 2 ? [value] : { a: value }
    return value
  }
  for (const depth of [0, 1, 12, 13, 14, 200, 20_000]) {
    assert.equal(hasInlineMedia(nest(depth, 'data:image/png;base64,AAAA')), true, `глубина ${depth}`)
    assert.equal(hasInlineMedia(nest(depth, 'data: просто текст')), false, `глубина ${depth}`)
  }
  assert.equal(hasInlineMedia({ a: [1, true, null, { b: 'x' }], c: undefined }), false)
  assert.equal(hasInlineMedia(null), false)
  // Граф из памяти может ссылаться сам на себя — обход обязан кончиться.
  const loop: Record<string, unknown> = { a: 1 }
  loop.self = loop
  loop.list = [loop, { back: loop }]
  assert.equal(hasInlineMedia(loop), false)
  loop.deep = { url: 'data:image/png;base64,AAAA' }
  assert.equal(hasInlineMedia(loop), true)
})

// ⚠️ Файл помощника несёт тексты документов знаний: приём рассчитан на 20
// документов по 200 000 знаков, а общий предел был 2 млн — помощник с дюжиной
// больших документов сохранялся в файл, который потом не читался.
test('предел файла помощника вмещает всё, что помощник может нести; у макроса он прежний', () => {
  assert.equal(maxFileChars('macro'), 2_000_000)
  // Сколько знаний принимает из файла свой сервер — столько файл и обязан вместить.
  const serverLimit = (name: string): number => {
    const source = readFileSync(new URL('../../../../server/src/assistantLimits.ts', import.meta.url), 'utf8')
    const found = new RegExp(`export const ${name} = ([\\d_]+)`, 'u').exec(source)
    assert.ok(found, `${name} не найден в server/src/assistantLimits.ts`)
    return Number(found[1]!.replaceAll('_', ''))
  }
  const knowledge = serverLimit('MAX_IMPORT_DOCS') * serverLimit('MAX_SINGLE_DOC_CHARS')
  assert.equal(knowledge, 20 * 200_000)
  assert.ok(maxFileChars('assistant') >= knowledge * 2, 'все документы на пределе — с запасом на запись в JSON')
  const big = `{"pad":"${'я'.repeat(2_000_001)}"}`
  assert.throws(() => parseJson(big, 'macro'), refused(/File is too large — a CanAI macro file/))
  assert.throws(() => parseJson(big), refused(/CanAI macro file/), 'без указания вида предел — макроса')
  assert.deepEqual(Object.keys(parseJson(big, 'assistant')), ['pad'])
  assert.throws(() => parseJson('[1,2]'), refused(/This is not a CanAI file/))
  assert.throws(() => parseJson('<html>'), refused(/could not be read/))
})

// ⚠️ Раньше файл целиком ложился в память вкладки и только потом оказывался
// «слишком большим».
test('размер файла сверяется до чтения', async () => {
  let reads = 0
  const file = (size: number, text: string) => ({ size, text: async () => { reads++; return text } })
  await assert.rejects(() => readLibraryFile(file(maxFileChars('macro') * 3 + 1, '{}'), 'macro'), refused(/File is too large — a CanAI macro file/))
  await assert.rejects(() => readLibraryFile(file(maxFileChars('assistant') * 3 + 1, '{}'), 'assistant'), refused(/File is too large — a CanAI assistant file/))
  assert.equal(reads, 0, 'заведомо большой файл не читается вовсе')
  // Тот же размер годится помощнику: его файл законно крупнее.
  assert.equal(await readLibraryFile(file(maxFileChars('macro') * 3 + 1, '{"a":1}'), 'assistant'), '{"a":1}')
  // Кириллица в UTF-8 — два байта на знак: по размеру файл проходит, по знакам — нет.
  const long = 'я'.repeat(maxFileChars('macro') + 1)
  await assert.rejects(() => readLibraryFile(file(long.length * 2, long), 'macro'), refused(/File is too large/))
  assert.equal(reads, 2)
})

test('«Сохранить в файл» не создаёт файл, который потом не прочтётся', () => {
  const assistant = (chars: number) => ({ format: 'canai-assistant', version: 1, name: 'x', docs: [{ name: 'd', text: 'я'.repeat(chars) }] })
  const text = serializeLibraryFile(assistant(3_000_000))
  assert.ok(text.length > maxFileChars('macro'), 'файл помощника крупнее предела макроса — и это законно')
  assert.equal((parseJson(text, 'assistant').docs as unknown[]).length, 1, 'что сохранилось, то читается')
  assert.throws(() => serializeLibraryFile(assistant(maxFileChars('assistant'))), refused(/helper does not fit into the file/))
  const macro = { format: 'canai-macro', version: 1, name: 'x', graph: { nodes: [{ id: 'n', data: { kind: 'note', prompt: 'я'.repeat(2_000_000) } }], edges: [] } }
  assert.throws(() => serializeLibraryFile(macro), refused(/macro does not fit into the file/))
})

// ⚠️ У обычного объекта `table['constructor']` — функция: имя из чужого файла
// доставало её из таблиц, и загрузка падала отказом по-английски.
test('значение по ключу берётся только у своих ключей', () => {
  const table: Record<string, string> = { a: 'A' }
  assert.equal(own(table, 'a'), 'A')
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'b']) {
    assert.equal(own(table, key), undefined, key)
  }
  assert.equal(own(undefined, 'a'), undefined)
  assert.equal(own(null, 'a'), undefined)
})

test('знаки считаются и режутся по знакам, а не по половинкам эмодзи', () => {
  assert.equal(countChars('я🙂z'), 3)
  assert.equal(cutChars('я🙂z', 2), 'я🙂')
  assert.equal(cutChars('🙂🙂🙂', 1), '🙂')
  assert.equal(cutChars('короткая', 100), 'короткая')
  assert.equal(countChars(''), 0)
  // Имя из файла режется так же: предел «100 знаков» — это сто эмодзи, а не пятьдесят.
  assert.equal(cleanName(`  ${'🙂'.repeat(120)}  `, 100), '🙂'.repeat(100))
  assert.equal(cleanName('  Портрет  ', 100), 'Портрет')
  assert.equal(cleanName(7, 100), '')
})

// ── Диск ─────────────────────────────────────────────────────────────────────
// libraryFileIO.ts — это DOM: ссылка для скачивания и поле выбора файла. Здесь
// им подставлена страница ровно из того, чего он касается: проверяем, что и
// запись, и чтение идут ЧЕРЕЗ проверки размера, а не мимо них.

interface FakeInput {
  type: string
  accept: string
  style: Record<string, string>
  files: unknown[] | null
  removed: boolean
  fire(event: 'change' | 'cancel'): void
}

function fakePage() {
  const downloads: Array<{ name: string; text: Promise<string> }> = []
  const inputs: FakeInput[] = []
  const page = {
    body: { appendChild() {} },
    createElement(tag: string) {
      if (tag === 'a') {
        return {
          href: '', download: '',
          // Адрес живёт до конца скачивания — содержимое берём, пока он цел.
          click() { downloads.push({ name: this.download, text: resolveObjectURL(this.href)!.text() }) },
          remove() {},
        }
      }
      const listeners: Record<string, () => void> = {}
      const input: FakeInput & { addEventListener(type: string, fn: () => void): void; click(): void; remove(): void } = {
        type: '', accept: '', style: {}, files: null, removed: false,
        addEventListener(type, fn) { listeners[type] = fn },
        click() {},
        remove() { this.removed = true },
        fire(event) { listeners[event]!() },
      }
      inputs.push(input)
      return input
    },
  }
  const globals = globalThis as { document?: unknown }
  const before = globals.document
  globals.document = page
  return { downloads, inputs, restore() { globals.document = before } }
}

test('«Сохранить в файл» пишет на диск ровно то, что потом прочтётся, и ничего — при отказе', async () => {
  const page = fakePage()
  try {
    const file = { format: 'canai-assistant', version: 1, name: 'x', instructions: 'строка\n«кавычки»', docs: [] }
    saveLibraryFile('помощник.canai-assistant.json', file)
    assert.equal(page.downloads.length, 1)
    assert.equal(page.downloads[0]!.name, 'помощник.canai-assistant.json')
    const text = await page.downloads[0]!.text
    assert.equal(text, serializeLibraryFile(file))
    assert.deepEqual(parseJson(text, 'assistant'), file)
    // Не помещается в предел чтения — отказ словами, и файла на диске нет.
    const huge = { format: 'canai-assistant', version: 1, name: 'x', docs: [{ name: 'd', text: 'я'.repeat(maxFileChars('assistant')) }] }
    assert.throws(() => saveLibraryFile('x.json', huge), refused(/helper does not fit into the file/))
    assert.equal(page.downloads.length, 1)
  } finally {
    page.restore()
  }
})

test('«Из файла» сверяет размер до чтения, а предел берёт по виду файла', async () => {
  const page = fakePage()
  try {
    let reads = 0
    const file = (size: number, text: string) => ({ size, text: async () => { reads++; return text } })
    const pick = async (kind: 'macro' | 'assistant' | undefined, chosen: unknown) => {
      const picked = kind ? pickLibraryFile(kind) : pickLibraryFile()
      const input = page.inputs.at(-1)!
      assert.equal(input.type, 'file')
      if (chosen === null) input.fire('cancel')
      else { input.files = [chosen]; input.fire('change') }
      try {
        return await picked
      } finally {
        assert.equal(input.removed, true, 'поле выбора со страницы убрано')
      }
    }
    assert.equal(await pick('macro', file(7, '{"a":1}')), '{"a":1}')
    assert.equal(await pick('macro', null), null, 'окно выбора закрыли — это не ошибка')
    const big = maxFileChars('macro') * 3 + 1
    await assert.rejects(() => pick('macro', file(big, '{}')), refused(/File is too large — a CanAI macro file/))
    assert.equal(reads, 1, 'заведомо большой файл не читается вовсе')
    // Файл помощника законно крупнее: тот же размер ему годится — и с пределом по умолчанию.
    assert.equal(await pick('assistant', file(big, '{"a":2}')), '{"a":2}')
    assert.equal(await pick(undefined, file(big, '{"a":3}')), '{"a":3}')
    await assert.rejects(() => pick(undefined, file(maxFileChars('assistant') * 3 + 1, '{}')), refused(/File is too large — a CanAI assistant file/))
    assert.equal(reads, 3)
  } finally {
    page.restore()
  }
})
