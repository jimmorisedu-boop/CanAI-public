import assert from 'node:assert/strict'
import test from 'node:test'
import { observePortalTarget } from './usePortalTarget'

test('portal follows a late host, responsive replacement and removal without duplicate updates', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  let host: HTMLElement | null = null
  let changed = () => {}
  let disconnected = false
  const seen: Array<HTMLElement | null> = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: {}, getElementById: () => host,
  } })
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
    constructor(callback: () => void) { changed = callback }
    observe() {}
    disconnect() { disconnected = true }
  } })
  try {
    const stop = observePortalTarget('participants', (target) => seen.push(target))
    assert.deepEqual(seen, [null])
    const wide = {} as HTMLElement
    const compact = {} as HTMLElement
    host = wide
    changed()
    changed()
    assert.deepEqual(seen, [null, wide])
    host = compact
    changed()
    assert.equal(seen[2], compact)
    host = null
    changed()
    assert.deepEqual(seen, [null, wide, compact, null])
    stop()
    assert.equal(disconnected, true)
  } finally {
    for (const [name, descriptor] of [['document', previousDocument], ['MutationObserver', previousObserver]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
