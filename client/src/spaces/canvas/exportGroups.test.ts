import assert from 'node:assert/strict'
import test from 'node:test'
import { groupsFromLegacyItems } from './exportGroups'

test('legacy numeric marks become understandable export groups', () => {
  const items = [
    { id: 'a', kind: 'image' as const, x: 0, y: 0, w: 1, h: 1, mark: 1 },
    { id: 'b', kind: 'text' as const, x: 0, y: 0, w: 1, h: 1, mark: 1 },
  ]
  assert.deepEqual(groupsFromLegacyItems(items), [
    { id: '1', mark: 1, name: 'Group 1', itemIds: ['a', 'b'] },
  ])
})
