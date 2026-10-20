import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicEditSession } from '../../api'
import { editNoticeGroupText, groupEditNotices } from './editNoticeGroups'

// Жалоба 19.08.2026 (скриншот): шесть полосок «"…" открыт в редакторе — жду
// сохранения» встали стопкой над промпт-баром и закрыли пол-холста. Открыть в
// Фотошопе несколько картинок — обычное дело, а сообщение у них одно и то же.

function session(patch: Partial<PublicEditSession> & { id: string }): PublicEditSession {
  return {
    projectId: 'board-1',
    sourceItemId: 'item',
    sourceName: `файл-${patch.id}.png`,
    fileName: `edit-${patch.id}.png`,
    url: `/media/edit-${patch.id}.png`,
    createdAt: 1,
    expiresAt: 2,
    lastMtime: 0,
    appliedMtime: 0,
    placedItemId: null,
    state: 'waiting',
    projectName: 'Доска',
    projectStatus: 'active',
    ...patch,
  }
}

test('одинаковые сообщения складываются в одну группу', () => {
  const groups = groupEditNotices([session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].sessions.length, 3)
  assert.equal(editNoticeGroupText(groups[0]), '3 files are open in the editor - waiting for saving (Ctrl+S)…')
})

test('одиночное сообщение говорит ровно то же, что и раньше', () => {
  // Когда файл один, имя — самое полезное в сообщении, и терять его нельзя.
  const [group] = groupEditNotices([session({ id: 'a', sourceName: 'портрет.png' })])
  assert.equal(editNoticeGroupText(group), '“портрет.png” is open in the editor - waiting for saving (Ctrl+S)…')
})

test('разные состояния не сваливаются в кучу', () => {
  const groups = groupEditNotices([
    session({ id: 'a' }),
    session({ id: 'b', state: 'applied' }),
    session({ id: 'c' }),
  ])
  assert.deepEqual(groups.map((g) => g.state), ['waiting', 'applied'])
  assert.deepEqual(groups.map((g) => g.sessions.length), [2, 1])
})

test('разные доски остаются разными сообщениями', () => {
  // У группы общие кнопки («Открыть доску»), поэтому доска обязана совпадать.
  const groups = groupEditNotices([
    session({ id: 'a' }),
    session({ id: 'b', projectId: 'board-2' }),
  ])
  assert.equal(groups.length, 2)
})

test('судьба доски тоже разводит группы', () => {
  // У удалённой доски своя кнопка — «Открыть корзину».
  const groups = groupEditNotices([
    session({ id: 'a' }),
    session({ id: 'b', projectStatus: 'trashed' }),
  ])
  assert.equal(groups.length, 2)
})

test('порядок групп — по первому появлению', () => {
  // Сообщения не должны прыгать местами, пока человек тянется к кнопке.
  const groups = groupEditNotices([
    session({ id: 'a', state: 'applied' }),
    session({ id: 'b' }),
    session({ id: 'c', state: 'applied' }),
  ])
  assert.deepEqual(groups.map((g) => g.state), ['applied', 'waiting'])
})

test('English file counts stay plural after one', () => {
  const text = (count: number) =>
    editNoticeGroupText(groupEditNotices(
      Array.from({ length: count }, (_, i) => session({ id: String(i) })),
    )[0])
  assert.match(text(2), /^2 files /)
  assert.match(text(5), /^5 files /)
  assert.match(text(11), /^11 files /)
  assert.match(text(21), /^21 files /)
})
