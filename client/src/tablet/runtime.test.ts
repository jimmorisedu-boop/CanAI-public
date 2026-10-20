import assert from 'node:assert/strict'
import test from 'node:test'
import { tabletMediaUploader, buildTabletRuntimeKind, type TabletRuntime } from './runtime.js'
import { LanTabletRuntime } from './lanRuntime.js'

test('tablet runtime is the local Host runtime by default', () => {
  assert.equal(buildTabletRuntimeKind(), 'lan')
})

test('LAN runtime exposes the Host capabilities for preparation and agents', () => {
  const runtime = new LanTabletRuntime()
  assert.deepEqual(runtime.capabilities?.preparation, { available: true, transport: 'local-api' })
  assert.equal(runtime.capabilities?.agents.mode, 'control')
  assert.equal(runtime.capabilities?.agents.canLaunch, true)
  assert.equal(runtime.capabilities?.agents.canControl, true)
  assert.equal(runtime.capabilities?.agents.client != null, true)
})

test('tablet uploader adapts a local media response to the crop and sketch contract', async () => {
  const runtime = {
    kind: 'lan',
    uploadAsset: async () => ({ assetId: 'asset-new', src: '/media/asset-new', mime: 'image/png' }),
  } as unknown as TabletRuntime
  const upload = tabletMediaUploader(runtime, 'project-1')

  assert.deepEqual(await upload(new File(['x'], 'crop.png', { type: 'image/png' })), {
    assetId: 'asset-new', url: '/media/asset-new', mime: 'image/png',
  })
})

test('tablet uploader reports unavailable local upload capability', async () => {
  const runtime = { kind: 'lan' } as unknown as TabletRuntime
  await assert.rejects(
    tabletMediaUploader(runtime, 'project-1')(new File(['x'], 'crop.png', { type: 'image/png' })),
    /File uploads are unavailable on this device/u,
  )
})
