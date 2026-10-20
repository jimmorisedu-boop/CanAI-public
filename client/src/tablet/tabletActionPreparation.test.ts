import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  freezeTabletPreparationRefs,
  tabletPreparationIsCurrent,
  tabletPreparationPrompt,
} from './tabletActionPreparation'

const assistantPresetsSource = readFileSync(new URL('./TabletAssistantPresets.tsx', import.meta.url), 'utf8')

test('tablet preparation freezes source identity and keeps text fallback once', () => {
  const refs = [
    { shapeId: 'image-1', kind: 'image' as const, label: 'source', src: '/media/source.png' },
    { shapeId: 'note-1', kind: 'text' as const, label: 'note', text: 'свет слева' },
  ]
  const frozen = freezeTabletPreparationRefs(refs)
  refs[0]!.src = '/media/changed.png'
  assert.equal(frozen[0]?.src, '/media/source.png')
  assert.equal(tabletPreparationPrompt('', frozen), 'свет слева')
  assert.equal(tabletPreparationPrompt('замени фон', frozen), 'замени фон')
})

test('tablet preparation rejects stale mode and board scopes', () => {
  const scope = { epoch: 4, projectId: 'board-1', projectSource: 'local' as const, mode: 'prompt' as const }
  assert.equal(tabletPreparationIsCurrent(scope, { projectId: 'board-1', projectSource: 'local', mode: 'prompt' }), true)
  assert.equal(tabletPreparationIsCurrent(scope, { projectId: 'board-2', projectSource: 'local', mode: 'prompt' }), false)
  assert.equal(tabletPreparationIsCurrent(scope, { projectId: 'board-1', projectSource: 'local', mode: 'assistant' }), false)
})

test('tablet assistant row keeps Universal explicit and does not reset selection on load failure', () => {
  assert.match(assistantPresetsSource, /Universal/)
  assert.match(assistantPresetsSource, /activeId === null/)
  assert.match(assistantPresetsSource, /setActiveAssistant\(next\)/)
  assert.match(assistantPresetsSource, /previous === preset\?\.id \? null : preset\?\.id/)
  assert.match(assistantPresetsSource, /loadState === 'loading'/)
  assert.match(assistantPresetsSource, /loadState === 'error'/)
  assert.doesNotMatch(assistantPresetsSource, /\.catch\(\(\) => \{\s*setPresets\(\[\]\)\s*setActiveId\(null\)/)
})
