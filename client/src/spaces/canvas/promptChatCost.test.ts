import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import { estimatePromptChatCost } from './promptChatCost'

test('оценивает длинный ответ по входным и выходным токенам', () => {
  const model = {
    id: 'gemini',
    name: 'Gemini 3.8 Flash',
    kind: 'text',
    endpoint: 'openrouter/router',
    refs: false,
    params: [],
    textPricing: {
      inputPerMillion: 1.5,
      outputPerMillion: 7.5,
      checkedAt: '2026-07-28',
    },
  } as CatalogModel

  assert.equal(estimatePromptChatCost(model, 8_000, 1_000), 0.0195)
  assert.equal(estimatePromptChatCost(undefined, 8_000, 1_000), null)
})
