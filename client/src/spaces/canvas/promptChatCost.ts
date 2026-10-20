import type { CatalogModel } from '../../types'

export function estimatePromptChatCost(
  model: CatalogModel | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = model?.textPricing
  if (!price) return null
  return inputTokens / 1_000_000 * price.inputPerMillion
    + outputTokens / 1_000_000 * price.outputPerMillion
}
