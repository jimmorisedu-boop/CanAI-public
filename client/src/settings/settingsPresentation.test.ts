// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import test from 'node:test'
import './navigationMode.test.js'
import './NavigationSettingsSection.test.js'
import {
  editorDisplayName,
  falConnectionPresentation,
} from './settingsPresentation.js'

test('путь к редактору превращается в понятное имя программы', () => {
  assert.equal(editorDisplayName(''), 'No program selected')
  assert.equal(
    editorDisplayName(String.raw`C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe`),
    'Photoshop',
  )
  assert.equal(
    editorDisplayName('/Applications/Pixelmator Pro.app'),
    'Pixelmator Pro',
  )
})

test('подключение fal.ai имеет явные пользовательские состояния', () => {
  assert.deepEqual(falConnectionPresentation('loading'), {
    label: 'Checking settings…',
    tone: 'neutral',
  })
  assert.deepEqual(falConnectionPresentation('disconnected'), {
    label: 'Not connected',
    tone: 'neutral',
  })
  assert.deepEqual(falConnectionPresentation('connected'), {
    label: 'Connected',
    tone: 'success',
  })
  assert.deepEqual(falConnectionPresentation('unverified'), {
    label: 'Key saved, but the connection could not be checked',
    tone: 'warning',
  })
})
