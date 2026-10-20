import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { ALL_LOCKED, boardLockKey, lockedIdsFromKey } from './boardLocks'

/**
 * Совместная работа на планшете (пункт 3.8, находка С-9): доска перерисовывалась
 * на каждый кадр чужого курсора. Ей нужен только набор закрытых объектов.
 */

function storeWith(port: { held: Set<string>; editable: boolean } | null): CanvasStore {
  return {
    getCollaboration: () => port && {
      heldObjectIds: () => port.held,
      getSnapshot: () => ({ locks: [] }),
    },
    canMutateItems: (ids: readonly string[]) => Boolean(port?.editable) && !ids.some((id) => port?.held.has(id)),
  } as unknown as CanvasStore
}

test('ключ закрытых объектов меняется только вместе с набором, а не с курсорами', () => {
  const port = { held: new Set(['b', 'a']), editable: true }
  const store = storeWith(port)
  const first = boardLockKey(store)
  // Кадр чужого курсора ничего не меняет в арендах — ключ тот же, и
  // useSyncExternalStore не будит доску.
  assert.equal(boardLockKey(store), first)
  assert.deepEqual([...lockedIdsFromKey(first)!].sort(), ['a', 'b'])

  port.held = new Set(['a'])
  assert.notEqual(boardLockKey(store), first)
})

test('без права на доску закрыто всё; своя доска — ничего', () => {
  assert.equal(boardLockKey(storeWith({ held: new Set(), editable: false })), ALL_LOCKED)
  assert.equal(lockedIdsFromKey(ALL_LOCKED), null)
  assert.equal(boardLockKey(storeWith(null)), '')
  assert.equal(lockedIdsFromKey('')?.size, 0)
})

test('СТОРОЖ: доска планшета не подписана на всю совместную работу, кадры жеста притормаживаются', () => {
  const canvas = readFileSync(new URL('./BoardCanvas.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(canvas, /useCollaborationVersion\(store\)/, 'кадры курсоров снова перерисуют всю доску')
  assert.match(canvas, /boardLockKey\(store\)/)
  assert.match(canvas, /GESTURE_FRAME_MS/, 'кадр своего переноса уходит без притормаживания')
  assert.doesNotMatch(canvas, /new Map\(store\.getSelectableItems\(\)/, 'карта всех объектов на каждое движение пальца')
  assert.match(canvas, /<MemoBoardItemView/)
})
