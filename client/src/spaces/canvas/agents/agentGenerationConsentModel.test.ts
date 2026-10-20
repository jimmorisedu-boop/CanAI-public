import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approveGenerationConsent,
  emptyGenerationConsentDraft,
  freezeGenerationConsentRefs,
  generationConsentIsReady,
  generationConsentRows,
  generationConsentScope,
  hasCurrentGenerationConsent,
  revokeGenerationConsent,
  type GenerationConsentInput,
} from './agentGenerationConsentModel.js'

function input(overrides: Partial<GenerationConsentInput> = {}): GenerationConsentInput {
  return {
    projectRef: { source: 'cloud', id: 'board-1' },
    kind: 'image',
    modelId: 'image-model',
    catalogRevision: 12,
    prompt: 'Сделай обложку',
    orderedRefs: [
      { kind: 'image', identity: 'shape:a:file-a', label: 'A' },
      { kind: 'image', identity: 'shape:b:file-b', label: 'B' },
    ],
    params: { size: '2k', aspect: '1:1' },
    mode: 'each',
    attempts: 1,
    maxCalls: 1,
    mediaTransferRequired: true,
    mediaTransferConsent: true,
    estimatedCostMicros: 500_000,
    ...overrides,
  }
}

test('scope is canonical but preserves ordered refs and revokes on launch-shape changes', () => {
  const base = input()
  const reorderedParams = input({ params: { aspect: '1:1', size: '2k' } })
  assert.equal(generationConsentScope(base), generationConsentScope(reorderedParams))
  assert.notEqual(
    generationConsentScope(base),
    generationConsentScope(input({ orderedRefs: [...base.orderedRefs].reverse() })),
  )
  assert.notEqual(generationConsentScope(base), generationConsentScope(input({ mode: 'together' })))
  assert.notEqual(generationConsentScope(base), generationConsentScope(input({ modelId: 'other-model' })))
  assert.notEqual(generationConsentScope(base), generationConsentScope(input({ catalogRevision: 13 })))
  assert.notEqual(generationConsentScope(base), generationConsentScope(input({ prompt: 'Другой промпт' })))
  assert.notEqual(generationConsentScope(base), generationConsentScope(input({ estimatedCostMicros: 600_000 })))
})
test('media generation requires its own explicit consent; text-only consent cannot satisfy it', () => {
  const scope = generationConsentScope(input())
  const approved = approveGenerationConsent(emptyGenerationConsentDraft(), scope, true)
  assert.equal(generationConsentIsReady(input(), approved), true)
  assert.equal(generationConsentIsReady(input({ mediaTransferConsent: false }), approved), false)
  assert.equal(generationConsentIsReady(input({ orderedRefs: [] }), approved), false)
  assert.equal(hasCurrentGenerationConsent(approved, scope), true)
  assert.equal(hasCurrentGenerationConsent(revokeGenerationConsent(approved), scope), false)
})

test('each-mode review displays every attempt and aggregate estimate once', () => {
  const rows = generationConsentRows([
    input({ orderedRefs: [{ kind: 'image', identity: 'shape:a:file-a', label: 'A' }], estimatedCostMicros: 500_000 }),
    input({ orderedRefs: [{ kind: 'image', identity: 'shape:b:file-b', label: 'B' }], estimatedCostMicros: 700_000 }),
  ])
  assert.deepEqual(rows.find(([label]) => label === 'Attempts'), ['Attempts', '2'])
  assert.deepEqual(rows.find(([label]) => label === 'Total estimate'), ['Total estimate', '$1.2'])
  assert.match(rows.find(([label]) => label === 'References in order')?.[1] ?? '', /1\/ 1\. image · A[\s\S]*2\/ 1\. image · B/u)
  assert.deepEqual(rows.find(([label]) => label === 'Calls per attempt'), ['Calls per attempt', '1'])
})

test('freezing selection refs keeps identity changes visible in the scope', () => {
  const refs = freezeGenerationConsentRefs([
    { kind: 'image', shapeId: 'shape-1', assetId: 'asset-1', src: '/media/a.png', label: 'A' },
    { kind: 'text', shapeId: 'text-1', text: 'hello', label: 'Текст' },
  ])
  assert.equal(refs[0]?.identity, 'asset:asset-1:/media/a.png')
  assert.equal(refs[1]?.identity, 'shape:text-1:hello')
})

test('textPreparation входит в scope только при наличии и отзывает согласие при смене помощника', () => {
  const base = input()
  // Без textPreparation scope не меняется
  const withoutField = input({ textPreparation: null })
  assert.equal(generationConsentScope(base), generationConsentScope(withoutField))

  // С textPreparation scope отличается
  const withHelper = input({ textPreparation: { assistantId: 'helper-1', versionId: 'v1' } })
  assert.notEqual(generationConsentScope(base), generationConsentScope(withHelper))

  // Смена помощника или версии меняет scope
  const withDifferentHelper = input({ textPreparation: { assistantId: 'helper-2', versionId: 'v1' } })
  const withDifferentVersion = input({ textPreparation: { assistantId: 'helper-1', versionId: 'v2' } })
  assert.notEqual(generationConsentScope(withHelper), generationConsentScope(withDifferentHelper))
  assert.notEqual(generationConsentScope(withHelper), generationConsentScope(withDifferentVersion))

  // Строка помощника появляется в generationConsentRows
  const rows = generationConsentRows([withHelper])
  assert.deepEqual(rows.find(([label]) => label === 'Assistant'), ['Assistant', 'helper-1'])
})
