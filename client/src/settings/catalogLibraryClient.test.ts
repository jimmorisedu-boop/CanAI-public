import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CatalogConflictError,
  catalogLibraryClient,
  type CatalogRequest,
} from './catalogLibraryClient.js'
import type { DraftTariffInput, DraftTestInput } from '../types.js'

test('409 preserves the submitted tariff draft for a refreshed retry', async () => {
  const form: DraftTariffInput = {
    pricing: { unit: 'image', usd: 0.12 },
    tariffSourceUrl: 'https://fal.ai/models/vendor/demo',
  }
  const request: CatalogRequest = async () => {
    throw Object.assign(new Error('Каталог изменён'), { status: 409 })
  }
  await assert.rejects(
    catalogLibraryClient.updateDraftTariff(request, 'user-demo', form, 3),
    (error: unknown) => error instanceof CatalogConflictError && error.submitted === form,
  )
})

test('paid test start sends one stable idempotency key', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const request: CatalogRequest = async <T>(url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return { jobId: 'job-1', status: 'queued' } as T
  }
  const input: DraftTestInput = { prompt: 'тест', refs: [], params: {} }
  await catalogLibraryClient.startTest(request, 'user-demo', input, 'wizard-attempt-1')

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, '/api/catalog/drafts/user-demo/tests')
  assert.equal(calls[0]?.body.idempotencyKey, 'wizard-attempt-1')
})

test('setup prepares the draft without starting a paid test', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const request: CatalogRequest = async <T>(url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return { library: {}, input: { prompt: 'test', refs: [], params: {} }, pricing: null, samples: [], warnings: [] } as T
  }
  await catalogLibraryClient.setup(request, 'user-demo', 7)

  assert.deepEqual(calls, [{
    url: '/api/catalog/drafts/user-demo/setup',
    body: { revision: 7 },
  }])
})
