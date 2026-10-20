import assert from 'node:assert/strict'
import test from 'node:test'
import { GITLEAKS_ASSETS, GITLEAKS_VERSION, assetForPlatform, resolveGitleaksBinary } from './install-gitleaks.mjs'

test('gitleaks installer pins official v8.30.1 assets and checksums', () => {
  assert.equal(GITLEAKS_VERSION, '8.30.1')
  assert.equal(assetForPlatform('win32', 'x64').sha256, 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e')
  assert.equal(assetForPlatform('linux', 'x64').sha256, '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb')
  assert.equal(assetForPlatform('darwin', 'arm64').sha256, 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5')
  assert.throws(() => assetForPlatform('freebsd', 'x64'), /no pinned asset/u)
  assert.deepEqual(Object.keys(GITLEAKS_ASSETS).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64'])
})

test('installer resolves a local binary and never relies on PATH', () => {
  assert.match(resolveGitleaksBinary('tools', 'win32', 'x64'), /tools[\\/]gitleaks\.exe$/u)
  assert.match(resolveGitleaksBinary('tools', 'linux', 'x64'), /tools[\\/]gitleaks$/u)
})
