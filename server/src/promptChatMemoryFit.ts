import type { PromptChatMemory } from './promptChatTypes.js'

/**
 * Подгонка памяти диалога под размеры.
 *
 * ⚠️ **Размер — повод подрезать, а не выбросить оплаченный ответ.** Пересжатие
 * истории — это отдельный платный запрос к модели: она читает переписку и
 * возвращает выжимку. Раньше ЛЮБОЙ перебор по размеру (строка длиннее 200
 * знаков, больше 80 записей, больше 12 000 знаков целиком) отменял доставку
 * целиком — выжимка пропадала, а доставка повторялась по лесенке и потом при
 * КАЖДОМ запуске приложения.
 *
 * В журнале тестировщика это видно дословно (20.09.2026): одно и то же
 * сообщение не может доставиться 62 раза за десять дней, «facts должен быть
 * строкой не длиннее 200 символов», и счётчик попыток живёт в памяти — значит
 * каждый перезапуск начинает заново. Память диалога при этом не обновляется
 * никогда, и приложение сжимает один и тот же кусок переписки снова и снова.
 *
 * Пределы существуют, чтобы выжимка не разрасталась: её же потом подмешивают в
 * каждый следующий вопрос. Подрезка достигает ровно этого и сохраняет работу.
 *
 * ⚠️ СТРУКТУРА — другое дело: не тот тип, не массив, не объект — это сломанный
 * ответ, и принимать его нельзя. Разделение жёсткое: форму проверяем строго,
 * размер подгоняем молча.
 */

export const MAX_ENTRY_CHARS = 200
export const MAX_ENTRIES = 80
export const MAX_MEMORY_CHARS = 12_000

/** Обрезка по знакам. Многоточие ставим, чтобы обрыв был виден и модели. */
export function fitEntry(text: string, max = MAX_ENTRY_CHARS): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Списки, из которых складывается счёт записей, в порядке убывания важности. */
const LIST_KEYS = [
  'facts', 'decisions', 'constraints', 'preferences', 'referenceNotes', 'openQuestions',
] as const

type ListKey = typeof LIST_KEYS[number]

function listLength(memory: PromptChatMemory, key: ListKey): number {
  return memory[key].length
}

function dropLast(memory: PromptChatMemory, key: ListKey): PromptChatMemory {
  return { ...memory, [key]: memory[key].slice(0, -1) }
}

/**
 * Подогнать память под все пределы.
 *
 * ⚠️ Лишнее снимаем С ХВОСТА самого длинного списка: модель выкладывает
 * важное первым, и обрывать начало значило бы терять именно его.
 */
export function fitMemory(input: PromptChatMemory): PromptChatMemory {
  let memory: PromptChatMemory = {
    goal: fitEntry(input.goal, 2_000),
    facts: input.facts.map((item) => fitEntry(item)).filter(Boolean),
    decisions: input.decisions
      .map((item) => ({ text: fitEntry(item.text), reason: fitEntry(item.reason) }))
      .filter((item) => item.text),
    constraints: input.constraints.map((item) => fitEntry(item)).filter(Boolean),
    preferences: input.preferences.map((item) => fitEntry(item)).filter(Boolean),
    referenceNotes: input.referenceNotes.map((item) => fitEntry(item)).filter(Boolean),
    openQuestions: input.openQuestions.map((item) => fitEntry(item)).filter(Boolean),
    chronology: fitEntry(input.chronology, MAX_MEMORY_CHARS / 2),
  }

  const total = (value: PromptChatMemory): number =>
    LIST_KEYS.reduce((sum, key) => sum + listLength(value, key), 0)

  const longest = (value: PromptChatMemory): ListKey | null => {
    let best: ListKey | null = null
    for (const key of LIST_KEYS) {
      if (listLength(value, key) === 0) continue
      if (!best || listLength(value, key) > listLength(value, best)) best = key
    }
    return best
  }

  while (total(memory) > MAX_ENTRIES) {
    const key = longest(memory)
    if (!key) break
    memory = dropLast(memory, key)
  }

  while (JSON.stringify(memory).length > MAX_MEMORY_CHARS) {
    const key = longest(memory)
    if (!key) break
    memory = dropLast(memory, key)
  }

  // ⚠️ Списки кончились, а память всё ещё велика — значит дело в длинном
  // изложении хода разговора. Режем его, а не отказываем: пустая выжимка
  // полезнее отсутствующей.
  if (JSON.stringify(memory).length > MAX_MEMORY_CHARS) {
    const overflow = JSON.stringify(memory).length - MAX_MEMORY_CHARS
    memory = { ...memory, chronology: fitEntry(memory.chronology, Math.max(0, memory.chronology.length - overflow - 8)) }
  }
  return memory
}
