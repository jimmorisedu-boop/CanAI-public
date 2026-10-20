/**
 * Макросы и помощники файлом: сохранить себе, переслать коллеге, загрузить.
 *
 * ⚠️ Просьба владельца 01.10.2026: «пусть каждый сам себе настраивает, но
 * предусмотри возможность их сохранять и обмениваться друг между другом».
 * Обмен сделан файлом, а не полкой на сервере: файл пересылают чем угодно, он
 * работает и на своей доске, и на сетевой, и между командами.
 *
 * ⚠️ Файл приходит ИЗВНЕ, и верить ему нельзя ни в чём:
 *   • в нём бывает что угодно вместо графа — берём только знакомые поля нод и
 *     связей (белый список), остальное отбрасываем;
 *   • встроенная картинка (настоящий data-URL) — отказ целиком: медиа в
 *     библиотеках живёт только ссылками;
 *   • ссылка на файл в ноде «Файл» — это файл ЧУЖОГО компьютера или чужой
 *     доски: её убираем и говорим словами, что файл надо выбрать заново;
 *   • модели у получателя может не быть, а у своей доски и сервера команды
 *     каталоги разные (`chatgpt-image-2` против `gpt-image-2`, `aspect_ratio`
 *     против `aspect`). Молча принять такой макрос — получить кнопку, которая
 *     выглядит рабочей и падает на запуске. Модель подбираем по имени, иначе
 *     берём модель по умолчанию, и обо всём, что заменили, сообщаем списком.
 */
export const MACRO_FILE_FORMAT = 'canai-macro'
export const ASSISTANT_FILE_FORMAT = 'canai-assistant'
export const LIBRARY_FILE_VERSION = 1

/** Чей каталог моделей у графа: своей доски или сервера команды. */
export type LibraryCatalog = 'local' | 'team'
export type LibraryFileKind = 'macro' | 'assistant'

export type Plain = Record<string, unknown>
export class LibraryFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LibraryFileError'
  }
}

/**
 * Сколько знаков читаем из файла.
 *
 * ⚠️ Файл помощника несёт ТЕКСТЫ документов знаний, а приём рассчитан на 20
 * документов по 200 000 знаков (MAX_IMPORT_DOCS и MAX_SINGLE_DOC_CHARS своего
 * сервера). При общем пределе в 2 млн помощник с дюжиной больших документов
 * сохранялся в файл, который потом не читался: «Файл слишком большой». Запас в
 * два с половиной раза — на запись в JSON: перевод строки и кавычка занимают
 * там по два знака. Тот же предел держит и запись (`serializeLibraryFile`):
 * что сохранилось, то прочтётся.
 */
const MAX_FILE_CHARS: Record<LibraryFileKind, number> = { macro: 2_000_000, assistant: 10_000_000 }

export function maxFileChars(kind: LibraryFileKind): number {
  return MAX_FILE_CHARS[kind]
}

const TOO_LARGE: Record<LibraryFileKind, string> = {
  macro: "File is too large — a CanAI macro file cannot be this large",
  assistant: "File is too large — a CanAI assistant file cannot be this large",
}

export function isPlain(value: unknown): value is Plain {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Значение по ключу — только если ключ свой.
 *
 * ⚠️ У обычного объекта `table['constructor']` — это функция, а `toString` —
 * метод: параметр или модель с таким именем из чужого файла доставали их из
 * таблиц соответствий, и загрузка падала с «… is not iterable» по-английски.
 */
export function own<T>(table: Record<string, T> | null | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined
}

/** Сколько единиц UTF-16 занимает знак, стоящий на этом месте строки. */
function charWidth(text: string, index: number): number {
  return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
}

/**
 * Сколько в строке знаков. Знак — кодовая точка, а не единица UTF-16: так же
 * считают оба сервера, и «N знаков» обязано значить одно и то же везде.
 *
 * ⚠️ Считаем обходом, а не `Array.from(text).length`: файл помощника несёт до
 * десяти миллионов знаков, и массив из них — это сотни мегабайт на ровном месте.
 */
export function countChars(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += charWidth(text, index)) count += 1
  return count
}

/** Первые `max` знаков строки — по знакам, чтобы не оставить в конце половину эмодзи. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text
  let index = 0
  for (let count = 0; count < max && index < text.length; count += 1) index += charWidth(text, index)
  return text.slice(0, index)
}

export function cleanName(value: unknown, max: number): string {
  return typeof value === 'string' ? cutChars(value.trim(), max) : ''
}

// `data:<тип>/<подтип>`, параметры через «;» и запятая — либо форма без типа,
// но с явным `;base64,`.
const INLINE_DATA = /^\s*data:(?:[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;[\w.+=-]*)*|(?:;[\w.+=-]*)*;base64),/i

/**
 * Настоящий data-URL, а не любое «data:» в начале текста.
 *
 * ⚠️ Прежняя проверка принимала за встроенную картинку документ знаний в виде
 * YAML («data:\n  brand: …»), инструкцию «Data: use the brand palette» и
 * заметку «data: 2026-10-01, продажи выросли»: помощник не загружался, а
 * макрос с такой заметкой не сохранялся в файл — с сообщением про картинки.
 */
export function isInlineData(value: string): boolean {
  return INLINE_DATA.test(value)
}

/**
 * Есть ли где-нибудь внутри встроенный файл. Обход без рекурсии и без предела
 * глубины: с пределом в двенадцать уровней data-URL на тринадцатом проходил.
 * Каждый объект смотрим один раз — граф из памяти (не из файла) может
 * ссылаться сам на себя, и без этого обход не кончился бы.
 */
export function hasInlineMedia(value: unknown): boolean {
  const queue: unknown[] = [value]
  const seen = new WeakSet<object>()
  while (queue.length > 0) {
    const item = queue.pop()
    if (typeof item === 'string') {
      if (isInlineData(item)) return true
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      for (const nested of Object.values(item)) queue.push(nested)
    }
  }
  return false
}

/** Имя файла: по названию, без знаков, которые не примет файловая система. */
export function libraryFileName(name: string, kind: LibraryFileKind): string {
  const base = cutChars(name.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim(), 60).trimEnd()
  return `${base || (kind === 'macro' ? "macro" : "assistant")}.${kind === 'macro' ? MACRO_FILE_FORMAT : ASSISTANT_FILE_FORMAT}.json`
}

export function parseJson(text: string, kind: LibraryFileKind = 'macro'): Plain {
  if (text.length > maxFileChars(kind)) throw new LibraryFileError(TOO_LARGE[kind])
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LibraryFileError("This is not a CanAI file: it could not be read")
  }
  if (!isPlain(parsed)) throw new LibraryFileError("This is not a CanAI file")
  return parsed
}

/**
 * Лежит ли в тексте макрос CanAI — нового вида (`format`) или прежнего (`type`).
 *
 * По ней Ctrl+V решает, чей это текст: ряд макросов вставляет макрос, а холст
 * такой текст на доску не кладёт. Постороннее содержимое буфера ничего не
 * запускает и ни о чём не сообщает. Исключений не бросает.
 */
export function isMacroText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > maxFileChars('macro')) return false
  // Дешёвый отсев до разбора: в чужом тексте этой пометки нет.
  if (!text.includes(`"${MACRO_FILE_FORMAT}"`)) return false
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlain(parsed) && (parsed.format === MACRO_FILE_FORMAT || parsed.type === MACRO_FILE_FORMAT)
  } catch {
    return false
  }
}

/**
 * Текст выбранного файла.
 *
 * ⚠️ Размер сверяем ДО чтения: раньше файл целиком ложился в память вкладки и
 * только потом оказывался «слишком большим». Предел задан в единицах строки, а
 * каждая из них занимает в файле (UTF-8) не больше трёх байт: файл крупнее
 * утроенного предела не пройдёт наверняка, и читать его незачем.
 */
export async function readLibraryFile(
  file: { size: number; text(): Promise<string> },
  kind: LibraryFileKind,
): Promise<string> {
  if (file.size > maxFileChars(kind) * 3) throw new LibraryFileError(TOO_LARGE[kind])
  const text = await file.text()
  if (text.length > maxFileChars(kind)) throw new LibraryFileError(TOO_LARGE[kind])
  return text
}

/**
 * Текст файла обмена для записи на диск.
 *
 * ⚠️ «Сохранить в файл» не имеет права молча создать файл, который потом не
 * прочтётся: предел тот же, что при чтении. Не помещается — отказ словами.
 */
export function serializeLibraryFile(file: unknown): string {
  const kind: LibraryFileKind = isPlain(file) && file.format === ASSISTANT_FILE_FORMAT ? 'assistant' : 'macro'
  const text = JSON.stringify(file, null, 2)
  if (text.length > maxFileChars(kind)) {
    throw new LibraryFileError(kind === 'assistant'
      ? "The helper does not fit into the file: there is too much text in the knowledge documents. Remove some documents and save again"
      : "The macro does not fit into the file: there is too much text")
  }
  return text
}
