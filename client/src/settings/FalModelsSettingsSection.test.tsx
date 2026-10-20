import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('fal key belongs to the combined generation section and saving it does not close settings', () => {
  const modal = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')
  const section = readFileSync(new URL('./FalModelsSettingsSection.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(modal, /id="fal-key"/)
  assert.equal((section.match(/id="fal-key"/g) ?? []).length, 1)
  const saveBody = modal.match(/async function saveFalConnection[\s\S]*?\n  }/)?.[0] ?? ''
  assert.ok(saveBody)
  assert.doesNotMatch(saveBody, /onClose/)
})

test('opening the model wizard hides the surrounding key and default panels', () => {
  const section = readFileSync(new URL('./FalModelsSettingsSection.tsx', import.meta.url), 'utf8')
  assert.match(section, /!wizardOpen && <section className="settings-section fal-models-connection"/)
  assert.match(section, /!wizardOpen && library && <ModelDefaultsCard/)
  assert.match(section, /wizardOpen && !falKeySet/)
  assert.match(section, /Close wizard/)
})
