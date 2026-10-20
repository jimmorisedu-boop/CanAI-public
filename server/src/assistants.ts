import { randomUUID } from 'node:crypto'
import {
  MAX_DOC_CHARS,
  MAX_DOC_NAME_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NAME_CHARS,
  MAX_SINGLE_DOC_CHARS,
  countChars,
  cutChars,
} from './assistantLimits.js'
import { readAssistantDoc, removeAssistantDocs, writeAssistantDoc } from './assistantDocs.js'
import {
  FALLBACK_MODEL_ID,
  textModelExists,
  type AssistantDoc,
  type AssistantPreset,
  type AssistantsState,
} from './assistantsFormat.js'
import { readAssistantsState, withAssistantsLock, writeAssistantsState } from './assistantsStore.js'

// Помощники: имя, системный промпт («инструкции»), модель и приложенные
// документы («знания»). Заменили собой нодовые цепочки помощника — решение
// пользователя 18.08.2026: скрипт из нод там был лишней сложностью, а нужно
// было простое «включил — работает эта модель с этими инструкциями».
//
// Включён РОВНО ОДИН помощник (или ни одного): кнопки в окне помощника —
// переключатель, а не запуск. Пока он включён, каждый вопрос уходит его
// моделью и с его инструкциями.
//
// Здесь — действия над библиотекой. Остальное разложено по соседям:
//   assistantsFormat.ts   — что лежит в assistants.json и как это разбирается;
//   assistantsStore.ts    — чтение и запись файла, запасная копия, порча;
//   assistantDocs.ts      — файлы документов знаний;
//   assistantLimits.ts    — пределы и резка текста по знакам;
//   assistantsExchange.ts — помощник файлом: выгрузка и приём.

export type { AssistantDoc, AssistantPreset, AssistantsState } from './assistantsFormat.js'
export { AssistantsStoreError } from './assistantsStore.js'
export {
  MAX_DOC_CHARS,
  MAX_IMPORT_DOCS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_SINGLE_DOC_CHARS,
} from './assistantLimits.js'
export {
  AssistantFileError,
  exportAssistant,
  importAssistant,
  type AssistantExport,
  type AssistantImportResult,
} from './assistantsExchange.js'

export function listAssistants(): Promise<AssistantsState> {
  return withAssistantsLock(readAssistantsState)
}

export function saveAssistant(input: {
  id?: string | null
  name: string
  instructions: string
  modelId: string
}): Promise<AssistantPreset> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const existing = input.id ? state.presets.find((preset) => preset.id === input.id) : undefined
    const preset: AssistantPreset = {
      id: existing?.id ?? randomUUID(),
      name: cutChars(input.name.trim(), MAX_NAME_CHARS) || 'Assistant',
      instructions: cutChars(input.instructions, MAX_INSTRUCTIONS_CHARS),
      modelId: textModelExists(input.modelId) ? input.modelId : FALLBACK_MODEL_ID,
      docs: existing?.docs ?? [],
      slot: existing?.slot ?? state.presets.length,
    }
    state.presets = existing
      ? state.presets.map((item) => (item.id === preset.id ? preset : item))
      : [...state.presets, preset]
    await writeAssistantsState(state)
    return preset
  })
}

/** Копия помощника вместе с документами.
 *
 *  Документы копируются ФАЙЛАМИ с новыми id, а не ссылками на прежние:
 *  иначе удаление оригинала унесло бы знания и у копии — она ссылалась бы
 *  на файлы, которых уже нет. */
export function duplicateAssistant(id: string): Promise<AssistantPreset> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const source = state.presets.find((preset) => preset.id === id)
    if (!source) throw new Error('Assistant not found')

    const docs: AssistantDoc[] = []
    try {
      for (const doc of source.docs) {
        // Пропавший файл не должен ронять дублирование: помощник скопируется
        // без этого документа, а не сломается целиком.
        const text = await readAssistantDoc(doc.id)
        if (text === null) continue
        const docCopy: AssistantDoc = { id: randomUUID(), name: doc.name, chars: doc.chars }
        // В список — до записи: оборвавшаяся запись тоже оставляет файл.
        docs.push(docCopy)
        await writeAssistantDoc(docCopy.id, text)
      }
      const copy: AssistantPreset = {
        id: randomUUID(),
        name: cutChars(`${source.name} (copy)`, MAX_NAME_CHARS),
        instructions: source.instructions,
        modelId: source.modelId,
        docs,
        slot: state.presets.length,
      }
      state.presets = [...state.presets, copy]
      await writeAssistantsState(state)
      return copy
    } catch (error) {
      // Копии в библиотеке нет — значит, и её документам на диске делать нечего.
      await removeAssistantDocs(docs.map((doc) => doc.id))
      throw error
    }
  })
}

export function deleteAssistant(id: string): Promise<void> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const removed = state.presets.find((preset) => preset.id === id)
    state.presets = state.presets.filter((preset) => preset.id !== id)
    if (state.activeId === id) state.activeId = null
    await writeAssistantsState(state)
    // Документы удаляем следом: без пресета они уже никому не нужны.
    await removeAssistantDocs((removed?.docs ?? []).map((doc) => doc.id))
  })
}

/** Включить помощника или выключить всех (id = null). */
export function setActiveAssistant(id: string | null): Promise<AssistantsState> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    state.activeId = id && state.presets.some((preset) => preset.id === id) ? id : null
    await writeAssistantsState(state)
    return state
  })
}

export function addAssistantDoc(presetId: string, name: string, text: string): Promise<AssistantDoc> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const preset = state.presets.find((item) => item.id === presetId)
    if (!preset) throw new Error('Assistant not found')
    const clean = cutChars(text, MAX_SINGLE_DOC_CHARS)
    const doc: AssistantDoc = {
      id: randomUUID(),
      name: cutChars(name, MAX_DOC_NAME_CHARS) || 'document',
      chars: countChars(clean),
    }
    try {
      await writeAssistantDoc(doc.id, clean)
      preset.docs = [...preset.docs, doc]
      await writeAssistantsState(state)
    } catch (error) {
      // Документ в библиотеку не записался — файл без хозяина не оставляем.
      await removeAssistantDocs([doc.id])
      throw error
    }
    return doc
  })
}

export function removeAssistantDoc(presetId: string, docId: string): Promise<void> {
  return withAssistantsLock(async () => {
    const state = await readAssistantsState()
    const preset = state.presets.find((item) => item.id === presetId)
    // ⚠️ Файл убираем, только если документ и правда числился за этим
    // помощником. Номер документа приходит из адреса запроса, и по чужому или
    // выдуманному номеру («../…») стирался бы файл, который помощнику не
    // принадлежит.
    if (!preset || !preset.docs.some((doc) => doc.id === docId)) return
    preset.docs = preset.docs.filter((doc) => doc.id !== docId)
    await writeAssistantsState(state)
    await removeAssistantDocs([docId])
  })
}

/**
 * Resolve one assistant snapshot, including its document text.
 *
 * The action-preparation stage needs an explicit profile rather than the
 * mutable global active profile.  Keeping the resolver here means documents
 * are read under the same store/limits rules as the assistant chat and the
 * resulting snapshot can be frozen into a durable job before any LLM call.
 * `undefined` keeps the assistant-chat behaviour (active profile), whereas
 * `null` explicitly selects Universal and therefore returns null.
 */
export async function assistantContext(
  assistantId?: string | null,
): Promise<{ id: string; modelId: string; systemPrompt: string } | null> {
  let state: AssistantsState
  try {
    state = await listAssistants()
  } catch {
    // ⚠️ Нечитаемая библиотека не должна ронять диалог: эту функцию зовёт
    // каждая ручка диалога с помощником, и исключение здесь закрыло бы их все.
    // Вопрос уходит как без помощника; причина уже записана в журнал, а окно
    // помощников показывает её словами.
    return null
  }
  // `undefined` preserves the assistant-chat legacy behaviour (use the
  // active profile), while `null` is an explicit Universal selection from
  // the canvas action picker and must not silently re-enable the active one.
  const requestedId = assistantId === undefined
    ? state.activeId
    : typeof assistantId === 'string' && assistantId.trim()
      ? assistantId.trim()
      : null
  if (!requestedId) return null
  const preset = state.presets.find((item) => item.id === requestedId)
  if (!preset) return null

  const parts: string[] = []
  if (preset.instructions.trim()) parts.push(preset.instructions.trim())

  let budget = MAX_DOC_CHARS
  for (const doc of preset.docs) {
    if (budget <= 0) break
    // Файл знаний пропал — молчать нельзя, но и падать незачем: помощник
    // продолжит работать по инструкциям.
    const text = await readAssistantDoc(doc.id)
    if (text === null) continue
    const slice = cutChars(text, budget)
    budget -= countChars(slice)
    parts.push(`Document “${doc.name}”:\n${slice}`)
  }

  return { id: preset.id, modelId: preset.modelId, systemPrompt: parts.join('\n\n') }
}

export async function activeAssistantContext(): Promise<{ modelId: string; systemPrompt: string } | null> {
  const context = await assistantContext()
  return context ? { modelId: context.modelId, systemPrompt: context.systemPrompt } : null
}
