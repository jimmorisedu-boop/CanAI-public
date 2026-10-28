import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopUpdateStatus } from '../../../packages/desktop-updates/protocol'
import { translateForLocale, type TranslationParams } from '../i18n/translate'
import {
  DesktopUpdateSection,
  desktopUpdateErrorMessage,
  runDesktopUpdateBeforeRestart,
} from './DesktopUpdateSection'
import type { DesktopUpdateController } from './desktopUpdateController'

function fakeController(status: DesktopUpdateStatus): DesktopUpdateController {
  return {
    getSnapshot: () => status,
    subscribe: () => () => {},
    load: async () => status,
    check: async () => status,
    prepare: async () => status,
    apply: async () => status,
    cancel: () => {},
  }
}

function render(status: DesktopUpdateStatus): string {
  return renderToStaticMarkup(<DesktopUpdateSection controller={fakeController(status)} />)
}

test('SSR exposes the current version, release notes and one update action', () => {
  const html = render({
    phase: 'available', edition: 'full', current: { version: '1.0.0', commit: null, date: null },
    latest: { version: '1.1.0', commit: null, date: null, notes: ['Faster startup'], target: '1.1.0' },
  })
  assert.match(html, /App updates/)
  assert.match(html, /Current version: 1\.0\.0/)
  assert.match(html, /New version 1\.1\.0/)
  assert.match(html, /Faster startup/)
  assert.match(html, />Update<\/button>/)
})

test('unsupported status remains honest and does not offer an update button', () => {
  const html = render({
    phase: 'unsupported', edition: 'local', current: { version: '1.0.0', commit: null, date: null },
  })
  assert.match(html, /Updates are not supported on this platform\./)
  assert.doesNotMatch(html, /<button[^>]*>Update/)
})

test('error status uses an alert notice with a retry action', () => {
  const html = render({
    phase: 'error', edition: 'full', current: { version: '1.0.0', commit: null, date: null },
    message: 'Could not reach release feed', code: 'NETWORK',
  })
  assert.match(html, /role="alert"/)
  assert.match(html, /Try again/)
  assert.match(html, /The update could not be completed\./)
})

test('known update failures are concise, translated, and shown once', () => {
  const raw = 'Release has no trusted update-manifest.json asset'
  const html = render({
    phase: 'error', edition: 'local', current: { version: '1.0.0', commit: null, date: null },
    message: raw, code: 'no-release',
  })
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1)
  assert.equal((html.match(/The update could not be completed\./g) ?? []).length, 1)
  assert.match(html, /No trusted release is available yet\. Check again later\./)
  assert.doesNotMatch(html, /Release has no trusted update-manifest\.json asset/)
})

test('update failure mapping covers recovery actions and Russian output', () => {
  const identity = (message: string) => message
  const cases: Array<[string, string]> = [
    ['no-release', 'No trusted release is available yet. Check again later.'],
    ['dirty-tree', 'Save your local changes, then try again.'],
    ['wrong-origin', 'Use the CanAI source for this copy, then try again.'],
    ['wrong-branch', 'Switch to the CanAI main branch, then try again.'],
    ['checksum-mismatch', 'The downloaded release could not be verified. Try again later.'],
    ['update-interrupted', 'The update was interrupted. Try again from Settings; recovery data was kept.'],
    ['rollback-failed', 'The update failed and automatic recovery did not finish. Keep this copy and contact support.'],
  ]
  for (const [code, expected] of cases) {
    assert.equal(desktopUpdateErrorMessage({ code, message: 'raw technical detail' }, identity), expected)
  }
  const ru = (message: string, params?: TranslationParams) => translateForLocale('ru', message, params)
  assert.equal(
    desktopUpdateErrorMessage({ code: 'no-release', message: 'raw technical detail' }, ru),
    'Проверенного выпуска пока нет. Проверьте ещё раз позже.',
  )
  assert.equal(
    desktopUpdateErrorMessage({ code: 'unknown-code', message: 'Server said unavailable' }, identity),
    'Server said unavailable',
  )
})

test('before-restart refusal and failure stay before apply', async () => {
  assert.deepEqual(
    await runDesktopUpdateBeforeRestart(async () => ({ ok: false, message: 'Save or clear the new API key before updating.' })),
    { ok: false, message: 'Save or clear the new API key before updating.' },
  )
  assert.deepEqual(
    await runDesktopUpdateBeforeRestart(async () => { throw new Error('settings write failed') }),
    { ok: false, message: 'settings write failed' },
  )
})
