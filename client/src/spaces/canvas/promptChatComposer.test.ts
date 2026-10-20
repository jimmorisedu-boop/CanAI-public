import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activateConversationDraft,
  draftFromComposer,
  refsFromConversationDraft,
  resolvePromptEnterAction,
} from './promptChatComposer'
import type { PromptChatDraft } from './promptChatTypes'

function draft(text: string, srcs: string[], caret: number): PromptChatDraft {
  return {
    text,
    attachments: srcs.map((src, index) => ({
      shapeId: `shape-${index}`,
      kind: 'image',
      label: `Референс ${index + 1}`,
      src,
    })),
    selectionStart: caret,
    selectionEnd: caret,
  }
}

test('возвращает независимый черновик выбранного диалога', () => {
  const drafts = {
    c1: draft('Первый', ['/media/a.png'], 6),
    c2: draft('Второй', [], 0),
  }
  assert.deepEqual(activateConversationDraft(drafts, 'c1'), drafts.c1)
  assert.deepEqual(activateConversationDraft(drafts, 'c2'), drafts.c2)
})

test('преобразует только явные вложения и сохраняет выделение текста', () => {
  const source = draft('Текст', ['/media/a.png'], 3)
  source.attachments[0] = { ...source.attachments[0], assetId: 'ast_cloud' }
  const refs = refsFromConversationDraft(source)
  const restored = draftFromComposer('Текст', refs, 1, 4)

  assert.equal(refs[0].src, '/media/a.png')
  assert.equal(refs[0].assetId, 'ast_cloud')
  assert.equal(restored.selectionStart, 1)
  assert.equal(restored.selectionEnd, 4)
  assert.deepEqual(restored.attachments, source.attachments)
})

test('модифицированный Enter следует активной вкладке', () => {
  const enter = {
    key: 'Enter',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  }

  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey'] as const) {
    const modified = { ...enter, [modifier]: true }
    assert.equal(resolvePromptEnterAction(modified, false), 'generate')
    assert.equal(resolvePromptEnterAction(modified, true), 'ask')
  }
  assert.equal(resolvePromptEnterAction(enter, true), null)
  assert.equal(resolvePromptEnterAction({ ...enter, key: 'Escape', shiftKey: true }, true), null)
  assert.equal(resolvePromptEnterAction({ ...enter, altKey: true }, false), 'ask')
  assert.equal(resolvePromptEnterAction({ ...enter, altKey: true }, true), 'ask')
})
