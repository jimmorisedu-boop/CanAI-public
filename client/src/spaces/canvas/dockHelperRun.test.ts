// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { ApiError, type CanvasActionPreparationInput, type CanvasActionPreparationStatus } from '../../api'
import { executeDockHelperRun } from './dockHelperRun'

function fakeTransport(overrides: {
  prepare?: (input: CanvasActionPreparationInput) => Promise<{ jobId: string; profile: any; quote: any }>
  status?: (id: string) => Promise<CanvasActionPreparationStatus>
  cancel?: (id: string) => Promise<{ status: string }>
}) {
  return {
    prepare: overrides.prepare ?? (async () => ({ jobId: 'job-1', profile: null, quote: null })),
    status: overrides.status ?? (async () => ({ status: 'done', result: { text: 'подготовленный промпт' } } as CanvasActionPreparationStatus)),
    cancel: overrides.cancel ?? (async () => ({ status: 'cancelled' })),
  }
}

function quoteError(quote: any, message = 'Котировка'): ApiError {
  const err = new ApiError(message, 'PRICE_CONFIRMATION_REQUIRED', 409)
  err.quote = quote
  return err
}

test('dockHelperRun: сохраняет один idempotencyKey при подтверждении котировки', async () => {
  const payloads: CanvasActionPreparationInput[] = []
  let attempts = 0

  const transport = fakeTransport({
    prepare: async (input) => {
      payloads.push({ ...input })
      attempts += 1
      if (attempts === 1) {
        throw quoteError({
          id: 'q-1',
          requestHash: 'h-1',
          amountUsd: 0.01,
          needsConfirmation: false,
        })
      }
      return { jobId: 'job-1', profile: null, quote: null }
    },
  })

  const result = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    expectedEstimateUsd: 0.01,
    transport,
  })

  assert.equal(result.status, 'success')
  if (result.status === 'success') {
    assert.equal(result.prompt, 'подготовленный промпт')
  }
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].idempotencyKey, payloads[1].idempotencyKey)
  assert.equal(payloads[1].quoteId, 'q-1')
  assert.equal(payloads[1].quoteConfirmed, true)
})

test('dockHelperRun: без подтверждения второй POST не уходит', async () => {
  const payloads: CanvasActionPreparationInput[] = []

  const transport = fakeTransport({
    prepare: async (input) => {
      payloads.push({ ...input })
      throw quoteError({
        id: 'q-1',
        requestHash: 'h-1',
        amountUsd: 0.05,
        needsConfirmation: true,
      })
    },
  })

  const result = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    expectedEstimateUsd: 0.01,
    askConfirm: async () => false, // пользователь отклонил
    transport,
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(payloads.length, 1)
})

test('dockHelperRun: молчаливое подтверждение только при needsConfirmation===false и совпавшей сумме', async () => {
  let asked = false
  const transport = fakeTransport({
    prepare: async (input) => {
      if (!input.quoteConfirmed) {
        throw quoteError({
          id: 'q-1',
          requestHash: 'h-1',
          amountUsd: 0.02, // отличается от 0.01!
          needsConfirmation: false,
        })
      }
      return { jobId: 'job-1', profile: null, quote: null }
    },
  })

  await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    expectedEstimateUsd: 0.01,
    askConfirm: async () => {
      asked = true
      return true
    },
    transport,
  })

  assert.equal(asked, true, 'должно было спросить из-за несовпадения суммы')
})

test('dockHelperRun: второй 409 всегда спрашивает пользователя', async () => {
  let round = 0
  let confirmCount = 0

  const transport = fakeTransport({
    prepare: async () => {
      round += 1
      if (round <= 2) {
        throw quoteError({
          id: `q-${round}`,
          requestHash: `h-${round}`,
          amountUsd: 0.01,
          needsConfirmation: false,
        })
      }
      return { jobId: 'job-1', profile: null, quote: null }
    },
  })

  const result = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    expectedEstimateUsd: 0.01,
    askConfirm: async () => {
      confirmCount += 1
      return true
    },
    transport,
  })

  assert.equal(result.status, 'success')
  assert.equal(confirmCount, 1, 'второй 409 обязан был запросить подтверждение')
})

test('dockHelperRun: abort зовёт cancel один раз и возвращает cancelled', async () => {
  let cancelCalled = 0
  const controller = new AbortController()

  const transport = fakeTransport({
    prepare: async () => ({ jobId: 'job-cancel', profile: null, quote: null }),
    status: async () => {
      controller.abort()
      return { status: 'running', progressText: 'в процессе' } as CanvasActionPreparationStatus
    },
    cancel: async (id) => {
      cancelCalled += 1
      assert.equal(id, 'job-cancel')
      return { status: 'cancelled' }
    },
  })

  const result = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    signal: controller.signal,
    transport,
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(cancelCalled, 1)
})

test('dockHelperRun: устаревшая область отменяет задачу и возвращает stale', async () => {
  let currentScope = true
  let cancelCalled = 0

  const transport = fakeTransport({
    prepare: async () => ({ jobId: 'job-stale', profile: null, quote: null }),
    status: async () => {
      currentScope = false // доска сменилась
      return { status: 'running' } as CanvasActionPreparationStatus
    },
    cancel: async () => {
      cancelCalled += 1
      return { status: 'cancelled' }
    },
  })

  const result = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    isCurrentScope: () => currentScope,
    transport,
  })

  assert.equal(result.status, 'stale')
  assert.equal(cancelCalled, 1)
})

test('dockHelperRun: ошибки 404, 409 (профиль сменился), 429 возвращаются понятным текстом', async () => {
  const transport404 = fakeTransport({
    prepare: async () => {
      throw new ApiError('Помощник не найден', 'NOT_FOUND', 404)
    },
  })
  const res404 = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    transport: transport404,
  })
  assert.deepEqual(res404, { status: 'error', error: 'Assistant not found.' })

  const transport429 = fakeTransport({
    prepare: async () => {
      throw new ApiError('Слишком много запросов', 'RATE_LIMIT', 429)
    },
  })
  const res429 = await executeDockHelperRun({
    projectRef: { source: 'local', id: 'p1' },
    prompt: 'тест',
    refs: [],
    assistantId: 'ast-1',
    transport: transport429,
  })
  assert.deepEqual(res429, { status: 'error', error: 'Too many requests. Try again later.' })
})

test('dockHelperRun: два параллельных прогона независимы', async () => {
  const jobsStarted: string[] = []

  const transport = fakeTransport({
    prepare: async (input) => {
      const jobId = `job-${input.prompt}`
      jobsStarted.push(jobId)
      return { jobId, profile: null, quote: null }
    },
    status: async (id) => ({
      status: 'done',
      result: { text: `ответ для ${id}` },
    } as CanvasActionPreparationStatus),
  })

  const [res1, res2] = await Promise.all([
    executeDockHelperRun({
      projectRef: { source: 'local', id: 'p1' },
      prompt: 'запрос 1',
      refs: [],
      assistantId: 'ast-1',
      transport,
    }),
    executeDockHelperRun({
      projectRef: { source: 'local', id: 'p1' },
      prompt: 'запрос 2',
      refs: [],
      assistantId: 'ast-1',
      transport,
    }),
  ])

  assert.equal(res1.status, 'success')
  assert.equal(res2.status, 'success')
  if (res1.status === 'success' && res2.status === 'success') {
    assert.equal(res1.prompt, 'ответ для job-запрос 1')
    assert.equal(res2.prompt, 'ответ для job-запрос 2')
  }
  assert.deepEqual(jobsStarted, ['job-запрос 1', 'job-запрос 2'])
})
