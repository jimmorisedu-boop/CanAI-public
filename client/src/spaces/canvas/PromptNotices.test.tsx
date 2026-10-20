import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptNotices } from './PromptNotices'

function render(patch: Partial<React.ComponentProps<typeof PromptNotices>> = {}): string {
  return renderToStaticMarkup(
    <PromptNotices
      projectSource="local"
      serverStatus={null}
      serverStatusReady={false}
      catalogEmpty
      catalogError
      onRetryCatalog={() => {}}
      replacementNumber={undefined}
      onCancelReplacement={() => {}}
      localError={null}
      onDismissLocalError={() => {}}
      editorNotice={null}
      onDismissEditorNotice={() => {}}
      {...patch}
    />,
  )
}

test('не показывает offline и пустой каталог до первого подтверждённого статуса', () => {
  const html = render()
  assert.doesNotMatch(html, /Server unavailable|The model catalog did not load/)
})

test('после grace window честно показывает подтверждённый offline', () => {
  const html = render({ serverStatusReady: true })
  assert.match(html, /Server unavailable/)
  assert.match(html, /The model catalog did not load/)
})
