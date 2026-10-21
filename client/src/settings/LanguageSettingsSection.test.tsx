import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LanguageProvider } from '../i18n/context.js'
import { createLanguageStore } from '../i18n/language.js'
import { LanguageSettingsSection } from './LanguageSettingsSection.js'

test('language settings render both device choices in SSR', () => {
  const html = renderToStaticMarkup(
    <LanguageProvider store={createLanguageStore(null)}>
      <LanguageSettingsSection />
    </LanguageProvider>,
  )
  assert.match(html, /Language/u)
  assert.match(html, /value="en"/u)
  assert.match(html, /English/u)
  assert.match(html, /value="ru"/u)
  assert.match(html, /Русский/u)
})

test('language settings render the persisted Russian selection and translated labels in SSR', () => {
  const store = createLanguageStore({
    getItem: () => 'ru',
    setItem: () => {},
  })
  const html = renderToStaticMarkup(
    <LanguageProvider store={store}>
      <LanguageSettingsSection />
    </LanguageProvider>,
  )
  assert.match(html, /<h3[^>]*>Язык<\/h3>/u)
  assert.match(html, /checked=""[^>]*value="ru"/u)
  assert.doesNotMatch(html, /checked=""[^>]*value="en"/u)
})
