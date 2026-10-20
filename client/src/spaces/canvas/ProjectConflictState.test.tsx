import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectConflictState } from './ProjectConflictState'

const callbacks = {
  onOpenCopy: () => {},
  onUseServer: () => {},
  onRetry: () => {},
  onRepair: () => {},
  onDownload: () => {},
}

const local = {
  version: 1 as const,
  items: [],
  camera: { x: 0, y: 0, scale: 1 },
}

test('во время записи не обещает сохранность и не показывает выбор', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="saving"
      conflict={null}
      retrying={false}
      {...callbacks}
    />,
  )

  assert.match(html, /We save the changes from this tab/)
  assert.doesNotMatch(html, /Both versions saved|Open my copy/)
})

test('подтверждённая копия разрешает безопасно закрыть вкладку', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      retrying={false}
      conflict={{
        local,
        serverRevision: 3,
        recoveryProject: { id: 'conflict-safe', name: 'Моя копия', revision: 1 },
        status: 'saved',
      }}
      {...callbacks}
    />,
  )

  assert.match(html, /Both versions saved/)
  assert.match(html, /can be safely closed/)
  assert.match(html, />Open my copy</)
  // ⚠️ Раньше здесь закреплялась подпись «Продолжить с последней версией» — и
  // закрепляла она беду: кнопка только перезагружала страницу, а созданная
  // сервером копия оставалась в галерее второй доской.
  assert.match(html, />Remove copy and continue</)
  assert.match(html, />Download JSON</)
})

test('неполная запись предлагает повтор и не обещает безопасность', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      retrying={false}
      conflict={{
        local,
        serverRevision: 3,
        recoveryProject: { id: 'conflict-unsafe', name: 'Моя копия', revision: 0 },
        status: 'needs-retry',
      }}
      {...callbacks}
    />,
  )

  assert.match(html, /The latest changes have not been saved yet/)
  assert.match(html, />Retry</)
  assert.match(html, />Download JSON</)
  assert.doesNotMatch(html, /can be safely closed/)
})

test('повреждённый ответ сервера оставляет только скачивание JSON', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      retrying={false}
      conflict={{
        local,
        serverRevision: 3,
        recoveryProject: null,
        status: 'needs-retry',
      }}
      {...callbacks}
    />,
  )

  assert.doesNotMatch(html, />Retry|Open my copy</)
  assert.match(html, />Download JSON</)
})

test('недоступное media предлагает JSON, повтор и ручной ремонт', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      retrying={false}
      conflict={{
        local,
        serverRevision: 3,
        recoveryProject: null,
        status: 'needs-retry',
        reason: 'invalid-snapshot',
      }}
      {...callbacks}
    />,
  )

  assert.match(html, /return the original files/i)
  assert.match(html, />Retry</)
  assert.match(html, />Return to the board and correct</)
  assert.match(html, />Download JSON</)
})

test('CanvasSpace блокирует интерактивный холст и не создаёт копию вручную', () => {
  const source = readFileSync(new URL('./CanvasSpace.tsx', import.meta.url), 'utf8')

  // Холст живёт РОВНО в одном случае: доска загружена и за рулём это
  // устройство. Второе условие добавилось вместе с передачей сеанса между
  // компьютером и планшетом: пока доску держат там, правки отсюда никуда не
  // сохранятся, и оставить холст живым значило бы дать работать в пустоту.
  assert.match(source, /const boardLoaded = loadState === 'ready'/)
  assert.match(source, /\{boardLoaded && !handoff \? <>/)
  assert.doesNotMatch(source, /loadState === 'ready' \|\| loadState === 'conflict'/)
  assert.match(source, /<ProjectConflictState/)
  assert.match(source, /retryConflictRecovery/)
  assert.doesNotMatch(source, /api\.createProject\('Конфликтная копия'\)/)
})

test('вторая кнопка говорит, что станет с копией, а не «продолжить»', () => {
  // ⚠️ Раньше она называлась «Продолжить с последней версией» и просто
  // перезагружала страницу: копия, уже созданная сервером, оставалась в
  // галерее, и человек, выбравший последнюю версию, находил две доски
  // (жалоба тестировщика 18.09.2026).
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      conflict={{
        local,
        serverRevision: 7,
        recoveryProject: { id: 'conflict-1', name: 'доска — копия', revision: 1 },
        status: 'saved',
      }}
      retrying={false}
      {...callbacks}
    />,
  )
  assert.match(html, /Remove copy and continue/)
  assert.doesNotMatch(html, /Continue with the latest version/)
  // И сказано, куда она денется: выбор «не нужна» не обязан быть необратимым.
  assert.match(html, /trash/i)
})

test('пока копию убирают, кнопка занята и говорит об этом', () => {
  const html = renderToStaticMarkup(
    <ProjectConflictState
      phase="conflict"
      conflict={{
        local,
        serverRevision: 7,
        recoveryProject: { id: 'conflict-1', name: 'доска — копия', revision: 1 },
        status: 'saved',
      }}
      retrying={false}
      discarding
      {...callbacks}
    />,
  )
  assert.match(html, /remove\.\.\./)
})
