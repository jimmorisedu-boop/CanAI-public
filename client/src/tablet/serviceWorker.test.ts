import assert from 'node:assert/strict'
import test from 'node:test'
import { tabletCachePolicy } from './serviceWorker.js'

test('service worker никогда не кэширует приватные API и медиа', () => {
  for (const path of ['/v3/me', '/v3/projects/p1', '/api/models', '/media/private.png']) {
    assert.equal(tabletCachePolicy(new URL(`https://canai.test${path}`), false), 'network-only')
  }
})

test('service worker кэширует только app shell внутри /tablet', () => {
  assert.equal(
    tabletCachePolicy(new URL('https://canai.test/tablet/assets/tablet-ABC.js'), false),
    'cache-first',
  )
  assert.equal(
    tabletCachePolicy(new URL('https://canai.test/tablet/project/p1'), true),
    'shell-navigation',
  )
  assert.equal(
    tabletCachePolicy(new URL('https://canai.test/admin'), true),
    'network-only',
  )
})
