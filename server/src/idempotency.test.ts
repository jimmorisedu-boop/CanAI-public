import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { JobStore } from './jobs.js'
import type { Job } from './jobs.js'
import { type GenerationRoute } from './generationGate.js'
import { findIdempotentReplay, idempotencyAppliesTo } from './idempotency.js'

// Пункт плана аудита 4: серверная идемпотентность POST /api/generate для
// локальных/legacy-generations. Повтор запроса с тем же idempotencyKey обязан
// вернуть УЖЕ созданную задачу, а не ставить вторую (иначе — двойной расход).

function fakeJob(overrides: Partial<Job>): Job {
  return {
    id: randomUUID(),
    kind: 'image',
    prompt: 'тест',
    refs: [],
    status: 'queued',
    createdAt: Date.now(),
    ...overrides,
  } as Job
}

test('находит повтор по тому же ключу, маршруту и доске', () => {
  const boardA = 'board-1'
  const boardB = 'board-2'
  const key = 'k-123'
  const existing = fakeJob({
    generationRoute: 'local',
    idempotencyKey: key,
    target: { kind: 'canvas', projectId: boardA, placeholderId: 'ph' },
  })

  // Тот же ключ, тот же маршрут, та же доска — это повтор: возвращаем задачу.
  assert.equal(
    findIdempotentReplay([existing], { idempotencyKey: key, generationRoute: 'local', projectId: boardA }),
    existing,
  )


})

test('не считает повтором чужой ключ, маршрут или доску', () => {
  const boardA = 'board-1'
  const boardB = 'board-2'
  const key = 'k-123'
  const created = fakeJob({
    generationRoute: 'local',
    idempotencyKey: key,
    target: { kind: 'canvas', projectId: boardA, placeholderId: 'ph' },
  })

  // Другой ключ — новый запуск.
  assert.equal(
    findIdempotentReplay([created], { idempotencyKey: 'k-DRUGIE', generationRoute: 'local', projectId: boardA }),
    undefined,
  )
  // Тот же ключ, но без ключа в задаче — не повтор.
  const noKey = fakeJob({ generationRoute: 'local', target: { kind: 'canvas', projectId: boardA, placeholderId: 'ph' } })
  assert.equal(
    findIdempotentReplay([noKey], { idempotencyKey: key, generationRoute: 'local', projectId: boardA }),
    undefined,
  )
  // Другой маршрут (напр. mock) с тем же ключом — не повтор.
  const mockJob = fakeJob({ generationRoute: 'mock', idempotencyKey: key })
  assert.equal(
    findIdempotentReplay([mockJob], { idempotencyKey: key, generationRoute: 'local', projectId: boardA }),
    undefined,
  )
  // Та же доска, но другой канвас-запуск... тот же ключ = повтор (см. первый тест).
  // А вот РАЗНАЯ доска с тем же ключом — отдельные запуски, а не повтор.
  assert.equal(
    findIdempotentReplay([created], { idempotencyKey: key, generationRoute: 'local', projectId: boardB }),
    undefined,
  )
})

test('без доски повтор матчит по ключу и маршруту', () => {
  const created = fakeJob({ generationRoute: 'local', idempotencyKey: 'k-x' })
  assert.equal(
    findIdempotentReplay([created], { idempotencyKey: 'k-x', generationRoute: 'local' }),
    created,
  )
})

test('повтор-ловля применима только к локальному маршруту', () => {
  assert.equal(idempotencyAppliesTo('local'), true)
  assert.equal(idempotencyAppliesTo('mock'), false)
})

test('ключ идемпотентности переживает перезапуск сервера (jobs.json)', async (t) => {
  // Повтор приходит ПОСЛЕ рестарта: сервер обязан восстановить ключ из
  // jobs.json и всё ещё вернуть ту же задачу, а не поставить новую.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-verify-idem-'))
  const file = path.join(dir, 'jobs.json')
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  })

  const first = new JobStore(file)
  const board = 'board-r'
  const key = 'k-restart'
  const job = first.create('image', 'тест', [], undefined, undefined, {
    kind: 'canvas',
    projectId: board,
    placeholderId: 'ph',
  })
  job.generationRoute = 'local'
  job.idempotencyKey = key
  await first.persistNow()

  // Новая фабрика = «перезапуск» — store пуст.
  const rebooted = new JobStore(file)
  const queued = await rebooted.restore()
  assert.ok(queued.some((j) => j.id === job.id), 'задача восстановлена из jobs.json')
  assert.equal(queued.find((j) => j.id === job.id)?.idempotencyKey, key,
    'ключ идемпотентности должен пережить перезапуск')

  const replay = findIdempotentReplay(rebooted.all(), {
    idempotencyKey: key,
    generationRoute: 'local',
    projectId: board,
  })
  assert.equal(replay?.id, job.id, 'после рестарта повтор обязан вернуть ту же задачу')
  assert.equal(rebooted.all().filter((j) => j.id === job.id).length, 1,
    'повтор не должен создать вторую копию задачи')
})