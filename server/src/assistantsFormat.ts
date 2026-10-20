import { CATALOG } from './catalog.js'
import { MAX_INSTRUCTIONS_CHARS, MAX_NAME_CHARS, cutChars } from './assistantLimits.js'

// Что лежит в data/assistants.json: вид библиотеки помощников, разбор текста
// файла и общая для соседей ошибка хранения. Диска здесь нет — чтение, запись
// и запасная копия в assistantsStore.ts.

export interface AssistantDoc {
  id: string
  name: string
  /** Длина текста в знаках — её показываем в списке: по ней видно, что файл прочитан. */
  chars: number
}

export interface AssistantPreset {
  id: string
  name: string
  instructions: string
  modelId: string
  docs: AssistantDoc[]
  /** Место в ряду кнопок, как у макросов холста. */
  slot: number
}

export interface AssistantsState {
  presets: AssistantPreset[]
  /** Кто включён. null — помощник отвечает как обычно, без пресета. */
  activeId: string | null
}

/**
 * Библиотеку или документ помощника не удалось прочитать или записать.
 * Текст — для человека.
 *
 * ⚠️ Класс лежит здесь, а не в хранилище: его бросают и хранилище
 * (assistantsStore.ts), и файлы документов (assistantDocs.ts), а хранилище при
 * восстановлении из запасной копии само спрашивает у документов, на месте ли
 * их файлы. Будь класс в хранилище, два модуля ссылались бы друг на друга по
 * кругу.
 */
export class AssistantsStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssistantsStoreError'
  }
}

/** Модель помощника, у которого своей нет: ею же заменяется незнакомая. */
export const FALLBACK_MODEL_ID = 'gemini'

export function textModelExists(id: string): boolean {
  return CATALOG.some((model) => model.id === id && model.kind === 'text')
}

// ⚠️ Запись без id — признак испорченного файла, а не «лишняя строка»: молча
// выбросить её значило бы потерять помощника (или документ — вместе с его
// текстом на диске) при следующей же записи. Всё, что приложение пишет само,
// id несёт всегда. Остальные поля берут умолчания: без них помощник цел.
function parseDoc(raw: unknown): AssistantDoc {
  if (!raw || typeof raw !== 'object') throw new Error('document entry is not an object')
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id) throw new Error('document has no id')
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : 'document',
    chars: Number(value.chars) || 0,
  }
}

function parsePreset(raw: unknown, index: number): AssistantPreset {
  if (!raw || typeof raw !== 'object') throw new Error('assistant entry is not an object')
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id) throw new Error('assistant has no id')
  return {
    id: value.id,
    name: typeof value.name === 'string' ? cutChars(value.name, MAX_NAME_CHARS) : 'Assistant',
    instructions: typeof value.instructions === 'string' ? cutChars(value.instructions, MAX_INSTRUCTIONS_CHARS) : '',
    modelId: typeof value.modelId === 'string' && textModelExists(value.modelId) ? value.modelId : FALLBACK_MODEL_ID,
    docs: Array.isArray(value.docs) ? value.docs.map(parseDoc) : [],
    slot: Number.isInteger(value.slot) ? Number(value.slot) : index,
  }
}

// Метка порядка байтов: её дописывает в начало файла Блокнот Windows при
// ручной правке. Собрана кодом, а не написана в тексте — сам знак невидим, и
// редактор его легко теряет.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

/**
 * Разобрать текст файла библиотеки. Бросает, если это не она: что делать с
 * таким файлом, решает вызывающий — здесь его нельзя ни «починить», ни счесть
 * пустым.
 */
export function parseAssistantsState(text: string): AssistantsState {
  // Файл от метки не испортился — разбору она просто мешает.
  const parsed: unknown = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('assistant file is not an object')
  const raw = parsed as Record<string, unknown>
  if (!Array.isArray(raw.presets)) throw new Error('assistant file has no list')
  const presets = raw.presets.map(parsePreset)
  const activeId = typeof raw.activeId === 'string' && presets.some((preset) => preset.id === raw.activeId)
    ? raw.activeId
    : null
  return { presets, activeId }
}
