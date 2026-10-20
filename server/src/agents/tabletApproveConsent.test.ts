import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { AgentDecisionPayload, AgentEnvelope } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'

// Проверка пункта 3 плана аудита (AUDIT-REPORT.md §7): «подписанное согласие
// на approve решений агентов», выбранный режим «Дневной лимит + подтверждение».
//
// Тесты гоняют НАСТОЯЩИЙ маршрут AgentTaskLifecycle.decide() (host-lifecycle.ts)
// на подставленном контексте: реальный journal во временном каталоге, реальный
// валидатор протокола, реальный makeHostEnvelope. Поэтому проверяется именно
// то, что увидит пользователь:
//   - платное одобрение с планшета БЕЗ согласия -> CONSENT_REQUIRED (403),
//     задача не меняется, счётчик не трогается;
//   - платное одобрение с планшета с согласием под дневным лимитом -> первое
//     проходит, второе (другая задача) упирается в TABLET_APPROVE_LIMIT_REACHED,
//     счётчик тратится ровно один раз;
//   - платное одобрение с планшета с согласием -> consent:true входит в решение,
//     выдан grant, и 'review.decision' проходит assertEnvelope('host-to-agent'),
//     то есть реально ушло бы в процесс агента;
//   - платное одобрение с ДЕСКТОПА -> согласия не требует, и ключа consent в
//     решении нет (согласие нужно только для планшета);
//   - бесплатное одобрение с планшета -> согласия не требует (нет самой оплаты).
//
// CANAI_DATA_DIR обязан стоять ДО первого импорта модулей CanAI: config читает
// env при загрузке, а путь к счётчику платных подтверждений берётся от него.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-approve-consent-'))
process.env.CANAI_DATA_DIR = dataDir
const CONSENT_FILE = path.join(dataDir, 'agent-approve-count.json')

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

/** Входные данные для decide: ответ на решение + служебные поля для идемпотентности. */
type DecideInput = Partial<AgentDecisionPayload> & { requestId: string; expectedRevision: number }
type DecideOpts = { tablet?: boolean; tabletApproveDailyLimit?: number }

interface Mod {
  // host-shared грузится БЕЗ ?gen и первым: lifecycle внутри импортирует тот же
  // модуль без версии, поэтому класс AgentHostError — один и тот же экземпляр,
  // и instanceof в проверках ошибок работает. Но! Статического import в этом
  // файле быть не может: он выполнился бы ДО установки CANAI_DATA_DIR, потянул
  // бы config раньше времени, и счётчик платных подтверждений уехал бы в
  // настоящий server/data. Поэтому класс берём отсюда, из runtime.
  hostShared: typeof import('./host-shared.js')
  lifecycle: typeof import('./host-lifecycle.js')
  journal: typeof import('./journal.js')
  wire: typeof import('./host-wire.js')
  validation: typeof import('./validation.js')
  count: typeof import('./tabletApproveCount.js')
}

let generation = 0
async function freshModules(): Promise<Mod> {
  generation += 1
  const g = String(generation)
  return {
    hostShared: await import('./host-shared.js'),
    lifecycle: await import(`./host-lifecycle.js?gen=${g}`),
    journal: await import(`./journal.js?gen=${g}`),
    wire: await import(`./host-wire.js?gen=${g}`),
    validation: await import(`./validation.js?gen=${g}`),
    count: await import(`./tabletApproveCount.js?gen=${g}`),
  }
}

/** Сцена: свежий набор модулей (своё модульное состояние счётчика) + свой journal. */
interface Scene {
  mod: Mod
  lifecycle: InstanceType<Mod['lifecycle']['AgentTaskLifecycle']>
  journal: InstanceType<Mod['journal']['AgentTaskJournal']>
  validator: InstanceType<Mod['validation']['AgentProtocolValidator']>
  now(): number
  started: Set<string>
  sent: Array<{ taskId: string; message: AgentEnvelope }>
}

async function makeScene(nowMs: number): Promise<Scene> {
  const mod = await freshModules()
  const journal = new mod.journal.AgentTaskJournal(path.join(dataDir, 'journal.json'), {
    workspaceRoot: path.join(dataDir, 'workspace'),
    checkpointRoot: path.join(dataDir, 'checkpoints'),
    now: () => nowMs,
  })
  const started = new Set<string>()
  const sent: Array<{ taskId: string; message: AgentEnvelope }> = []
  const lifecycle = new mod.lifecycle.AgentTaskLifecycle({
    journal,
    processes: { has: (taskId: string) => started.has(taskId) },
    actorId: () => 'test-actor',
    now: () => nowMs,
    require: async (taskId: string) => {
      const task = await journal.get(taskId)
      if (!task) throw new Error('Задача не найдена')
      return task
    },
    cancelExternal: async () => {},
    start: async (taskId: string) => {
      started.add(taskId)
      const task = await journal.get(taskId)
      if (!task) throw new Error('Задача не найдена')
      return task
    },
    sendOrQueue: (taskId: string, message: AgentEnvelope) => { sent.push({ taskId, message }) },
    makeHostEnvelope: (task: AgentTaskRecord, type, payload) => mod.wire.makeHostEnvelope(task, type, payload),
  })
  return {
    mod,
    lifecycle,
    journal,
    validator: new mod.validation.AgentProtocolValidator(),
    now: () => nowMs,
    started,
    sent,
  }
}

function makeReview(reviewId: string, now: number, paid: boolean): AgentTaskRecord['reviews'][number] {
  return {
    reviewId,
    revision: 1,
    status: 'pending',
    stageId: 'generate',
    title: 'Одобрение генерации',
    question: 'Подтвердите платную генерацию изображения',
    materials: [],
    decisions: ['approved'],
    createdAt: now,
    requestedGrant: paid
      ? {
          connectionId: 'local-fal',
          tool: 'generation.request',
          artifactRefs: [],
          maxCalls: 1,
          maxCost: { currency: 'USD', amountMicros: 250_000 },
        }
      : undefined,
    generationSpec: paid
      ? {
          kind: 'image',
          modelId: 'nano-banana',
          catalogRevision: 1,
          promptHash: 'prompt-hash-1',
          paramsHash: 'params-hash-1',
          refs: [],
          prompt: 'Ёж на опушке леса, вечерний свет',
          estimateMicros: 250_000,
        }
      : undefined,
  }
}

/**
 * Минимально валидная запись задачи в состоянии awaiting_review. ВСЕ id —
 * только ASCII: requestId проходит checkIdentifier, а taskId/executionId —
 * checkId валидатора протокола (SAFE_ID).
 */
function makeTask(taskId: string, reviewId: string, now: number, withPaidSpec: boolean): AgentTaskRecord {
  return {
    taskId,
    requestId: taskId,
    requestHash: 'request-hash',
    packageId: 'bundled-creator',
    packageVersion: '1.0.0',
    packageSha: 'pkg-sha',
    protocolVersion: '1.0',
    projectRef: { source: 'local', id: taskId },
    ownerId: 'owner-1',
    controllerId: 'controller-1',
    taskType: 'creator',
    instruction: 'Сгенерируй изображение по промпту',
    input: { prompt: 'Ёж на опушке' },
    inputs: [],
    workspaceId: 'workspace-id',
    workspacePath: 'workspace/id',
    state: 'awaiting_review',
    revision: 1,
    eventCursor: 0,
    currentExecutionId: `${taskId}-exec-1`,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    generationBudget: withPaidSpec
      ? {
          grantId: `budget-${taskId}`,
          connectionId: 'local-fal',
          currency: 'USD',
          maxCostMicros: 400_000,
          reservedMicros: 0,
          chargedMicros: 0,
          overshootMicros: 0,
          calls: 0,
          maxCalls: 1,
          status: 'active',
          modelId: 'fal-ai/flux-1.1-pro',
          catalogRevision: 1,
        }
      : undefined,
    receipts: [],
    reviews: [makeReview(reviewId, now, withPaidSpec)],
    decisions: [],
    artifacts: [],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: now,
    updatedAt: now,
  }
}

function approve(requestId: string, consent?: boolean): DecideInput {
  return {
    requestId,
    expectedRevision: 1,
    revision: 1,
    decision: 'approved',
    comment: '',
    ...(consent === undefined ? {} : { consent }),
  }
}

test('платное одобрение с планшета без согласия отклоняется (CONSENT_REQUIRED)', async () => {
  const scene = await makeScene(Date.parse('2026-10-05T12:00:00Z'))
  await scene.journal.create(makeTask('t-no-consent', 'r-no-consent', scene.now(), true))

  await assert.rejects(
    scene.lifecycle.decide('t-no-consent', 'r-no-consent', approve('req-1'), { tablet: true, tabletApproveDailyLimit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof scene.mod.hostShared.AgentHostError)
      assert.equal(error.code, 'CONSENT_REQUIRED')
      assert.equal(error.status, 403)
      assert.match(error.message, /consent/)
      return true
    },
  )

  // Задача не тронута: ждёт согласования, решение не записано.
  const record = await scene.journal.get('t-no-consent')
  assert.ok(record)
  assert.equal(record.state, 'awaiting_review')
  assert.equal(record.reviews[0]?.status, 'pending')
  assert.equal(record.decisions.length, 0)
  // Счётчик не создан и не трачен (файл появился бы только при списании).
  await assert.rejects(fs.access(CONSENT_FILE))
})

test('дневной лимит с планшета с согласием: первое проходит, второе упирается', async () => {
  const scene = await makeScene(Date.parse('2026-10-06T12:00:00Z'))
  await scene.journal.create(makeTask('t-a1', 'r-a1', scene.now(), true))
  await scene.journal.create(makeTask('t-b1', 'r-b1', scene.now(), true))

  const opts: DecideOpts = { tablet: true, tabletApproveDailyLimit: 1 }

  // Первое платное одобрение с согласием — успех, потратил единственное место.
  const first = await scene.lifecycle.decide('t-a1', 'r-a1', approve('req-a1', true), opts)
  assert.equal(first.reviews[0]?.status, 'approved')
  assert.equal(first.decisions[0]?.consent, true)
  assert.equal(first.decisions[0]?.grants.length, 1)

  // Вторая задача — дневной лимит исчерпан.
  await assert.rejects(
    scene.lifecycle.decide('t-b1', 'r-b1', approve('req-b1', true), opts),
    (error: unknown) => {
      assert.ok(error instanceof scene.mod.hostShared.AgentHostError)
      assert.equal(error.code, 'TABLET_APPROVE_LIMIT_REACHED')
      assert.equal(error.status, 429)
      assert.match(error.message, /limit/)
      return true
    },
  )

  // Использовано ровно одно подтверждение.
  assert.equal(await scene.mod.count.tabletApproveUsed(new Date(scene.now())), 1)
  // Вторая задача осталась ждать одобрения.
  const untouched = await scene.journal.get('t-b1')
  assert.ok(untouched)
  assert.equal(untouched.state, 'awaiting_review')
  assert.equal(untouched.reviews[0]?.status, 'pending')
  assert.equal(untouched.decisions.length, 0)
})

test('платное одобрение с планшета с согласием: consent=true, grant выдан, envelope валиден', async () => {
  const scene = await makeScene(Date.parse('2026-10-07T12:00:00Z'))
  await scene.journal.create(makeTask('t-c1', 'r-c1', scene.now(), true))

  const decided = await scene.lifecycle.decide('t-c1', 'r-c1', approve('req-c1', true), { tablet: true })

  assert.equal(decided.reviews[0]?.status, 'approved')
  const decision = decided.decisions[0]
  assert.ok(decision)
  assert.equal(decision.consent, true)
  assert.equal(decision.grants.length, 1)
  assert.equal(decision.grants[0]?.connectionId, 'local-fal')
  assert.equal(decision.grants[0]?.tools[0], 'generation.request')
  assert.equal(decision.reviewId, 'r-c1')

  // Процесс задачи не был запущен до решения — decide обязана была его запустить.
  assert.ok(scene.started.has('t-c1'))
  assert.equal(scene.sent.length, 1)

  // То же самое решение обязано пройти валидатор протокола в сторону агента:
  // writeAgentEnvelope в проде проверяет ровно этим assertEnvelope.
  const envelope = scene.sent[0]?.message
  assert.ok(envelope)
  assert.equal(envelope.type, 'review.decision')
  assert.doesNotThrow(() => scene.validator.assertEnvelope(envelope, 'host-to-agent'))
  assert.equal(envelope.payload.consent, true)
  assert.equal((envelope.payload.grants as unknown[]).length, 1)
})

test('десктопное платное одобрение согласия не требует и не несёт ключа consent', async () => {
  const scene = await makeScene(Date.now())
  await scene.journal.create(makeTask('t-d1', 'r-d1', scene.now(), true))

  // Без всякого tablet — обычный десктопный approve.
  const decided = await scene.lifecycle.decide('t-d1', 'r-d1', approve('req-d1'), {})

  const decision = decided.decisions[0]
  assert.ok(decision)
  assert.ok(!('consent' in decision), 'десктопное одобрение не должно содержать consent')
  assert.equal(decision.grants.length, 1)

  const envelope = scene.sent[0]?.message
  assert.ok(envelope)
  assert.equal(envelope.type, 'review.decision')
  assert.doesNotThrow(() => scene.validator.assertEnvelope(envelope, 'host-to-agent'))
  assert.ok(!('consent' in envelope.payload))
})

test('бесплатное одобрение с планшета не требует согласия', async () => {
  const scene = await makeScene(Date.now())
  await scene.journal.create(makeTask('t-e1', 'r-e1', scene.now(), false))

  // С планшета, но без generationSpec — оплачиваемый grant не выдаётся,
  // значит платить не за что, и согласия не спрашивается.
  const decided = await scene.lifecycle.decide('t-e1', 'r-e1', approve('req-e1'), { tablet: true })

  const decision = decided.decisions[0]
  assert.ok(decision)
  assert.equal(decision.grants.length, 0)
  assert.ok(!('consent' in decision), 'бесплатное одобрение не должно содержать consent')
  assert.equal(decided.state, 'running')
})
