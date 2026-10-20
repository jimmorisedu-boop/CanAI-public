import assert from 'node:assert/strict'
import test from 'node:test'
import { api, ApiError } from './api.js'

test('local generate propagates quote confirmation without an interactive retry', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  const requests: unknown[] = []
  const quote = {
    id: 'quote-metered',
    requestHash: 'hash-metered',
    amountMicro: 2_000_000,
    amountUsd: 2,
    quantity: 1,
    expiresAt: Date.now() + 60_000,
    needsConfirmation: true,
    pricingMode: 'fal-metered',
    guaranteed: true,
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout, clearTimeout },
  })
  globalThis.fetch = async (_input, init) => {
    requests.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
    return Response.json({
      error: 'Подтвердите котировку', code: 'PRICE_CONFIRMATION_REQUIRED', quote,
      idempotencyKey: 'idem-metered',
    }, { status: 409 })
  }

  try {
    const target = {
      kind: 'canvas' as const,
      projectRef: { source: 'local' as const, id: 'project-metered' },
      placeholderId: 'slot-metered',
    }
    await assert.rejects(
      api.generate('image', 'свет', [], 'flare', undefined, target),
      (error: unknown) => error instanceof ApiError && error.code === 'PRICE_CONFIRMATION_REQUIRED',
    )
    assert.equal(requests.length, 1, 'local submit does not retry a paid request after a quote response')
    assert.deepEqual((requests[0] as Record<string, unknown>).target, target)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})
