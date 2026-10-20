// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { PublicEditSession } from '../../api'
import {
  createEditNoticeMemory,
  dismissEditNotice,
  forgetEditNotices,
  needsAttention,
  visibleEditNotices,
} from './externalEditNotices'

function session(patch: Partial<PublicEditSession> = {}): PublicEditSession {
  return {
    id: 'session-1', projectId: 'board-1', sourceItemId: 'item-1', sourceName: 'Фото',
    fileName: 'edit.png', url: '/media/edit.png', createdAt: 1, expiresAt: 999,
    lastMtime: 20, appliedMtime: 20, placedItemId: 'item-2', state: 'applied',
    projectName: 'Доска', projectStatus: 'active', ...patch,
  }
}

/**
 * ⚠️ Правило пользователя (07.09.2026): «нужны только оповещения, где нужно
 * участие человека». До этого угол сообщал обо всём подряд, включая «Правки
 * применены: 6 файлов» — про правку, которая УЖЕ лежит на холсте.
 */
test('о свершившемся не сообщаем: правка на холсте и есть сообщение', () => {
  const memory = createEditNoticeMemory(0)
  const applied = session({ state: 'applied' })
  const waiting = session({ id: 'session-2', state: 'waiting', createdAt: 10 })

  assert.deepEqual(visibleEditNotices([applied, waiting], memory, 1_000, 'board-1'), [])
  assert.equal(needsAttention(applied, 'board-1'), false)
  assert.equal(needsAttention(waiting, 'board-1'), false, 'ответ на F2 — сам открывшийся редактор')
})

test('сломанная сессия показывается всегда: она требует решения', () => {
  const memory = createEditNoticeMemory(0)
  const broken = session({ state: 'broken', error: 'Файл занят' })

  assert.deepEqual(visibleEditNotices([broken], memory, 0, 'board-1').map((item) => item.id), ['session-1'])
  assert.deepEqual(
    visibleEditNotices([broken], memory, 10_000_000, 'board-1').map((item) => item.id),
    ['session-1'],
    'по времени она не гаснет: проблема сама не проходит',
  )
})

test('готовая правка зовёт только к ЧУЖОЙ доске', () => {
  const memory = createEditNoticeMemory(0)
  const here = session({ state: 'ready', projectId: 'board-1' })
  const elsewhere = session({ id: 'session-2', state: 'ready', projectId: 'board-2' })

  // На текущей доске правка применится сама — звать некуда.
  assert.deepEqual(visibleEditNotices([here], memory, 0, 'board-1'), [])
  // А эта так и будет лежать, пока ту доску не откроют.
  assert.deepEqual(
    visibleEditNotices([elsewhere], memory, 0, 'board-1').map((item) => item.id),
    ['session-2'],
  )
})

test('крестик скрывает сообщение, не трогая слежение', () => {
  const memory = createEditNoticeMemory(0)
  const broken = session({ state: 'broken', error: 'Файл занят' })
  visibleEditNotices([broken], memory, 0, 'board-1')

  dismissEditNotice(memory, broken)
  assert.equal(visibleEditNotices([broken], memory, 100, 'board-1').length, 0, 'скрытое не возвращается само')

  const другая = session({ state: 'broken', error: 'Доска удалена' })
  assert.equal(
    visibleEditNotices([другая], memory, 200, 'board-1').length,
    1,
    'но о новой беде скажет',
  )
})

test('остановленная сессия забывается целиком', () => {
  const memory = createEditNoticeMemory(0)
  const broken = session({ state: 'broken', error: 'Файл занят' })
  visibleEditNotices([broken], memory, 0, 'board-1')
  dismissEditNotice(memory, broken)

  forgetEditNotices(memory, broken.id)
  assert.equal(memory.dismissed.size, 0)
  assert.equal(memory.shownAt.size, 0)
})
