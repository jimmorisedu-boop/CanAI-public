import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { boardHasUnseenNotes, boardSeenKey } from './boardNotice.js'

/**
 * ⚠️ Значок непрочитанного живёт в ШАПКЕ ОТКРЫТОЙ доски, поэтому о новом
 * замечании узнавал только тот, кто эту доску уже открыл. Вопрос заказчика был
 * прямым: «а есть ли уведомления у тебя, что я что-то написала» (09.09.2026) —
 * и ответ был «нет».
 */
test('доска зовёт к себе, только когда есть чужое и непрочитанное', () => {
  assert.equal(boardHasUnseenNotes(200, 100), true)
  assert.equal(boardHasUnseenNotes(100, 100), false, 'ровно то же время — уже видели')
  assert.equal(boardHasUnseenNotes(50, 100), false)
  // ⚠️ Старый сервер поля не присылает — тогда мы ничего не обещаем, а не
  // помечаем всё подряд.
  assert.equal(boardHasUnseenNotes(undefined, 0), false)
  assert.equal(boardHasUnseenNotes(null, 0), false)
  assert.equal(boardHasUnseenNotes(Number.NaN, 0), false)
})

test('the local board-notes key stays deterministic for its owner', () => {
  assert.equal(boardSeenKey('prj_1'), 'canai.board-notes-seen.prj_1')
})

test('the local gallery has no shared-board notice transport', async () => {
  const screen = await readFile(new URL('./ProjectsScreen.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(screen, /BoardDiscussionHost|boardHasUnseenNotes|project-thumb-notes/)
  assert.doesNotMatch(screen, /notify\(\{[^}]*comments/i)
})
