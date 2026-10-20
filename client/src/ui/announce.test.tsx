import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { announce, getAnnouncement, resetAnnouncements } from './announce'
import { LiveRegion } from './LiveRegion'

test('ordinary progress is polite and actionable errors are assertive', () => {
  resetAnnouncements()
  announce('Готов 1 из 4')
  assert.equal(getAnnouncement().priority, 'polite')

  announce('Один вариант с ошибкой', 'assertive')
  assert.equal(getAnnouncement().priority, 'assertive')
})

test('live region keeps separate stable channels for polite and assertive messages', () => {
  resetAnnouncements()
  announce('Ошибка варианта', 'assertive')
  const html = renderToStaticMarkup(<LiveRegion />)

  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(html, /role="alert" aria-live="assertive"/)
  assert.match(html, /Ошибка варианта/)
})
