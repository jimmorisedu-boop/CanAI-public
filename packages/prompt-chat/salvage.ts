/** Готовый промпт в ответе помощника: в ленте это карточка с кнопками. */
export interface PromptChatSuggestion {
  title: string
  prompt: string
}

/**
 * Промпты, написанные текстом вместо конверта.
 *
 * Правило продукта прямое: **есть промпты — должны быть кнопки** (решение
 * пользователя 18.09.2026). Модель обязана класть каждый готовый промпт в
 * `prompts`, и инструкция об этом говорит прямо. Но заставить её нечем: у
 * нашего маршрута LLM (`openrouter/router`) режима строгого JSON нет вовсе —
 * в схеме только prompt, system_prompt, model, temperature, max_tokens и
 * поиск. Значит гарантию даём мы: если в ответе лежит СПИСОК промптов, мы
 * достаём его и показываем карточками.
 *
 * ⚠️ Признак нарочно узкий, и вот почему. Когда-то пустой список промптов
 * подменялся текстом ответа целиком, и на «сколько будет два плюс два»
 * приходила карточка «Готовый промпт: два плюс два будет четыре». Чтобы это не
 * вернулось, разбор требует именно СПИСОК: не меньше двух блоков, у каждого
 * заголовок и длинное тело. Обычный ответ, пусть даже длинный, карточками не
 * становится.
 *
 * ⚠️ Текст ответа при этом НЕ трогаем: карточки добавляются рядом. Ошибись
 * разбор — человек ничего не теряет, он видит тот же ответ плюс лишнюю
 * карточку.
 */

/** Меньше двух — это не список, а обычный ответ. */
export const SALVAGE_MIN_BLOCKS = 2
/** Промпт длинный по природе: короткая строка под заголовком — не промпт. */
export const SALVAGE_MIN_BODY = 80
export const SALVAGE_MAX = 10
const MAX_TITLE = 120

interface Block {
  title: string
  body: string[]
}

/** Заголовок пункта: «**Жирный**», «### Заголовок», «1. Короткая строка». */
function titleOf(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const withoutMarker = trimmed
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^[-*•]\s+/, '')
  if (withoutMarker === trimmed && !/^\*\*/.test(trimmed)) return null
  const clean = withoutMarker.replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim()
  if (!clean || clean.length > MAX_TITLE) return null
  // Строка с точкой в конце — это предложение, а не заголовок пункта.
  if (/[.!?]$/.test(clean)) return null
  return clean
}

function cleanBody(line: string): string {
  return line
    .trim()
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/\*\*/g, '')
    .trim()
}

export function salvagePrompts(reply: string): PromptChatSuggestion[] {
  const lines = (reply ?? '').split(/\r?\n/)
  const blocks: Block[] = []
  for (const line of lines) {
    const title = titleOf(line)
    if (title) {
      blocks.push({ title, body: [] })
      continue
    }
    const body = cleanBody(line)
    if (!body || blocks.length === 0) continue
    blocks[blocks.length - 1].body.push(body)
  }

  const found = blocks
    .map((block) => ({ title: block.title, prompt: block.body.join(' ').trim() }))
    .filter((block) => block.prompt.length >= SALVAGE_MIN_BODY)

  return found.length >= SALVAGE_MIN_BLOCKS ? found.slice(0, SALVAGE_MAX) : []
}
