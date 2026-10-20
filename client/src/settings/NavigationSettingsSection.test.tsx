import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NavigationSettingsSection } from './NavigationSettingsSection.js'

test('настройка навигации — явный доступный выбор мыши или тачпада', () => {
  const html = renderToStaticMarkup(
    <NavigationSettingsSection mode="touchpad" disabled={false} onChange={() => {}} />,
  )

  assert.match(html, /<fieldset/)
  assert.match(html, /Navigation/)
  assert.match(html, /type="radio"[^>]*value="mouse"/)
  assert.match(html, /type="radio"[^>]*checked=""[^>]*value="touchpad"/)
  assert.match(html, /Two fingers pan the canvas; pinch to zoom/)
})
