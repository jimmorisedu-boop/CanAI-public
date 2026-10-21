import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InlineNotice } from './InlineNotice.js'
import { LocalRecoveryNotice } from './LocalRecoveryNotice.js'
import { PriceBadge } from './PriceBadge.js'
import { PromptNotices } from '../spaces/canvas/PromptNotices.js'
import { LanguageProvider } from '../i18n/context.js'
import { createLanguageStore } from '../i18n/language.js'
import type { ProjectSource, ServerStatus } from '../types.js'

const missingFalStatus = {
  falConfigured: false,
  mockMode: false,
  serverFingerprint: null,
  instanceId: 'test',
  shuttingDown: false,
} as ServerStatus

test('backup recovery warning is visible on desktop and tablet until review', () => {
  assert.equal(renderToStaticMarkup(<LocalRecoveryNotice />), '')
  assert.equal(renderToStaticMarkup(<LocalRecoveryNotice needsReview={false} />), '')
  const desktop = renderToStaticMarkup(<LocalRecoveryNotice needsReview onHelp={() => {}} />)
  const tablet = renderToStaticMarkup(<LocalRecoveryNotice needsReview />)
  for (const html of [desktop, tablet]) {
    assert.match(html, /Recovered data needs review/)
    assert.match(html, /data-tone="warning"/)
    assert.match(html, /Media cleanup is paused/)
    assert.match(html, /before retrying a generation/)
  }
  assert.match(desktop, /Recovery help/)
  assert.doesNotMatch(tablet, /<button/)
})

function renderPromptNotices(projectSource: ProjectSource, serverStatus = missingFalStatus): string {
  return renderToStaticMarkup(
    <PromptNotices
      projectSource={projectSource}
      serverStatus={serverStatus}
      catalogEmpty={false}
      catalogError={false}
      onRetryCatalog={() => {}}
      replacementNumber={undefined}
      onCancelReplacement={() => {}}
      localError={null}
      onDismissLocalError={() => {}}
      editorNotice={null}
      onDismissEditorNotice={() => {}}
    />,
  )
}

test('ошибка — alert, а информационное сообщение — status с одинаковой структурой', () => {
  const error = renderToStaticMarkup(
    <InlineNotice tone="error" title="Не удалось загрузить" detail="Сеть недоступна" />,
  )
  const info = renderToStaticMarkup(
    <InlineNotice tone="info" title="Подсказка">Добавьте референс</InlineNotice>,
  )

  assert.match(error, /class="inline-notice/)
  assert.match(error, /data-tone="error"/)
  assert.match(error, /role="alert"/)
  assert.match(error, /Request failed\. Open the diagnostic log for details\./)
  assert.match(error, /The network is unavailable/)
  assert.doesNotMatch(error, /Не удалось загрузить|Сеть недоступна/)
  assert.match(info, /data-tone="info"/)
  assert.match(info, /role="status"/)
  assert.match(info, /Добавьте референс/)
})

test('сетевая доска не показывает сообщение об отсутствующем локальном ключе fal', () => {
  assert.match(renderPromptNotices('local'), /The fal\.ai key is not configured/)
  assert.doesNotMatch(renderPromptNotices('cloud'), /The fal\.ai key is not configured/)
})

test('explicit system notices translate upstream messages without inventing optional fields', () => {
  const detailOnly = renderToStaticMarkup(<InlineNotice tone="error" detail="Не удалось загрузить описание модели" />)
  assert.match(detailOnly, /Could not load the model description\./)
  assert.doesNotMatch(detailOnly, /<strong>|Request failed/)
  const upstream = renderToStaticMarkup(<InlineNotice tone="success" system title="Нет связи" />)
  assert.match(upstream, /Connection lost\./)
  const content = renderToStaticMarkup(<InlineNotice tone="error" system={false} title="Имя пользовательской доски" />)
  assert.match(content, /Имя пользовательской доски/)
})

test('общий price badge форматирует сумму с нужной точностью', () => {
  const prompt = renderToStaticMarkup(<PriceBadge amount={1.2} precision={2} />)
  const chat = renderToStaticMarkup(<PriceBadge amount={0.01234} precision={3} />)
  const action = renderToStaticMarkup(<PriceBadge amount={0.01234} precision={3} variant="action" />)
  const pendingAction = renderToStaticMarkup(<PriceBadge amount={null} precision={3} variant="action" />)

  assert.match(prompt, /class="price-badge"/)
  assert.match(prompt, /≈ \$1\.20/)
  assert.match(chat, /class="price-badge"/)
  assert.match(chat, /≈ \$0\.012/)
  assert.match(action, /class="price-badge is-action"/)
  assert.match(action, />\$0\.012</)
  assert.doesNotMatch(action, /≈|badge-icon/)
  assert.match(pendingAction, /class="price-badge is-action is-pending"/)
  assert.match(pendingAction, />\$…</)
  assert.match(pendingAction, /Calculating price/)
})

test('price badge помечает fal-metered как верхний предел', () => {
  const metered = renderToStaticMarkup(
    <PriceBadge amount={2} pricingMode="fal-metered" variant="action" title="Maximum generation reserve" />,
  )
  assert.match(metered, /up to \$2\.00/u)
  assert.match(metered, /Maximum generation reserve/u)
})

test('price badge показывает uncapped fal-metered как оценку', () => {
  const estimate = renderToStaticMarkup(
    <PriceBadge amount={2} pricingMode="fal-metered" meteredUncapped variant="action" />,
  )
  assert.match(estimate, /≈ \$2\.00/u)
  assert.doesNotMatch(estimate, /up to/u)
})

test('price badge переводит известный системный заголовок и сохраняет пояснение', () => {
  const store = createLanguageStore({ getItem: () => null, setItem: () => {} })
  store.set('ru')
  const html = renderToStaticMarkup(
    <LanguageProvider store={store}>
      <PriceBadge
        amount={0.28}
        variant="action"
        title="Estimated generation price. Оплата по фактическому расходу fal."
      />
    </LanguageProvider>,
  )
  assert.match(html, /Приблизительная цена генерации\. Оплата по фактическому расходу fal\./u)
  assert.match(html, /\$0\.28/u)
})

test('окно чата использует тот же notice-контракт для загрузки, памяти и ошибок', () => {
  const source = readFileSync(new URL('../spaces/canvas/AssistantShelf.tsx', import.meta.url), 'utf8')
  assert.ok((source.match(/<InlineNotice/g) ?? []).length >= 4)
  assert.doesNotMatch(source, /prompt-chat-(?:error|memory-warning|local-error)/)
})

test('InlineNotice подключает явный autoDismiss и PromptBar помечает только временный info', () => {
  const inlineSource = readFileSync(new URL('./InlineNotice.tsx', import.meta.url), 'utf8')
  // стопка плашек живёт в PromptNotices — там же и правило «таймер только у
  // временного info, у ошибки крестик»
  const promptSource = readFileSync(
    new URL('../spaces/canvas/PromptNotices.tsx', import.meta.url),
    'utf8',
  )

  assert.match(inlineSource, /autoDismissMs\?: number/)
  assert.match(inlineSource, /scheduleAutoDismiss/)
  assert.match(promptSource, /tone="info"[\s\S]*autoDismissMs=\{AUTO_DISMISS_MS\}/)
  assert.match(promptSource, /tone="error"[\s\S]*onDismiss=\{onDismissLocalError\}/)
})

test('глобальные уведомления используют общую policy и очищают таймеры', () => {
  const source = readFileSync(new URL('./GlobalNotifications.tsx', import.meta.url), 'utf8')
  // Третий аргумент не косметика: без него сообщение с кнопкой «Отменить»
  // гасло бы через две секунды — раньше, чем её успевают нажать. Требуем его
  // во ВСЕХ вызовах: сторож, закреплявший форму без него, однажды защищал бы
  // как раз ошибку (так уже вышло с materializeModelParams).
  const calls = source.match(/autoDismissDelay\([^)]*\)\)?/g) ?? []
  assert.ok(calls.length > 0, 'вызовы autoDismissDelay должны быть')
  for (const call of calls) {
    assert.match(call, /toast\.kind,\s*AUTO_DISMISS_MS,\s*Boolean\(toast\.action\)/, call)
  }
  assert.match(source, /timersRef\.current/)
  assert.match(source, /window\.clearTimeout/)
  assert.doesNotMatch(source, /window\.setTimeout\([^)]*5000/)
})
