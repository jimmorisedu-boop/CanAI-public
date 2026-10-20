import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { createCanvasActionRouter } from './canvasActionRoutes.js'
import type { Job, JobStore } from './jobs.js'
import { publicLocalJob } from './jobWait.js'

const image = { kind: 'image' as const, src: '/media/source.png', width: 640, height: 480 }

async function withServer(
  configure: (jobs: Job[]) => ReturnType<typeof createCanvasActionRouter>,
  run: (base: string, jobs: Job[]) => Promise<void>,
): Promise<void> {
  const jobs: Job[] = []
  const app = express()
  app.use(express.json())
  app.use('/api', configure(jobs))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`, jobs)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function fakeStore(items: Job[]): Pick<JobStore, 'all' | 'get' | 'create'> {
  return {
    all: () => items,
    get: (id) => items.find((job) => job.id === id),
    create: ((kind, prompt, refs, model, params, target) => {
      const job = {
        id: `job-${items.length + 1}`,
        kind,
        prompt,
        refs,
        model,
        params,
        target,
        status: 'queued' as const,
        createdAt: Date.now(),
      }
      items.push(job)
      return job
    }) as JobStore['create'],
  }
}

async function jsonRequest(base: string, path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

test('local action preparation is durable, idempotent, review-only, and hides system params', async () => {
  let enqueued = 0
  let cancelled = 0
  await withServer((items) => createCanvasActionRouter({
    jobStore: fakeStore(items),
    resolveLocalProfile: async (id) => id === 'helper' ? {
      id: 'helper', modelId: 'gemini', systemPrompt: 'DOC-STYLE',
    } : null,
    loadAppSettings: async () => ({ assistantModelId: 'gemini', assistantSystemPrompt: 'DEFAULT' } as never),
    chooseRoute: () => 'mock',
    enqueue: async (job) => {
      enqueued++
      job.result = { text: 'замени мужчин на девушек' }
      // Runner clears refs after a terminal job; the persisted refsHash must
      // still make a same-key retry idempotent.
      job.refs = []
    },
    cancel: async (id) => {
      cancelled++
      return id === 'job-1' ? 'cancelled' : 'not-found'
    },
  }), async (base, jobs) => {
    const input = {
      projectRef: { source: 'local', id: 'board-1' },
      prompt: 'замени мужчин на девушек',
      refs: [image],
      assistantId: 'helper',
      idempotencyKey: 'action-1',
    }
    const started = await jsonRequest(base, '/api/canvas/actions/prepare', input)
    assert.equal(started.status, 202)
    assert.equal(started.body.profile.id, 'helper')
    assert.equal(enqueued, 1)
    assert.match(String(jobs[0]?.params?.system_prompt), /DOC-STYLE/u)
    assert.equal(jobs[0]?.canvasActionPrompt, input.prompt)

    const repeated = await jsonRequest(base, '/api/canvas/actions/prepare', input)
    assert.equal(repeated.status, 200)
    assert.equal(repeated.body.jobId, started.body.jobId)
    assert.equal(enqueued, 1)

    const status = await jsonRequest(base, `/api/canvas/actions/prepare/${started.body.jobId}`, undefined, 'GET')
    assert.equal(status.status, 200)
    assert.deepEqual(status.body.result, { text: input.prompt })
    assert.equal('params' in status.body, false)
    assert.equal('canvasActionPrompt' in status.body, false)
    const generic = publicLocalJob(jobs[0]!)
    assert.equal('model' in generic, false)
    assert.equal('target' in generic, false)
    assert.equal('canvasActionPrompt' in generic, false)

    const rejected = await jsonRequest(base, '/api/canvas/actions/prepare', {
      ...input, idempotencyKey: 'action-2', model: 'fal/secret', params: {}, tools: [],
    })
    assert.equal(rejected.status, 400)

    const cancelledResult = await jsonRequest(base, `/api/canvas/actions/prepare/${started.body.jobId}/cancel`, {})
    assert.equal(cancelledResult.status, 200)
    assert.equal(cancelled, 1)

    jobs.push({
      ...jobs[0]!,
      id: 'ordinary-job',
      target: { kind: 'canvas', projectId: 'board-1', placeholderId: 'placeholder-1' },
    })
    const ordinaryCancel = await jsonRequest(base, '/api/canvas/actions/prepare/ordinary-job/cancel', {})
    assert.equal(ordinaryCancel.status, 404)
    assert.equal(cancelled, 1)
  })
})

test('universal local action ignores the legacy assistant settings prompt', async () => {
  let createdJob: Job | undefined
  await withServer((items) => createCanvasActionRouter({
    jobStore: fakeStore(items),
    resolveLocalProfile: async () => null,
    loadAppSettings: async () => ({ assistantModelId: 'gemini', assistantSystemPrompt: 'LEGACY-SETTINGS-RULE' } as never),
    chooseRoute: () => 'mock',
    enqueue: async (job) => {
      createdJob = job
      job.result = { text: job.prompt }
    },
  }), async (base) => {
    const response = await jsonRequest(base, '/api/canvas/actions/prepare', {
      projectRef: { source: 'local', id: 'board-universal' },
      prompt: 'подготовь описание изображения',
      refs: [image],
      assistantId: null,
      idempotencyKey: 'universal-legacy-settings',
    })
    assert.equal(response.status, 202)
    const systemPrompt = String(createdJob?.params?.system_prompt ?? '')
    assert.match(systemPrompt, /private text-only request preparation stage/u)
    assert.doesNotMatch(systemPrompt, /LEGACY-SETTINGS-RULE/u)
  })
})

test('same canvas action key admits one durable job and rejects conflicting replay', async () => {
  let profilesResolved = 0
  let enqueued = 0
  let enteredResolve!: () => void
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
  let releaseResolve!: () => void
  const gate = new Promise<void>((resolve) => { releaseResolve = resolve })

  await withServer((items) => createCanvasActionRouter({
    jobStore: fakeStore(items),
    resolveLocalProfile: async (id) => {
      profilesResolved++
      if (profilesResolved === 1) {
        enteredResolve()
        await gate
      }
      return id === 'helper' ? {
        id: 'helper', modelId: 'gemini', systemPrompt: 'DOC-STYLE',
      } : null
    },
    loadAppSettings: async () => ({ assistantModelId: 'gemini', assistantSystemPrompt: 'DEFAULT' } as never),
    chooseRoute: () => 'mock',
    enqueue: async (job) => {
      enqueued++
      job.result = { text: job.prompt }
    },
  }), async (base) => {
    const input = {
      projectRef: { source: 'local', id: 'board-concurrent' },
      prompt: 'замени мужчин на девушек',
      refs: [image],
      assistantId: 'helper',
      idempotencyKey: 'concurrent-action-1',
    }
    const first = jsonRequest(base, '/api/canvas/actions/prepare', input)
    await entered
    const second = jsonRequest(base, '/api/canvas/actions/prepare', input)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(profilesResolved, 1)
    assert.equal(enqueued, 0)
    releaseResolve()
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult.status, 202)
    assert.equal(secondResult.status, 200)
    assert.equal(secondResult.body.jobId, firstResult.body.jobId)
    assert.equal(enqueued, 1)

    const conflict = await jsonRequest(base, '/api/canvas/actions/prepare', {
      ...input,
      assistantId: 'other-helper',
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')

    const versionConflict = await jsonRequest(base, '/api/canvas/actions/prepare', {
      ...input,
      profileVersionId: 'other-version',
    })
    assert.equal(versionConflict.status, 409)
    assert.equal(versionConflict.body.code, 'IDEMPOTENCY_CONFLICT')
  })
})

test('enqueue failure cannot become a false idempotent success on retry', async () => {
  let attempts = 0
  await withServer((items) => createCanvasActionRouter({
    jobStore: fakeStore(items),
    chooseRoute: () => 'mock',
    enqueue: async () => {
      attempts++
      throw new Error('disk unavailable')
    },
  }), async (base) => {
    const input = {
      projectRef: { source: 'local', id: 'board-persist' },
      prompt: 'замени мужчин на девушек',
      refs: [image],
      idempotencyKey: 'persist-failure-1',
    }
    const first = await jsonRequest(base, '/api/canvas/actions/prepare', input)
    const second = await jsonRequest(base, '/api/canvas/actions/prepare', input)
    assert.equal(first.status, 500)
    assert.equal(first.body.code, 'CANVAS_ACTION_PERSIST_FAILED')
    assert.equal(second.status, 500)
    assert.equal(second.body.code, 'CANVAS_ACTION_PERSIST_FAILED')
    assert.equal(attempts, 1)
  })
})


test('local action preparation accepts 0 image refs', async () => {
  let createdJob: Job | null = null
  await withServer((items) => createCanvasActionRouter({
    jobStore: fakeStore(items),
    resolveLocalProfile: async () => ({
      id: 'helper',
      modelId: 'text-model',
      systemPrompt: 'SYSTEM',
    }),
    chooseRoute: () => 'mock',
    enqueue: async (job) => { createdJob = job },
  }), async (base, jobs) => {
    const input = {
      projectRef: { source: 'local', id: 'board-1' },
      prompt: 'нарисуй пейзаж на закате',
      refs: [],
      assistantId: 'helper',
      idempotencyKey: 'zero-refs-key',
    }
    const response = await jsonRequest(base, '/api/canvas/actions/prepare', input)
    assert.equal(response.status, 202)
    assert.equal(jobs.length, 1)
    assert.deepEqual(jobs[0].refs, [])
    assert.equal(createdJob?.prompt, 'нарисуй пейзаж на закате')
  })
})
