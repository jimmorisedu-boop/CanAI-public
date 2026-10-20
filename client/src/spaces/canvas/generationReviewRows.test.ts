import assert from 'node:assert/strict'
import test from 'node:test'
import { generationReviewRows, promptSummary } from './generationReviewRows'

test('промпт в окне короткий, а разные промпты серии не перечисляются', () => {
  assert.equal(promptSummary(['  кот  ', 'кот']), 'кот')
  assert.equal(promptSummary(['кот', 'пёс']), '2 different prompts')
  assert.equal(promptSummary(['', '  ']), null)
  const long = 'а'.repeat(400)
  assert.equal(promptSummary([long]), `${'а'.repeat(160)}…`)
  assert.deepEqual(
    generationReviewRows([['Model', 'M'], ['Tasks', '1'], ['No more than', '$1.00']], { prompts: [], shownEstimate: '$0.90' }),
    [['Model', 'M'], ['Tasks', '1'], ['Estimate shown', '$0.90'], ['No more than', '$1.00']],
  )
})
