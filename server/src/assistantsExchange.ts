import { randomUUID } from 'node:crypto'
import { CATALOG } from './catalog.js'
import {
  MAX_DOC_NAME_CHARS,
  MAX_IMPORT_DOCS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NAME_CHARS,
  MAX_SINGLE_DOC_CHARS,
  countChars,
  cutChars,
} from './assistantLimits.js'
import { readAssistantDoc, removeAssistantDocs, writeAssistantDoc } from './assistantDocs.js'
import { FALLBACK_MODEL_ID, textModelExists, type AssistantPreset } from './assistantsFormat.js'
import { readAssistantsState, withAssistantsLock, writeAssistantsState } from './assistantsStore.js'

// Помощник файлом: выгрузка отдаёт его целиком, вместе с ТЕКСТАМИ документов
// знаний, а приём кладёт пресет и документы одной операцией.

/** Помощник целиком — для файла обмена: вместе с ТЕКСТОМ документов знаний. */
export interface AssistantExport {
  name: string
  instructions: string
  modelId: string
  docs: Array<{ name: string; text: string }>
}

export interface AssistantImportResult {
  preset: AssistantPreset
  /** Что при приёме пришлось урезать или заменить — готовыми фразами для
   *  человека. Пусто, когда помощник вошёл целиком. */
  notes: string[]
}

/** Файл помощника не принят: причина в самом файле, а не в приложении. */
export class AssistantFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssistantFileError'
  }
}

/**
 * ⚠️ Тексты документов наружу раньше не отдавала ни одна ручка — клиент знал
 * только имя и длину. Без них файл обмена терял бы самое ценное: знания.
 * Пропавший с диска документ в файл не попадает, но выгрузку не роняет.
 */
export function exportAssistant(id: string): Promise<AssistantExport> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const preset = state.presets.find((item) => item.id === id)
    if (!preset) throw new Error('Assistant not found')
    const docs: AssistantExport['docs'] = []
    for (const doc of preset.docs) {
      const text = await readAssistantDoc(doc.id)
      if (text !== null) docs.push({ name: doc.name, text })
    }
    return { name: preset.name, instructions: preset.instructions, modelId: preset.modelId, docs }
  })
}

/**
 * Встроенный файл вместо текста — настоящий data-URL: `data:`, за ним тип
 * (`image/png`), параметры через «;» и запятая — либо форма без типа, но с
 * явным `;base64,`.
 *
 * ⚠️ Одного слова «data:» в начале мало: так начинается документ в виде YAML
 * («data:\n  brand: …») и обычная фраза («Data: use the brand palette…») — их
 * принимали за встроенную картинку и не пускали помощника целиком.
 * ⚠️ До сервера файл проходит проверку приложения (`hasInlineMedia` в
 * client/src/spaces/canvas/libraryFile.ts), и здесь правило не должно быть
 * строже: иначе файл пройдёт одну дверь и упрётся во вторую, уже с другим
 * сообщением. Общего модуля у приложения и сервера нет, поэтому выражение то
 * же самое, а за расхождением следит сторож в assistantsExchange.test.ts.
 */
const INLINE_FILE = /^\s*data:(?:[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;[\w.+=-]*)*|(?:;[\w.+=-]*)*;base64),/i

export function isInlineFile(text: string): boolean {
  return INLINE_FILE.test(text)
}

const count = (value: number): string => value.toLocaleString('en-US')

/** Сколько знаков чужого номера модели показываем в замечании: в файле на его
 *  месте может лежать что угодно и любой длины. */
const MAX_MODEL_ID_SHOWN = 100

/**
 * Принять помощника из файла обмена: пресет и документы одной операцией.
 *
 * Файл пришёл извне, поэтому берём только то, что понимаем, и режем по тем же
 * пределам, что и у помощника, собранного руками. Встроенная картинка вместо
 * текста документа — отказ: знания помощника — это текст.
 *
 * ⚠️ Обо всём, что урезано или заменено, говорим в `notes`. Молча обрезанный
 * помощник выглядит «тем же самым, только поглупевшим»: человек видит
 * «загружен» и узнаёт о потере по ответам.
 */
export function importAssistant(input: AssistantExport): Promise<AssistantImportResult> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const notes: string[] = []

    // Всё проверяем и режем ДО первой записи на диск: отказ по содержимому
    // файла не должен оставлять после себя ни одного документа.
    const fullName = input.name.trim()
    const name = cutChars(fullName, MAX_NAME_CHARS)
    if (name.length < fullName.length) notes.push(`Name exceeds ${count(MAX_NAME_CHARS)} characters; using the beginning`)

    const instructions = cutChars(input.instructions, MAX_INSTRUCTIONS_CHARS)
    if (instructions.length < input.instructions.length) {
      notes.push(`Instructions exceed ${count(MAX_INSTRUCTIONS_CHARS)} characters; using the beginning`)
    }

    const modelKnown = textModelExists(input.modelId)
    if (!modelKnown) {
      const fallback = CATALOG.find((model) => model.id === FALLBACK_MODEL_ID)?.name ?? FALLBACK_MODEL_ID
      const asked = cutChars(input.modelId.trim(), MAX_MODEL_ID_SHOWN)
      notes.push(asked
        ? `Model “${asked}” is not available here; selected “${fallback}”`
        : `No model specified in the file; selected “${fallback}”`)
    }

    // Пустой документ места не занимает: двадцать берём из тех, где есть текст.
    const filled = input.docs.filter((doc) => doc.text.trim())
    if (filled.some((doc) => isInlineFile(doc.text))) {
      throw new AssistantFileError('The file contains an embedded file instead of document text; this assistant is not accepted')
    }
    if (filled.length > MAX_IMPORT_DOCS) {
      notes.push(`Documents in file ${count(filled.length)} — using ${count(MAX_IMPORT_DOCS)}`)
    }
    const taken = filled.slice(0, MAX_IMPORT_DOCS).map((doc) => {
      const docName = cutChars(doc.name.trim(), MAX_DOC_NAME_CHARS) || 'document'
      const text = cutChars(doc.text, MAX_SINGLE_DOC_CHARS)
      if (text.length < doc.text.length) {
        notes.push(`Document “${docName}” exceeds ${count(MAX_SINGLE_DOC_CHARS)} characters; using the beginning`)
      }
      return { id: randomUUID(), name: docName, text }
    })

    const preset: AssistantPreset = {
      id: randomUUID(),
      name: name || 'Assistant',
      instructions,
      modelId: modelKnown ? input.modelId : FALLBACK_MODEL_ID,
      docs: taken.map((doc) => ({ id: doc.id, name: doc.name, chars: countChars(doc.text) })),
      slot: state.presets.length,
    }
    try {
      for (const doc of taken) await writeAssistantDoc(doc.id, doc.text)
      state.presets = [...state.presets, preset]
      await writeAssistantsState(state)
    } catch (error) {
      // ⚠️ Сбой посреди приёма не оставляет файлов без хозяина: помощника в
      // библиотеке нет — значит, и его документам на диске делать нечего.
      await removeAssistantDocs(taken.map((doc) => doc.id))
      throw error
    }
    return { preset, notes }
  })
}
