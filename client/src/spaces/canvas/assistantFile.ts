import type { CatalogModel } from '../../types'
import {
  ASSISTANT_FILE_FORMAT, LIBRARY_FILE_VERSION, LibraryFileError, MACRO_FILE_FORMAT,
  cleanName, countChars, cutChars, hasInlineMedia, isPlain, parseJson, type Plain,
} from './libraryFile'

// Файл помощника: имя, инструкции, модель и тексты документов знаний.
// Общие правила обмена — в libraryFile.ts.

export interface AssistantFile {
  format: typeof ASSISTANT_FILE_FORMAT
  version: number
  name: string
  instructions: string
  modelId: string
  modelName?: string
  docs: Array<{ name: string; text: string }>
}

const count = (value: number): string => value.toLocaleString('en-US')

/**
 * Файл помощника из того, что лежит в библиотеке.
 *
 * ⚠️ Что разбор не примет, то в файл и не идёт. Раньше помощник с документом,
 * который целиком — встроенный файл (`data:image/png;base64,…`), сохранялся без
 * слов, а обратно не читался: «В файле есть встроенные картинки». «Сохранить в
 * файл» не имеет права молча создать файл, который потом не загрузить, — оба
 * окна показывают этот отказ строкой.
 */
export function buildAssistantFile(
  assistant: { name: string; instructions: string; modelId: string; docs?: Array<{ name: string; text: string }> },
  models: readonly CatalogModel[],
): AssistantFile {
  const modelName = models.find((model) => model.id === assistant.modelId)?.name
  const file: AssistantFile = {
    format: ASSISTANT_FILE_FORMAT,
    version: LIBRARY_FILE_VERSION,
    name: cleanName(assistant.name, 80) || "Assistant",
    instructions: assistant.instructions,
    modelId: assistant.modelId,
    ...(modelName ? { modelName } : {}),
    docs: (assistant.docs ?? []).map((doc) => ({ name: cleanName(doc.name, 120) || "Document", text: doc.text })),
  }
  // Та же проверка, что при чтении (readAssistantFile), — по всему файлу.
  if (hasInlineMedia(file)) {
    const inlineDoc = file.docs.find((doc) => hasInlineMedia(doc))
    throw new LibraryFileError(inlineDoc
      ? `The document "${inlineDoc.name}" is an embedded file (data:...), not text. With it, the assistant is not saved to a file: remove the document and save again`
      : "The assistant has a built-in file (data:...) - we do not save such an assistant to a file")
  }
  return file
}

/**
 * Разбор файла помощника.
 *
 * ⚠️ Документы берём ВСЕ, что есть в файле, и ничего не режем сами. Раньше
 * разбор молча оставлял первые двадцать, и до получателя не доходило даже то,
 * что их было больше: свой сервер уже не мог сказать «Документов в файле 25 —
 * взято 20», а помощник сетевой доски просто недосчитывался знаний. Пределы
 * держит тот, кто принимает, — и он же говорит о них словами: свой сервер
 * (importAssistant) и `cloudAssistantInstructions` ниже.
 */
export function readAssistantFile(text: string): AssistantFile {
  const parsed = parseJson(text, 'assistant')
  if (parsed.format === MACRO_FILE_FORMAT || parsed.type === MACRO_FILE_FORMAT) {
    throw new LibraryFileError("This is a macro file - load it in the macro window")
  }
  if (parsed.format !== ASSISTANT_FILE_FORMAT) throw new LibraryFileError("This is not a CanAI assistant file")
  if (Number(parsed.version) > LIBRARY_FILE_VERSION) {
    throw new LibraryFileError("File was saved by a newer CanAI version — update the app")
  }
  if (hasInlineMedia(parsed)) throw new LibraryFileError("The file contains embedded pictures - we do not accept such an assistant")
  const name = cleanName(parsed.name, 80)
  if (!name) throw new LibraryFileError("There is no helper name in the file")
  const docs = (Array.isArray(parsed.docs) ? parsed.docs : [])
    .filter((doc): doc is Plain => isPlain(doc) && typeof doc.text === 'string' && doc.text.trim().length > 0)
    .map((doc) => ({ name: cleanName(doc.name, 120) || "Document", text: String(doc.text) }))
  const modelName = cleanName(parsed.modelName, 160)
  return {
    format: ASSISTANT_FILE_FORMAT,
    version: LIBRARY_FILE_VERSION,
    name,
    instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
    modelId: cleanName(parsed.modelId, 200),
    ...(modelName ? { modelName } : {}),
    docs,
  }
}

/** Модель помощника у получателя: та же, одноимённая или модель по умолчанию. */
export function resolveAssistantModel(
  file: AssistantFile,
  textModels: readonly CatalogModel[],
  fallbackId: string | null,
): { modelId: string; note: string | null } {
  const byId = textModels.find((model) => model.id === file.modelId)
  if (byId) return { modelId: byId.id, note: null }
  const byName = file.modelName ? textModels.find((model) => model.name === file.modelName) : undefined
  const model = byName ?? textModels.find((item) => item.id === fallbackId) ?? textModels[0]
  if (!model) return { modelId: file.modelId || 'gemini', note: null }
  return {
    modelId: model.id,
    note: model === byName ? null : `Model “${file.modelName ?? file.modelId}” is not here - “${model.name}” is selected`,
  }
}

/** Сколько знаков инструкций хранит помощник сетевой доски (предел сервера команды). */
export const CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT = 24_000

/**
 * Помощник сетевой доски — это имя, инструкции и модель: отдельных документов
 * знаний у него нет. Знания из файла дописываем в инструкции, а если целиком
 * они не помещаются — говорим, сколько вошло. Молча обрезанный помощник
 * выглядел бы как «тот же самый, только поглупел».
 */
export function cloudAssistantInstructions(file: AssistantFile): { instructions: string; note: string | null } {
  const limit = CLOUD_ASSISTANT_INSTRUCTIONS_LIMIT
  const base = file.instructions.trim()
  if (file.docs.length === 0) {
    const cut = cutChars(base, limit)
    return {
      instructions: cut,
      note: cut.length < base.length ? `Instructions exceed ${count(limit)} characters — the beginning is kept` : null,
    }
  }
  const knowledge = file.docs.map((doc) => `# Knowledge: ${doc.name}
${doc.text.trim()}`).join('\n\n')
  const full = [base, knowledge].filter(Boolean).join('\n\n')
  // Знаки считаем обходом, без массива: текста знаний бывают миллионы знаков.
  const total = countChars(full)
  if (total <= limit) {
    return { instructions: full, note: "Knowledge documents are added to the instructions: the network board assistant does not have separate documents" }
  }
  return {
    instructions: cutChars(full, limit),
    note: `Knowledge was truncated: kept ${count(limit)} of ${count(total)} characters`,
  }
}
