import assert from 'node:assert/strict'
import test from 'node:test'
import {
  autoSyncEffect,
  hasUnpublishedChanges,
  publicationAction,
  publicationForPersonalDraft,
} from './accountPublicationModel'

test('приватная синхронизация никогда сама не меняет публичную версию', () => {
  assert.equal(publicationAction({ dirty: true, canPublish: true }), 'publish')
  assert.equal(publicationAction({ dirty: true, canPublish: false }), 'blocked')
  assert.deepEqual(autoSyncEffect({ dirty: true, publicationId: 'pub-1' }), { publishes: false })
})

test('связывает публикацию с личным черновиком, а не с локальным id', () => {
  const items = [
    { id: 'other', sourceKind: 'personal' as const, personalDraftId: 'draft-2' },
    { id: 'mine', sourceKind: 'personal' as const, personalDraftId: 'draft-1' },
  ]
  assert.equal(publicationForPersonalDraft(items, 'draft-1')?.id, 'mine')
})

test('показывает неопубликованные изменения только при разных подтверждённых ревизиях', () => {
  assert.equal(hasUnpublishedChanges('remote-2', 'remote-1'), true)
  assert.equal(hasUnpublishedChanges('remote-2', 'remote-2'), false)
  assert.equal(hasUnpublishedChanges(undefined, 'remote-1'), false)
})
