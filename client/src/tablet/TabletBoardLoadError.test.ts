import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTabletBoardLoadError } from './TabletBoard'

test('tablet board load classifies plain English authentication failures', () => {
  for (const message of [
    'Sign-in required',
    'Login required',
    'Session expired',
    'Access revoked',
    'No permission to open this board',
  ]) {
    assert.equal(classifyTabletBoardLoadError(new Error(message)).kind, 'auth', message)
  }
})

test('tablet board load classifies plain English network failures and keeps validation generic', () => {
  for (const message of ['Board unavailable', 'Connection lost', 'Request timed out']) {
    assert.equal(classifyTabletBoardLoadError(new Error(message)).kind, 'network', message)
  }

  assert.equal(classifyTabletBoardLoadError(new Error('требуется вход')).kind, 'auth')
  assert.equal(classifyTabletBoardLoadError(new Error('Invalid board identifier')).kind, 'unknown')
})
