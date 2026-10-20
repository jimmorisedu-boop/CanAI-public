// Предупреждение о моделях, которые понимают промпт только по-английски.
//
// Lyria на русский текст отвечает «Unsupported language detected. Please use
// English» — но уже ПОСЛЕ запуска: человек ждёт, а получает отказ (найдено
// прогоном 20.08.2026). Интерфейс у нас русский, промпты пишут по-русски, и
// молчать об этом нельзя.
//
// Правило намеренно простое: смотрим на кириллицу в промпте. Не пытаемся
// определять язык всерьёз — задача не в этом, а в том, чтобы человек не узнал
// про ограничение ценой потраченного времени.

const CYRILLIC = /[а-яё]/i

export function looksNonEnglish(prompt: string): boolean {
  return CYRILLIC.test(prompt)
}

export function englishPromptWarning(
  model: { englishPromptOnly?: boolean; name?: string } | null | undefined,
  prompt: string,
): string | null {
  if (!model?.englishPromptOnly) return null
  if (!prompt.trim() || !looksNonEnglish(prompt)) return null
  return `“${model.name ?? 'This model'}” understands prompts only in English — Russian prompts will fail`
}
