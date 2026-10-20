import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LifecycleManager, type RuntimeControlDocument } from './lifecycle.js'

async function makeTempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

test('publish атомарно создаёт уникальный control-файл', async (t) => {
  const dir = await makeTempDir(t, 'canai-lifecycle-')
  const file = path.join(dir, 'runtime-control.json')
  const first = new LifecycleManager(file, 8791, 111)
  const second = new LifecycleManager(file, 8791, 222)

  await first.publish()

  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as RuntimeControlDocument
  assert.equal(saved.version, 1)
  assert.equal(saved.port, 8791)
  assert.equal(saved.pid, 111)
  assert.equal(saved.instanceId, first.instanceId)
  assert.ok(saved.shutdownToken.length >= 32)
  assert.notEqual(first.instanceId, second.instanceId)
})

test('authorize принимает только полный совпадающий токен', () => {
  const manager = new LifecycleManager('unused', 8791, 111)

  assert.equal(manager.authorize(undefined), false)
  assert.equal(manager.authorize(''), false)
  assert.equal(manager.authorize(`${manager.shutdownToken}x`), false)
  assert.equal(manager.authorize(manager.shutdownToken), true)
})

test('beginShutdown запускает обработчик только один раз', async () => {
  const manager = new LifecycleManager('unused', 8791, 111)
  let calls = 0
  let release: (() => void) | undefined
  const handled = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = async () => {
    calls += 1
    release?.()
  }

  assert.equal(manager.beginShutdown(handler), 'accepted')
  assert.equal(manager.beginShutdown(handler), 'already-started')
  assert.equal(manager.shuttingDown, true)
  await handled
  assert.equal(calls, 1)
})

test('старый экземпляр не удаляет control-файл нового', async (t) => {
  const dir = await makeTempDir(t, 'canai-lifecycle-owner-')
  const file = path.join(dir, 'runtime-control.json')
  const oldInstance = new LifecycleManager(file, 8791, 111)
  const currentInstance = new LifecycleManager(file, 8791, 222)
  await oldInstance.publish()
  await currentInstance.publish()

  await oldInstance.removeControlIfOwned()

  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as RuntimeControlDocument
  assert.equal(saved.instanceId, currentInstance.instanceId)
})
