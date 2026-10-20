import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationTask } from './generationRegistry'
import { approvePreparedGenerationQuotes } from './useGeneration'
import { registerConfirmHost } from '../../ui/confirmBus'
import {
  buildLaunchVariants,
  createGenerationTarget,
  createGenerationLaunch,
  groupGenerationTasks,
  launchGenerationVariants,
  type GenerationLaunchMeta,
} from './generationLaunches'

const TARGET = { kind: 'canvas' as const, projectId: 'project-1' }

test('неудавшийся запуск сохраняет local id и ошибку одной мутацией', async () => {
  const calls: unknown[] = []
  await launchGenerationVariants({
    slots: ['slot'], launch: launch('atomic', 1, 1, 1),
    start: async () => { throw new Error('Сбой запуска') },
    recordFailure: () => 'local:failed',
    bindJob: () => assert.fail('Промежуточный local loading запрещён'),
    failSlot: () => assert.fail('Ошибка должна попасть в ту же мутацию'),
    failLaunch: (...args) => { calls.push(args) },
    fallbackError: 'Ошибка',
  })
  assert.deepEqual(calls, [['slot', 'local:failed', 'Сбой запуска']])
})

function launch(
  launchId: string,
  variantIndex: number,
  variantCount: number,
  createdAt: number,
): GenerationLaunchMeta {
  return {
    launchId,
    variantIndex,
    variantCount,
    projectId: TARGET.projectId,
    projectName: 'Доска',
    promptPreview: 'Нарисуй маяк',
    modelId: 'image-model',
    modelName: 'Модель',
    estimatedTotalCostUsd: 0.08,
    createdAt,
  }
}

function task(
  jobId: string,
  state: GenerationTask['state'],
  taskLaunch: GenerationLaunchMeta | undefined,
  createdAt: number,
  retryable = false,
): GenerationTask {
  return {
    jobId,
    jobKind: 'image',
    target: TARGET,
    state,
    launch: taskLaunch,
    retry: retryable ? { kind: 'image', prompt: 'Нарисуй маяк', refs: [] } : undefined,
    createdAt,
  }
}

test('не объединяет варианты разных запусков', () => {
  const groups = groupGenerationTasks([
    task('job-a', 'running', launch('launch-a', 1, 2, 100), 101),
    task('job-b', 'queued', launch('launch-b', 1, 2, 200), 201),
    task('job-c', 'done', launch('launch-a', 2, 2, 100), 102),
  ])

  assert.deepEqual(groups.map((group) => group.launchId), ['launch-b', 'launch-a'])
  assert.deepEqual(groups[1].variants.map((variant) => variant.jobId), ['job-a', 'job-c'])
})

test('показывает старую задачу без launch как отдельную группу', () => {
  const [group] = groupGenerationTasks([
    task('legacy-job', 'done', undefined, 300),
  ])

  assert.equal(group.launchId, 'legacy:legacy-job')
  assert.equal(group.launch, undefined)
  assert.equal(group.variantCount, 1)
  assert.deepEqual(group.variants.map((variant) => variant.jobId), ['legacy-job'])
  assert.equal(group.status, 'done')
})

test('оставляет в варианте только последнюю попытку повтора', () => {
  const [group] = groupGenerationTasks([
    task('old-attempt', 'error', launch('launch-a', 1, 2, 100), 101),
    // Две попытки могут получить один Date.now(); более поздняя запись всё равно
    // должна заменить прежнюю в том же варианте.
    task('new-attempt', 'running', launch('launch-a', 1, 2, 100), 101),
    task('second-variant', 'done', launch('launch-a', 2, 2, 100), 102),
  ])

  assert.deepEqual(
    group.variants.map((variant) => variant.jobId),
    ['new-attempt', 'second-variant'],
  )
  assert.equal(group.status, 'partial')
})

test('вычисляет действия группы только из последних состояний вариантов', () => {
  const [group] = groupGenerationTasks([
    task('queued', 'queued', launch('launch-a', 1, 6, 100), 101),
    task('running', 'running', launch('launch-a', 2, 6, 100), 102),
    task('cancelling', 'cancelling', launch('launch-a', 3, 6, 100), 103),
    task('done', 'done', launch('launch-a', 4, 6, 100), 104),
    task('error', 'error', launch('launch-a', 5, 6, 100), 105, true),
    task('cancelled', 'cancelled', launch('launch-a', 6, 6, 100), 106, true),
  ])

  assert.equal(group.status, 'partial')
  assert.deepEqual(group.doneJobIds, ['done'])
  assert.deepEqual(group.activeJobIds, ['queued', 'running'])
  assert.deepEqual(group.retryableJobIds, ['error'])
})

test('различает активный, ошибочный, отменённый и готовый запуск', () => {
  const statusOf = (...states: GenerationTask['state'][]) =>
    groupGenerationTasks(
      states.map((state, index) =>
        task(
          `job-${index}`,
          state,
          launch('launch-a', index + 1, states.length, 100),
          101 + index,
        ),
      ),
    )[0].status

  assert.equal(statusOf('queued', 'cancelling'), 'active')
  assert.equal(statusOf('error', 'cancelled'), 'error')
  assert.equal(statusOf('cancelled', 'cancelled'), 'cancelled')
  assert.equal(statusOf('done', 'done'), 'done')
})

test('создаёт стабильные метаданные всех вариантов запуска', () => {
  const base = createGenerationLaunch({
    variantCount: 3,
    projectId: TARGET.projectId,
    projectName: 'Доска',
    promptPreview: 'Нарисуй маяк',
    modelId: 'image-model',
    modelName: 'Модель',
    estimatedTotalCostUsd: 0.12,
    createdAt: 500,
  })

  const variants = buildLaunchVariants(base)

  assert.ok(base.launchId.length > 0)
  assert.deepEqual(variants.map((variant) => variant.variantIndex), [1, 2, 3])
  assert.ok(variants.every((variant) => variant.launchId === base.launchId))
  assert.ok(variants.every((variant) => variant.variantCount === 3))
})

test('оставляет частичный сбой старта внутри исходной группы', async () => {
  const base = createGenerationLaunch({
    variantCount: 4,
    projectId: TARGET.projectId,
    promptPreview: 'Нарисуй маяк',
    modelName: 'Модель',
    createdAt: 500,
  })
  const startedVariants: GenerationLaunchMeta[] = []
  const bindings: Array<[string, string]> = []
  const failures: Array<[string, number]> = []

  const outcome = await launchGenerationVariants({
    slots: ['slot-1', 'slot-2', 'slot-3', 'slot-4'],
    launch: base,
    start: async (variant) => {
      startedVariants.push(variant)
      if (variant.variantIndex === 2) throw new Error('Сервер недоступен')
      return `job-${variant.variantIndex}`
    },
    recordFailure: (variant, message) => {
      failures.push([message, variant.variantIndex])
      return `local-${variant.variantIndex}`
    },
    bindJob: (slotId, jobId) => {
      bindings.push([slotId, jobId])
    },
    failSlot: () => {},
    fallbackError: 'Не удалось запустить генерацию',
  })

  assert.deepEqual(startedVariants.map((variant) => variant.variantIndex), [1, 2, 3, 4])
  assert.ok(startedVariants.every((variant) => variant.launchId === base.launchId))
  assert.deepEqual(bindings, [
    ['slot-1', 'job-1'],
    ['slot-2', 'local-2'],
    ['slot-3', 'job-3'],
    ['slot-4', 'job-4'],
  ])
  assert.deepEqual(failures, [['Сервер недоступен', 2]])
  assert.deepEqual(outcome, { startedJobIds: ['job-1', 'job-3', 'job-4'], failedCount: 1 })
})

test('ждёт все quote preflight до общего подтверждения и не запускает частичный ряд', async () => {
  const base = createGenerationLaunch({
    variantCount: 3,
    projectId: TARGET.projectId,
    promptPreview: 'Нарисуй маяк',
    modelName: 'Модель',
    createdAt: 500,
  })
  const started: string[] = []
  const approved: unknown[] = []
  const failures: number[] = []
  const startedAt = Date.now()
  const outcome = await launchGenerationVariants({
    slots: ['slot-1', 'slot-2', 'slot-3'],
    launch: base,
    prepare: async (variant) => {
      if (variant.variantIndex === 1) await new Promise((resolve) => setTimeout(resolve, 20))
      if (variant.variantIndex === 2) await new Promise((resolve) => setTimeout(resolve, 100))
      if (variant.variantIndex === 3) throw new Error('quote недоступна')
      return { variant: variant.variantIndex }
    },
    approve: async (values) => {
      approved.push(...values.map((entry) => entry.value))
      return true
    },
    start: async (_variant) => {
      started.push('unexpected')
      return 'job'
    },
    recordFailure: (variant) => {
      failures.push(variant.variantIndex)
      return `local-${variant.variantIndex}`
    },
    bindJob: () => {},
    failSlot: () => {},
    fallbackError: 'Не удалось запустить генерацию',
  })

  assert.ok(Date.now() - startedAt >= 90, 'preflight должен дождаться медленной котировки')
  assert.deepEqual(approved, [])
  assert.deepEqual(started, [])
  assert.deepEqual(failures, [1, 2, 3])
  assert.deepEqual(outcome, { startedJobIds: [], failedCount: 3 })
})

test('не спрашивает серию, если сервер не требует подтверждения', async () => {
  const requests: string[] = []
  registerConfirmHost((request, resolve) => {
    requests.push(request.title)
    resolve(true)
  })
  try {
    const launch = createGenerationLaunch({
      variantCount: 4,
      projectId: TARGET.projectId,
      promptPreview: 'Нарисуй маяк',
      modelName: 'Модель',
      estimatedTotalCostUsd: 2,
      createdAt: 500,
    })
    const prepared = [0.5, 0.5, 0.5, 0.5].map((amount, index) => ({
      variant: { ...launch, variantIndex: index + 1 },
      slotId: `slot-${index + 1}`,
      value: {
        options: { idempotencyKey: `key-${index + 1}` },
        quote: {
          id: `quote-${index + 1}`,
          requestHash: `hash-${index + 1}`,
          amountMicro: amount * 1_000_000,
          amountUsd: amount,
          quantity: 1,
          expiresAt: Date.now() + 60_000,
          needsConfirmation: false,
          confirmAboveMicro: 0,
        },
      },
    }))

    assert.equal(await approvePreparedGenerationQuotes(prepared), true)
    assert.deepEqual(requests, [])
  } finally {
    registerConfirmHost(null)
  }
})

test('сумма серии уважает общий confirmAboveMicro и сохраняет fallback старого сервера', async () => {
  const launch = createGenerationLaunch({
    variantCount: 4,
    projectId: TARGET.projectId,
    promptPreview: 'Нарисуй маяк',
    modelName: 'Модель',
    estimatedTotalCostUsd: 8,
    createdAt: 500,
  })
  const makePrepared = (threshold?: number) => [2, 2, 2, 2].map((amount, index) => ({
    variant: { ...launch, variantIndex: index + 1 },
    slotId: `slot-${index + 1}`,
    value: {
      options: { idempotencyKey: `key-${threshold ?? 'legacy'}-${index + 1}` },
      quote: {
        id: `quote-${threshold ?? 'legacy'}-${index + 1}`,
        requestHash: `hash-${threshold ?? 'legacy'}-${index + 1}`,
        amountMicro: amount * 1_000_000,
        amountUsd: amount,
        quantity: 1,
        expiresAt: Date.now() + 60_000,
        needsConfirmation: false,
        ...(threshold === undefined ? {} : { confirmAboveMicro: threshold * 1_000_000 }),
      },
    },
  }))

  for (const [label, threshold, expectedRequests] of [
    ['threshold 5', 5, 1],
    ['threshold 0', 0, 0],
    ['threshold 10', 10, 0],
    ['legacy server', undefined, 1],
  ] as const) {
    const requests: string[] = []
    registerConfirmHost((request, resolve) => {
      requests.push(request.title)
      resolve(true)
    })
    try {
      assert.equal(await approvePreparedGenerationQuotes(makePrepared(threshold)), true, label)
      assert.equal(requests.length, expectedRequests, label)
    } finally {
      registerConfirmHost(null)
    }
  }
})

test('смешанная серия считает metered-котировку общим потолком', async () => {
  let confirmation: { title: string; detail?: string; rows?: Array<[string, string]> } | undefined
  registerConfirmHost((request, resolve) => {
    confirmation = request
    resolve(true)
  })
  try {
    const launch = createGenerationLaunch({
      variantCount: 2,
      projectId: TARGET.projectId,
      promptPreview: 'Нарисуй маяк',
      modelName: 'Модель',
      estimatedTotalCostUsd: 1.5,
      createdAt: 500,
    })
    const prepared = [
      {
        variant: { ...launch, variantIndex: 1 },
        slotId: 'slot-1',
        value: {
          options: { idempotencyKey: 'key-1' },
          quote: {
            id: 'quote-metered', requestHash: 'hash-metered', amountMicro: 1_000_000,
            amountUsd: 1, quantity: 1, expiresAt: Date.now() + 60_000,
            needsConfirmation: true, guaranteed: true, pricingMode: 'fal-metered' as const,
          },
        },
      },
      {
        variant: { ...launch, variantIndex: 2 },
        slotId: 'slot-2',
        value: {
          options: { idempotencyKey: 'key-2' },
          quote: {
            id: 'quote-fixed', requestHash: 'hash-fixed', amountMicro: 500_000,
            amountUsd: 0.5, quantity: 1, expiresAt: Date.now() + 60_000,
            needsConfirmation: false, pricingMode: 'fixed' as const,
          },
        },
      },
    ]

    assert.equal(await approvePreparedGenerationQuotes(prepared), true)
    assert.equal(confirmation?.title, 'Run for no more than $1.50?')
    // Смешанная серия добавляет РОВНО одну оговорку к общему тексту: длинное
    // окно и было тем, на что жаловались.
    assert.match(confirmation?.detail ?? '', /up to this amount/u)
    assert.match(confirmation?.detail ?? '', /fixed price, some is metered/u)
    assert.deepEqual(confirmation?.rows, [
      ['Model', 'Модель'],
      ['Prompt', 'Нарисуй маяк'],
      ['Tasks', '2'],
      ['No more than', '$1.50'],
    ])
  } finally {
    registerConfirmHost(null)
  }
})

test('uncapped estimate prompts only when the server policy requires it', async () => {
  let confirmation: { title: string; detail?: string; rows?: Array<[string, string]> } | undefined
  registerConfirmHost((request, resolve) => {
    confirmation = request
    resolve(true)
  })
  try {
    const launch = createGenerationLaunch({
      variantCount: 1,
      projectId: TARGET.projectId,
      promptPreview: 'Нарисуй маяк',
      modelName: 'GPT Image 2.5 Flare',
      estimatedTotalCostUsd: 0.9,
      createdAt: 500,
    })
    const prepared = [{
      variant: { ...launch, variantIndex: 1 },
      slotId: 'slot-uncapped',
      value: {
        options: { idempotencyKey: 'key-uncapped' },
        quote: {
          id: 'quote-uncapped', requestHash: 'hash-uncapped', amountMicro: 900_000,
          amountUsd: 0.9, quantity: 1, expiresAt: Date.now() + 60_000,
          needsConfirmation: true, guaranteed: false, meteredUncapped: true,
          pricingMode: 'fal-metered' as const,
        },
      },
    }]

    assert.equal(await approvePreparedGenerationQuotes(prepared), true)
    assert.equal(confirmation?.title, 'Run for about $0.90?')
    assert.match(confirmation?.detail ?? '', /estimate/u)
    assert.match(confirmation?.detail ?? '', /actual generation cost/u)
    assert.doesNotMatch(confirmation?.detail ?? '', /no more|reserve|ceiling/u)
    assert.deepEqual(confirmation?.rows, [
      ['Model', 'GPT Image 2.5 Flare'],
      ['Prompt', 'Нарисуй маяк'],
      ['Tasks', '1'],
      ['Estimate', '$0.90'],
    ])
  } finally {
    registerConfirmHost(null)
  }
})

test('uncapped matching estimate не открывает модалку без server confirmation', async () => {
  const requests: string[] = []
  registerConfirmHost((request, resolve) => {
    requests.push(request.title)
    resolve(true)
  })
  try {
    const launch = createGenerationLaunch({
      variantCount: 1,
      projectId: TARGET.projectId,
      promptPreview: 'Нарисуй маяк',
      modelName: 'GPT Image 2.5 Flare',
      estimatedTotalCostUsd: 0.9,
      createdAt: 500,
    })
    const prepared = [{
      variant: { ...launch, variantIndex: 1 },
      slotId: 'slot-uncapped-no-confirm',
      value: {
        options: { idempotencyKey: 'key-uncapped-no-confirm' },
        quote: {
          id: 'quote-uncapped-no-confirm', requestHash: 'hash-uncapped-no-confirm', amountMicro: 900_000,
          amountUsd: 0.9, quantity: 1, expiresAt: Date.now() + 60_000,
          needsConfirmation: false, guaranteed: false, meteredUncapped: true,
          confirmAboveMicro: 0, pricingMode: 'fal-metered' as const,
        },
      },
    }]

    assert.equal(await approvePreparedGenerationQuotes(prepared), true)
    assert.deepEqual(requests, [])
  } finally {
    registerConfirmHost(null)
  }
})

test('показывает точную cloud quote, если она отличается от оценки на кнопке', async () => {
  const requests: string[] = []
  registerConfirmHost((request, resolve) => {
    requests.push(request.title)
    resolve(true)
  })
  try {
    const launch = createGenerationLaunch({
      variantCount: 1,
      projectId: TARGET.projectId,
      promptPreview: 'Нарисуй маяк',
      modelName: 'Модель',
      estimatedTotalCostUsd: 0.8,
      createdAt: 500,
    })
    const prepared = [{
      variant: { ...launch, variantIndex: 1 },
      slotId: 'slot-1',
      value: {
        options: { idempotencyKey: 'key-1' },
        quote: {
          id: 'quote-1',
          requestHash: 'hash-1',
          amountMicro: 900_000,
          amountUsd: 0.9,
          quantity: 1,
          expiresAt: Date.now() + 60_000,
          needsConfirmation: false,
        },
      },
    }]

    assert.equal(await approvePreparedGenerationQuotes(prepared), true)
    assert.deepEqual(requests, ['Run for $0.90?'])
  } finally {
    registerConfirmHost(null)
  }
})

test('цель генерации несёт явный source проекта даже при одинаковом id', () => {
  assert.deepEqual(
    createGenerationTarget({ source: 'local', id: 'same' }, 'slot-1'),
    { kind: 'canvas', projectRef: { source: 'local', id: 'same' }, placeholderId: 'slot-1' },
  )
  assert.deepEqual(
    createGenerationTarget({ source: 'cloud', id: 'same' }, 'slot-2'),
    { kind: 'canvas', projectRef: { source: 'cloud', id: 'same' }, placeholderId: 'slot-2' },
  )
})
