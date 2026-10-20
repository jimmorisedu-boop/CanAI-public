import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelImport, getImports, startImport } from './importQueue'

test('cancelling an import aborts work and removes its visible task', async () => {
  const file = new File(['data'], 'photo.png', { type: 'image/png' })
  let aborted = false
  const running = startImport(file, (signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('cancelled', 'AbortError'))
    })
  }))
  const id = getImports()[0].id
  cancelImport(id)
  await running.catch(() => {})
  assert.equal(aborted, true)
  assert.deepEqual(getImports(), [])
})
