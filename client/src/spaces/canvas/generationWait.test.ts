import assert from 'node:assert/strict'
import test from 'node:test'
import type { JobWaitEntry } from '../../api'
import type { Job } from '../../types'
import { createGenerationRegistry, type GenerationRegistryDeps } from './generationRegistry'

/**
 * Статус задачи — от своего исполнителя, а не опросом (пункт 3.7, находка С-4
 * аудита сетевой доски). Раньше реестр спрашивал о КАЖДОЙ задаче по очереди
 * раз в 0,9 с; теперь один запрос ждёт, пока хоть одна изменится.
 */

type Waited = { ids: string[]; seen: Record<string, string>; signal: AbortSignal }

function job(id: string, status: Job['status'], extra: Partial<Job> = {}): Job {
  return { id, kind: 'image', prompt: 'кот', status, ...extra }
}

function entry(id: string, status: Job['status'], extra: Partial<Job> = {}): JobWaitEntry {
  return { id, version: `${id}:${status}`, job: job(id, status, extra) }
}

function harness(answer: (call: Waited, index: number) => Promise<JobWaitEntry[] | null>) {
  const calls: Waited[] = []
  const polled: string[] = []
  const deps: GenerationRegistryDeps = {
    getJob: async (id) => {
      polled.push(id)
      return job(id, 'running')
    },
    waitJobs: (ids, seen, signal) => {
      const call = { ids: [...ids], seen: { ...seen }, signal }
      calls.push(call)
      return answer(call, calls.length - 1)
    },
    cancelJob: async () => {},
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    unschedule: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  const registry = createGenerationRegistry(deps)
  return { registry, calls, polled }
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Ожидание, которое отвечает только обрывом — как сервер, у которого нет новостей. */
function hang(call: Waited): Promise<never> {
  return new Promise((_resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
}

test('все задачи — одним ждущим запросом, и готовое доезжает в тот же миг', async (t) => {
  const delivered: string[] = []
  const h = harness(async (call, index) => {
    if (index === 0) return call.ids.map((id) => entry(id, 'running'))
    if (index === 1) return [entry('job-a', 'done', { result: { url: '/media/кот.png' } }), entry('job-b', 'running')]
    return hang(call)
  })
  t.after(() => h.registry.dispose())
  h.registry.registerGenerationSink('canvas', 'board', (settled) => { delivered.push(settled.id) })

  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-a', 'image')
  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-b', 'image')
  await until(() => delivered.length === 1)

  assert.deepEqual(delivered, ['job-a'])
  assert.deepEqual(h.polled, [], 'по одной задаче больше не спрашиваем')
  const second = h.calls.find((call) => Object.keys(call.seen).length > 0)!
  assert.deepEqual(second.seen, { 'job-a': 'job-a:running', 'job-b': 'job-b:running' },
    'сервер получает отметки и ждёт, пока они сменятся')
  await until(() => h.calls.length >= 3)
  assert.deepEqual(h.calls.at(-1)!.ids, ['job-b'], 'готовая задача из ожидания ушла')
})

test('новая задача обрывает ожидание по старым: иначе ждала бы до пятнадцати секунд', async (t) => {
  const h = harness(async (call, index) => (index === 0 ? call.ids.map((id) => entry(id, 'running')) : hang(call)))
  t.after(() => h.registry.dispose())

  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-a', 'image')
  await until(() => h.calls.length === 2)
  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-b', 'image')
  await until(() => h.calls.length === 3)

  assert.equal(h.calls[1]!.signal.aborted, true)
  assert.deepEqual(h.calls[2]!.ids, ['job-a', 'job-b'])
})

test('сервер не умеет ждать — опрос по одной задаче, как раньше', async (t) => {
  const h = harness(async () => null)
  t.after(() => h.registry.dispose())

  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-a', 'image')
  await until(() => h.polled.length > 0)

  assert.equal(h.calls.length, 1, 'после первого отказа больше не пробуем')
  assert.deepEqual(h.polled.slice(0, 1), ['job-a'])
})

test('пропавшая задача хоронится, сбой связи — только «восстанавливаю связь»', async (t) => {
  const h = harness(async (call, index) => (index === 0
    ? [
        { id: 'job-lost', version: 'missing', missing: true },
        { id: 'job-net', version: 'failure:502', failure: { status: 502, error: 'Командный сервер не отвечает' } },
      ]
    : hang(call)))
  t.after(() => h.registry.dispose())

  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-lost', 'image')
  h.registry.trackGeneration({ kind: 'canvas', projectId: 'board' }, 'job-net', 'image')
  await until(() => h.registry.getSnapshot().some((task) => task.jobId === 'job-lost' && task.state === 'error'))

  const tasks = new Map(h.registry.getSnapshot().map((task) => [task.jobId, task]))
  assert.equal(tasks.get('job-lost')!.connection, 'delivery-error')
  assert.equal(tasks.get('job-net')!.state, 'queued', 'оплаченную задачу из-за сети не хороним')
  assert.equal(tasks.get('job-net')!.connection, 'reconnecting')
  await until(() => h.calls.length >= 2)
  assert.deepEqual(h.calls[1]!.ids, ['job-net'])
  assert.deepEqual(h.calls[1]!.seen, { 'job-net': 'failure:502' }, 'тот же сбой не будит заново')
})
