import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectVersion } from '../api'
import { VersionsList } from './VersionsModal'

const versions: ProjectVersion[] = [
  { id: 'first', createdAt: Date.UTC(2026, 7, 14, 1, 33, 32), items: 3, preview: '/media/preview.png' },
  { id: 'second', createdAt: Date.UTC(2026, 7, 13, 20, 5, 19), items: 0 },
]

test('список версий разделяет дату, время, состав и короткое действие', () => {
  const html = renderToStaticMarkup(
    <VersionsList versions={versions} busyId={null} onRestore={() => {}} />,
  )

  assert.equal((html.match(/class="version-row"/g) ?? []).length, 2)
  assert.match(html, /class="version-date"/)
  assert.match(html, /class="version-time"/)
  assert.match(html, /3 objects/)
  assert.match(html, /Empty board/)
  assert.match(html, /> Restore<\/button>/)
  assert.doesNotMatch(html, /Restore as a copy/)
})

test('во время восстановления все действия выключены, а выбранное показывает прогресс', () => {
  const html = renderToStaticMarkup(
    <VersionsList versions={versions} busyId="first" onRestore={() => {}} />,
  )

  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
  assert.match(html, /Restoring…/)
})
