import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphDiagnosticsPanel } from './GraphDiagnosticsPanel.js'
import { GraphValidationStatus } from './GraphValidationStatus.js'

test('корректная структура рендерится статусом, а не пустой кнопкой', () => {
  const html = renderToStaticMarkup(
    <GraphValidationStatus
      summary={{
        errors: 0,
        warnings: 0,
        structurallyValid: true,
        label: 'Корректно',
      }}
      diagnosticsOpen={false}
      onToggle={() => {}}
    />,
  )

  assert.match(html, /role="status"/)
  assert.doesNotMatch(html, /<button/)
})

test('output_missing без nodeId рендерится текстом без ложного действия', () => {
  const html = renderToStaticMarkup(
    <GraphDiagnosticsPanel
      diagnostics={[
        {
          code: 'output_missing',
          severity: 'error',
          message: 'Добавь ноду «Выход»',
        },
      ]}
      onFocus={() => {
        throw new Error('у текста нет действия')
      }}
    />,
  )

  assert.match(html, /role="status"/)
  assert.doesNotMatch(html, /<button/)
})
