/**
 * Строки окна «Run for $…?» у обычного запуска — только то, что человек
 * читает: модель, промпт, сколько задач и итог.
 *
 * ⚠️ Раньше сюда приклеивались строки агентского согласия
 * (`generationConsentRows`): «Catalog: revision model:veo-omni:Flash»,
 * «References in order» с id ассетов и служебными адресами файлов,
 * «Parameters» сырым JSON, «Calls per attempt», «Media transfer» (жалоба
 * 19.10.2026 со снимком окна). Человеку из них не нужно ничего, а сумма
 * терялась среди них.
 *
 * Если окно открылось потому, что точная цена разошлась с той, что стояла на
 * кнопке, — говорим это одной строкой: иначе непонятно, зачем окно вообще
 * появилось.
 */

/** Сколько знаков промпта показываем в окне: дальше это уже чтение, а не проверка. */
const PROMPT_PREVIEW_CHARS = 160

export function promptSummary(prompts: readonly string[]): string | null {
  const unique = [...new Set(prompts.map((prompt) => prompt.trim()).filter(Boolean))]
  if (unique.length === 0) return null
  if (unique.length > 1) return `${unique.length} different prompts`
  const chars = Array.from(unique[0]!)
  return chars.length > PROMPT_PREVIEW_CHARS
    ? `${chars.slice(0, PROMPT_PREVIEW_CHARS).join('').trimEnd()}…`
    : unique[0]!
}

export function generationReviewRows(
  base: ReadonlyArray<[string, string]>,
  input: { prompts: readonly string[]; shownEstimate: string | null },
): Array<[string, string]> {
  const rows = base.map(([label, value]) => [label, value] as [string, string])
  const prompt = promptSummary(input.prompts)
  if (prompt) {
    const model = rows.findIndex(([label]) => label === 'Model')
    rows.splice(model + 1, 0, ['Prompt', prompt])
  }
  if (input.shownEstimate) {
    // Перед строкой суммы: «было на кнопке» и «будет списано» читаются рядом.
    rows.splice(Math.max(0, rows.length - 1), 0, ['Estimate shown', input.shownEstimate])
  }
  return rows
}
