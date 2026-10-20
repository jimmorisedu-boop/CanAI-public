import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { PublicEditSession } from '../../api'
import {
  ExternalEditStatusHost,
  externalEditAnnouncement,
} from './ExternalEditStatusHost'
import type { ExternalEditSnapshot } from './externalEditRegistry'

function session(patch: Partial<PublicEditSession> = {}): PublicEditSession {
  return {
    id: 'session-1', projectId: 'board-other', sourceItemId: 'source-1', sourceName: 'Фото',
    fileName: 'edit.png', url: '/media/edit.png', // Сессия ЭТОГО запуска: поднятые из прошлого молчат (см. externalEditNotices)
    createdAt: Date.now(), expiresAt: Date.now() + 999_000,
    lastMtime: 20, appliedMtime: 10, placedItemId: null, state: 'ready',
    projectName: 'Проект', projectStatus: 'active', ...patch,
  }
}

function snapshot(sessions: PublicEditSession[], patch: Partial<ExternalEditSnapshot> = {}): ExternalEditSnapshot {
  return { status: 'ready', sessions, ...patch }
}

function render(value: ExternalEditSnapshot, currentProjectId: string | null = 'board-current'): string {
  return renderToStaticMarkup(
    <ExternalEditStatusHost
      snapshot={value}
      currentProjectId={currentProjectId}
      onOpenProject={() => {}}
      onOpenTrash={() => {}}
      onRevealFile={() => {}}
      onStop={() => {}}
    />,
  )
}

test('остановка и скрытие — разные действия, обе кнопки читаемые', () => {
  // ⚠️ Карточка теперь бывает только там, где нужно решение человека: сюда
  // берём сломанную сессию своей доски (правило 07.09.2026).
  const html = render(snapshot([session({ projectId: 'board-current', state: 'broken', error: 'Файл занят' })]))
  assert.match(html, /The file is busy\./)
  assert.doesNotMatch(html, /Файл занят/)
  assert.match(html, />Stop tracking</)
  assert.doesNotMatch(html, />Open board</, 'своя доска уже открыта')
})

test('о свершившемся и об ожидании угол молчит', () => {
  // Правка УЖЕ на холсте — карточка «Правки применены: 6 файлов» занимала
  // место и требовала «Скрыть», не сообщая ничего нового. Ответ на F2 — сам
  // открывшийся редактор; живое слежение видно в «Задачах» в шапке.
  const applied = render(snapshot([session({ projectId: 'board-current', state: 'applied' })]))
  assert.equal(applied, '', 'о применённой правке не сообщаем')
  const waiting = render(snapshot([session({ projectId: 'board-current', state: 'waiting' })]))
  assert.equal(waiting, '', 'об ожидании тоже')
})

test('canvas cleanup observes rejected final-save promises', () => {
  const source = readFileSync(new URL('./CanvasSpace.tsx', import.meta.url), 'utf8')
  assert.match(source, /handle\.dispose\(\)\.catch\(/)
  assert.match(source, /dispose\(\)\.catch\(/)
})

test('готовая правка другой доски предлагает открыть доску и прекратить слежение', () => {
  const html = render(snapshot([session()]))
  assert.match(html, /Edit ready for board «Проект»/)
  assert.match(html, />Open board</)
  assert.match(html, />Stop tracking</)
})

test('сообщения приходят из ОДНОГО места, а не из двух', () => {
  // Раньше свои правки показывала полоска над промпт-баром, а этот угол их
  // намеренно пропускал, чтобы не задваивать. Полоски давно нет, а теперь
  // угол и вовсе молчит обо всём, кроме требующего решения.
  const broken = session({ projectId: 'board-current', state: 'broken', error: 'Файл не найден' })
  assert.notEqual(render(snapshot([broken])), '')
  const source = readFileSync(new URL('./PromptNotices.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /useEditNotices|PublicEditSession/, 'над холстом сообщений о правках быть не должно')
})

test('доска в корзине предлагает открыть корзину', () => {
  const html = render(snapshot([session({ projectStatus: 'trashed', projectName: 'Удалённая' })]))
  assert.match(html, /Edit ready for board «Удалённая»/)
  assert.match(html, />Open trash</)
  assert.doesNotMatch(html, />Open board</)
})

test('окончательно удалённая доска предлагает показать файл и остановить слежение', () => {
  const html = render(snapshot([session({
    projectStatus: 'missing', projectName: null, state: 'broken', error: 'Доска не найдена',
  })]))
  assert.match(html, />Show file in folder</)
  assert.match(html, />Stop tracking</)
})

test('ошибка соединения не скрывает сохранённые сессии', () => {
  const html = render(snapshot([session()], { status: 'error', error: 'Нет связи' }))
  assert.match(html, /Connection lost\./)
  assert.doesNotMatch(html, /Нет связи/)
  assert.match(html, /Edit ready for board/)
})

test('готовая правка вежлива, сломанная — срочный alert', () => {
  const ready = render(snapshot([session()]))
  assert.match(ready, /role="status"/)
  assert.match(ready, /aria-live="polite"/)
  const broken = render(snapshot([session({ state: 'broken', error: 'Файл не найден' })]))
  assert.match(broken, /role="alert"/)
  assert.match(broken, /aria-live="assertive"/)
})

test('один и тот же ready snapshot не объявляется повторно', () => {
  const seen = new Set<string>()
  const value = snapshot([session()])
  assert.deepEqual(externalEditAnnouncement(value, seen), {
    message: 'Edit ready for board «Проект»', priority: 'polite',
  })
  assert.equal(externalEditAnnouncement(value, seen), null)
  assert.deepEqual(externalEditAnnouncement(snapshot([session({ state: 'broken', error: 'Файл не найден' })]), seen), {
    message: 'File not found.', priority: 'assertive',
  })
})
