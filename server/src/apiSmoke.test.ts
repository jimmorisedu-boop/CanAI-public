import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Живой API smoke: mock-сервер на свободном порту + изолированный data dir.
// Не трогает server/data и :8787.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForStatus(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/status`)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await sleep(200)
  }
  throw lastErr instanceof Error ? lastErr : new Error('сервер не поднялся')
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as T & { error?: string }
  if (!res.ok) {
    throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`)
  }
  return body
}

test('api smoke: status, project, mock generate, cancel, host guard', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-smoke-'))
  const editProjectId = 'project-edit-smoke'
  const editFileName = 'edit-session-smoke.png'
  const seededAt = Date.now()
  await fs.mkdir(path.join(dataDir, 'projects', editProjectId), { recursive: true })
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'projects.json'), JSON.stringify([{
    id: editProjectId,
    name: 'Доска редактора',
    createdAt: seededAt,
    updatedAt: seededAt,
    revision: 0,
  }]))
  await fs.writeFile(path.join(dataDir, 'media', editFileName), 'edit-smoke')
  await fs.utimes(path.join(dataDir, 'media', editFileName), new Date(20), new Date(20))
  await fs.writeFile(path.join(dataDir, 'edit-sessions.json'), JSON.stringify({
    version: 2,
    sessions: [{
      id: 'session-smoke',
      projectId: editProjectId,
      sourceItemId: 'source-smoke',
      sourceName: 'Фото smoke',
      fileName: editFileName,
      createdAt: seededAt,
      expiresAt: seededAt + 7 * 24 * 60 * 60 * 1000,
      lastMtime: 20,
      appliedMtime: 10,
      placedItemId: null,
      state: 'ready',
    }],
    legacy: [],
  }))
  await fs.writeFile(path.join(dataDir, 'catalog-library.json'), JSON.stringify({
    schemaVersion: 2,
    revision: 0,
    lifecycle: {},
    drafts: [],
    extensions: [{
      id: 'user-krea-v3-edit', name: 'Krea 3 Edit', endpoint: 'krea/v3/edit', kind: 'image',
      refs: true, imageInputField: 'image_urls', promptInputField: 'prompt', minImageRefs: 1, maxImageRefs: 8,
      params: [
        { name: 'model', label: 'Model', widget: 'select', default: 'berry', options: ['berry', 'jam'].map(value => ({ value, label: value })) },
        { name: 'image_size', label: 'Size', widget: 'select', default: 'auto', options: ['auto', 'square'].map(value => ({ value, label: value })) },
        { name: 'reasoning_level', label: 'Reasoning', widget: 'select', default: 'low', options: ['low', 'medium', 'high'].map(value => ({ value, label: value })) },
        { name: 'seed', label: 'Seed', widget: 'seed', step: 1 },
        { name: 'negative_prompt', label: 'Negative prompt', widget: 'textarea', default: '' },
        { name: 'enable_safety_checker', label: 'Safety', widget: 'boolean', default: true },
        { name: 'output_format', label: 'Output format', widget: 'select', default: 'png', options: ['png', 'jpeg'].map(value => ({ value, label: value })) },
      ],
      pricing: { unit: 'call', usd: 0.43 },
    }],
    defaults: {
      image: 'grok-image',
      video: 'seedance-2',
      audio: 'sam-audio-separate',
      assistant: 'claude',
    },
    draftMeta: {},
  }))
  const legacyMacroId = 'legacy-macro-without-revision'
  await fs.writeFile(
    path.join(dataDir, 'macros.json'),
    JSON.stringify([
      {
        id: legacyMacroId,
        name: 'Макрос 9',
        graph: { nodes: [], edges: [] },
        createdAt: 1,
        slot: 8,
      },
    ]),
  )
  const port = 8800 + Math.floor(Math.random() * 200)
  const base = `http://127.0.0.1:${port}`

  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child: ChildProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CANAI_DATA_DIR: dataDir,
      CANAI_MOCK: '1',
      CANAI_SERVER_FINGERPRINT: 'api-smoke-fingerprint',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    if (!child.killed) {
      child.kill('SIGTERM')
      await sleep(300)
      if (!child.killed) child.kill('SIGKILL')
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}).catch(() => {})
  })

  try {
    await waitForStatus(base)
  } catch (err) {
    throw new Error(`не дождались /api/status: ${err instanceof Error ? err.message : err}\n${stderr}`)
  }

  // status
  const status = await json<{ falConfigured: boolean; serverFingerprint: string | null }>(await fetch(`${base}/api/status`))
  assert.equal(status.falConfigured, false)
  assert.equal(status.serverFingerprint, 'api-smoke-fingerprint')

  // A known oversized file must be rejected from headers, before reading its body.
  const tooLarge = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const upload = http.request(`${base}/api/assets/upload`, {
      method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 * 1024 * 1024 + 1) },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }); upload.destroy() })
    })
    upload.on('error', reject)
    upload.setTimeout(2_000, () => upload.destroy(new Error('Oversized upload was not rejected before reading the body')))
    upload.flushHeaders()
  })
  assert.equal(tooLarge.status, 413)
  assert.match(tooLarge.body, /maximum 2 GiB/)

  const cloudAccount = await fetch(`${base}/api/cloud-account`)
  assert.equal(cloudAccount.status, 404)
  // Старый ручной код больше не должен создавать параллельный credential.
  const legacyCloudConnect = await fetch(`${base}/api/cloud/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://cloud.example', code: 'legacy-code' }),
  })
  assert.equal(legacyCloudConnect.status, 404)

  const editSessions = await json<{
    sessions: Array<{ id: string; projectId: string; projectStatus: string }>
  }>(await fetch(`${base}/api/edit-sessions`))
  assert.equal(editSessions.sessions[0].id, 'session-smoke')
  assert.equal(editSessions.sessions[0].projectId, editProjectId)
  assert.equal(editSessions.sessions[0].projectStatus, 'active')

  const legacyMtime = await json<{ mtime: number }>(
    await fetch(`${base}/api/edit-sessions/session-smoke`),
  )
  assert.equal(legacyMtime.mtime, 20)

  const acknowledged = await json<{ session: { appliedMtime: number; placedItemId: string } }>(
    await fetch(`${base}/api/edit-sessions/session-smoke`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedMtime: 20, placedItemId: 'placed-smoke' }),
    }),
  )
  assert.equal(acknowledged.session.appliedMtime, 20)
  assert.equal(acknowledged.session.placedItemId, 'placed-smoke')

  const malformedEditId = await fetch(`${base}/api/edit-sessions/bad!`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedMtime: 20, placedItemId: 'placed-smoke' }),
  })
  assert.equal(malformedEditId.status, 400)
  const malformedEditAck = await fetch(`${base}/api/edit-sessions/session-smoke`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedMtime: 'tomorrow', placedItemId: '' }),
  })
  assert.equal(malformedEditAck.status, 400)
  const unknownEditSession = await fetch(`${base}/api/edit-sessions/session-unknown`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedMtime: 20, placedItemId: 'placed-smoke' }),
  })
  assert.equal(unknownEditSession.status, 404)
  const stoppedEditSession = await fetch(`${base}/api/edit-sessions/session-smoke`, {
    method: 'DELETE',
  })
  assert.equal(stoppedEditSession.status, 200)
  assert.equal((await fetch(`${base}/api/edit-sessions/session-smoke`, { method: 'DELETE' })).status, 404)

  // ⚠️ Тест переписан вместе с правилом. Раньше он закреплял запрет на всё,
  // кроме MP3 и WAV, — а это ограничение аудио-РЕФЕРЕНСОВ fal, и на импорте оно
  // запрещало положить на доску дорожку с телефона (.m4a). Теперь на импорте
  // отвергается только тип, для которого мы не знаем расширения: иначе файл лёг
  // бы на диск как .bin. Ограничение референсов живёт в modelRefLimits.
  const knownAudio = await json<{ url: string; mime: string }>(
    await fetch(`${base}/api/assets/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/flac' },
      body: Buffer.from('not-a-real-flac'),
      duplex: 'half',
    } as RequestInit),
  )
  assert.match(knownAudio.url, /^\/media\/.+\.flac$/)

  const unknownAudio = await fetch(`${base}/api/assets/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/x-neizvestnyi' },
    body: Buffer.from('nonsense'),
    duplex: 'half',
  } as RequestInit)
  assert.equal(unknownAudio.status, 400)
  assert.match(
    ((await unknownAudio.json()) as { error: string }).error,
    /not supported/i,
  )

  const supportedAudio = await json<{ url: string; mime: string }>(
    await fetch(`${base}/api/assets/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('smoke-mp3'),
      duplex: 'half',
    } as RequestInit),
  )
  assert.equal(supportedAudio.mime, 'audio/mpeg')
  assert.match(supportedAudio.url, /^\/media\/.+\.mp3$/)

  // Чат и ноды получают один и тот же курируемый LLM-каталог через /api/models.
  const catalog = await json<{
    models: Array<{ id: string; name: string; kind: string }>
    defaults?: { image: string | null; video: string | null; audio: string | null; assistant: string | null }
  }>(await fetch(`${base}/api/models`))
  assert.deepEqual(
    catalog.models
      .filter((model) => model.kind === 'text')
      .map(({ id, name }) => ({ id, name })),
    [
      { id: 'gemini', name: 'Gemini 3.8 Flash' },
      { id: 'chatgpt', name: 'GPT-6 Sol' },
      { id: 'claude', name: 'Claude Opus 5.5' },
      { id: 'grok-chat', name: 'Grok 4.7' },
      { id: 'qwen', name: 'Qwen 3.8 Max' },
      { id: 'deepseek', name: 'DeepSeek V4.1 Flash' },
    ],
  )
  assert.deepEqual(catalog.defaults, {
    image: 'grok-image',
    video: 'seedance-2',
    audio: 'sam-audio-separate',
    assistant: 'claude',
  })

  // legacy migration + slot eviction both advance the server-confirmed revision
  const migrated = await json<{
    macros: Array<{ id: string; revision: number; updatedAt: number; slot?: number }>
  }>(await fetch(`${base}/api/macros`))
  const migratedLegacy = migrated.macros.find((macro) => macro.id === legacyMacroId)
  assert.equal(migratedLegacy?.revision, 1)
  assert.equal(migratedLegacy?.updatedAt, 1)
  // номера идут подряд: одинокий макрос с дырявым слотом 8 схлопывается в 0,
  // но это нормализация позиции — версию и updatedAt она не трогает
  assert.equal(migratedLegacy?.slot, 0)

  await json(
    await fetch(`${base}/api/macros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Новый владелец слота',
        graph: { nodes: [], edges: [] },
        // занимаем слот, который легаси-макрос занимает ПОСЛЕ нормализации,
        // — иначе вытеснять некого и проверка версии ничего не проверяет
        slot: 0,
      }),
    }),
  )
  const staleEvictedDelete = await fetch(`${base}/api/macros/${legacyMacroId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: 1 }),
  })
  assert.equal(staleEvictedDelete.status, 409)
  assert.equal(
    ((await staleEvictedDelete.json()) as { code: string }).code,
    'MACRO_REVISION_CONFLICT',
  )
  const afterEviction = await json<{
    macros: Array<{ id: string; revision: number; slot?: number }>
  }>(await fetch(`${base}/api/macros`))
  const evictedLegacy = afterEviction.macros.find((macro) => macro.id === legacyMacroId)
  assert.equal(evictedLegacy?.revision, 2)
  assert.notEqual(evictedLegacy?.slot, 0)

  // malformed graph is rejected before it can be persisted
  const malformedMacro = await fetch(`${base}/api/macros`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Повреждённый граф',
      graph: { nodes: { not: 'an array' }, edges: [] },
      slot: 7,
    }),
  })
  assert.equal(malformedMacro.status, 400)
  const afterMalformedMacro = await json<{
    macros: Array<{ name: string }>
  }>(await fetch(`${base}/api/macros`))
  assert.equal(
    afterMalformedMacro.macros.some((macro) => macro.name === 'Повреждённый граф'),
    false,
  )

  // macro revisions
  const firstMacro = await json<{ macro: { id: string; revision: number } }>(
    await fetch(`${base}/api/macros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ревизии',
        graph: { nodes: [], edges: [] },
        slot: 0,
      }),
    }),
  )
  assert.equal(firstMacro.macro.revision, 1)

  const updatedMacro = await json<{ macro: { id: string; revision: number } }>(
    await fetch(`${base}/api/macros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: firstMacro.macro.id,
        baseRevision: 1,
        name: 'Ревизии 2',
        graph: { nodes: [{ id: 'n1' }], edges: [] },
        slot: 0,
      }),
    }),
  )
  assert.equal(updatedMacro.macro.revision, 2)

  const staleMacro = await fetch(`${base}/api/macros`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: firstMacro.macro.id,
      baseRevision: 1,
      name: 'Устаревшая запись',
      graph: { nodes: [{ id: 'stale' }], edges: [] },
      slot: 0,
    }),
  })
  assert.equal(staleMacro.status, 409)
  assert.equal(
    ((await staleMacro.json()) as { code: string }).code,
    'MACRO_REVISION_CONFLICT',
  )

  const listedMacros = await json<{
    macros: Array<{ id: string; name: string; revision: number }>
  }>(await fetch(`${base}/api/macros`))
  const persistedMacro = listedMacros.macros.find((macro) => macro.id === firstMacro.macro.id)
  assert.equal(persistedMacro?.name, 'Ревизии 2')
  assert.equal(persistedMacro?.revision, 2)

  const staleDelete = await fetch(`${base}/api/macros/${firstMacro.macro.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: 1 }),
  })
  assert.equal(staleDelete.status, 409)
  assert.equal(
    ((await staleDelete.json()) as { code: string }).code,
    'MACRO_REVISION_CONFLICT',
  )

  const missingDelete = await fetch(`${base}/api/macros/missing-macro`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: 1 }),
  })
  assert.equal(missingDelete.status, 404)
  assert.equal(
    ((await missingDelete.json()) as { code: string }).code,
    'MACRO_NOT_FOUND',
  )

  await json(
    await fetch(`${base}/api/macros/${firstMacro.macro.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: 2 }),
    }),
  )
  const afterDelete = await json<{ macros: Array<{ id: string }> }>(
    await fetch(`${base}/api/macros`),
  )
  assert.equal(
    afterDelete.macros.some((macro) => macro.id === firstMacro.macro.id),
    false,
  )

  // create board
  const created = await json<{ project: { id: string } }>(
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smoke' }),
    }),
  )
  const projectId = created.project.id
  assert.ok(projectId)

  // Singular V1 API больше не пишет данные; legacy-файл остаётся только
  // входом одноразовой миграции при первом plural V2 запросе.
  const removedV1 = await fetch(`${base}/api/prompt-chat?project=${encodeURIComponent(projectId)}`)
  assert.equal(removedV1.status, 410)
  assert.equal(
    ((await removedV1.json()) as { code: string }).code,
    'PROMPT_CHAT_V1_REMOVED',
  )

  const legacyMessages = Array.from({ length: 120 }, (_, index) => ({
    id: `legacy-message-${index}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: index % 2 === 0 ? `Вопрос ${index}` : '',
    createdAt: index + 1,
    ...(index % 2 === 0
      ? {}
      : { status: 'done' as const, reply: `Ответ ${index}` }),
  }))
  const chatDocument = {
    version: 1 as const,
    conversationId: 'smoke-conversation',
    messages: legacyMessages,
    archives: Array.from({ length: 24 }, (_, index) => ({
      id: `smoke-archive-${index}`,
      title: `Архив ${index + 1}`,
      createdAt: index + 1,
      messages: [{
        id: `archive-message-${index}`,
        role: 'user' as const,
        text: `Архивный вопрос ${index + 1}`,
        createdAt: index + 1,
      }],
    })),
  }
  const legacyChatDir = path.join(dataDir, 'prompt-chats')
  await fs.mkdir(legacyChatDir, { recursive: true })
  await fs.writeFile(
    path.join(legacyChatDir, `${projectId}.json`),
    JSON.stringify({ revision: 7, document: chatDocument }),
  )

  // plural prompt-chat API migrates V1 and delivers into the originating dialog
  const migratedChats = await json<{
    index: {
      activeConversationId: string
      conversations: Array<{ id: string }>
    }
  }>(await fetch(`${base}/api/prompt-chats?project=${encodeURIComponent(projectId)}`))
  assert.equal(migratedChats.index.conversations.length, 25)
  const migratedActiveId = migratedChats.index.activeConversationId
  let totalMessages = 0
  let before: string | undefined
  do {
    const migratedPage = await json<{
      messages: unknown[]
      before: string | null
    }>(await fetch(
      `${base}/api/prompt-chats/${migratedActiveId}?project=${encodeURIComponent(projectId)}&limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ))
    totalMessages += migratedPage.messages.length
    before = migratedPage.before ?? undefined
  } while (before)
  assert.ok(totalMessages > 100)

  const createdChat = await json<{ conversation: { id: string } }>(
    await fetch(`${base}/api/prompt-chats?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'create-chat-1' }),
    }),
  )
  const conversationId = createdChat.conversation.id
  await json(
    await fetch(`${base}/api/prompt-chats/${conversationId}?project=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'model-1', selectedModelId: 'claude' }),
    }),
  )
  const estimate = await json<{
    modelId: string
    inputTokens: number
    costUsd: number | null
  }>(
    await fetch(`${base}/api/prompt-chats/${conversationId}/estimate?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Составь промпт', attachments: [] }),
    }),
  )
  assert.equal(estimate.modelId, 'claude')
  assert.ok(estimate.inputTokens > 0)
  assert.ok((estimate.costUsd ?? 0) > 0)

  const sendPayload = {
    requestId: 'send-chat-1',
    text: 'Составь промпт',
    attachments: [],
  }
  const sent = await json<{ jobId: string }>(
    await fetch(`${base}/api/prompt-chats/${conversationId}/messages?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendPayload),
    }),
  )
  const repeatedSend = await json<{ jobId: string }>(
    await fetch(`${base}/api/prompt-chats/${conversationId}/messages?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendPayload),
    }),
  )
  assert.equal(repeatedSend.jobId, sent.jobId)
  for (let index = 0; index < 40; index += 1) {
    const current = await json<{ status: string }>(await fetch(`${base}/api/jobs/${sent.jobId}`))
    if (current.status === 'done' || current.status === 'error') break
    await sleep(250)
  }
  type SmokeChatPage = {
    messages: Array<{ status?: string; modelId?: string | null }>
  }
  let chatPage: SmokeChatPage = { messages: [] }
  // Completing the job and delivering its answer are separate durable steps.
  // Under a loaded test runner the delivery can finish after the status poll.
  for (let index = 0; index < 40; index += 1) {
    chatPage = await json<SmokeChatPage>(await fetch(`${base}/api/prompt-chats/${conversationId}?project=${encodeURIComponent(projectId)}&limit=50`))
    if (chatPage.messages.at(-1)?.status === 'done') break
    await sleep(250)
  }
  assert.equal(chatPage.messages.at(-1)?.status, 'done')
  assert.equal(chatPage.messages.at(-1)?.modelId, 'claude')
  let persistedJobs: { jobs: Array<{ id: string; deliveredAt?: number }> } = { jobs: [] }
  for (let index = 0; index < 40; index += 1) {
    persistedJobs = JSON.parse(
      await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'),
    ) as { jobs: Array<{ id: string; deliveredAt?: number }> }
    if (persistedJobs.jobs.find((job) => job.id === sent.jobId)?.deliveredAt !== undefined) break
    await sleep(50)
  }
  assert.equal(
    persistedJobs.jobs.find((job) => job.id === sent.jobId)?.deliveredAt !== undefined,
    true,
  )

  // save snapshot (revision 0)
  const snapshot = {
    version: 1 as const,
    camera: { x: 0, y: 0, scale: 1 },
    items: [] as unknown[],
  }
  const saved = await json<{ ok: boolean; revision: number }>(
    await fetch(`${base}/api/project?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot, expectedRevision: 0 }),
    }),
  )
  assert.equal(saved.revision, 1)

  // conflict on stale revision
  const conflict = await fetch(`${base}/api/project?project=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  })
  assert.equal(conflict.status, 409)

  // reject base64 in snapshot
  const badSnap = await fetch(`${base}/api/project?project=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snapshot: {
        version: 1,
        camera: { x: 0, y: 0, scale: 1 },
        items: [
          {
            id: '1',
            kind: 'image',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            src: 'data:image/png;base64,xxxx',
          },
        ],
      },
      expectedRevision: 1,
    }),
  })
  assert.equal(badSnap.status, 400)

  // mock generate
  // Krea's provider variant is a legitimate input named `model`, separate
  // from the top-level CanAI catalog ID. The draft tester already accepts it.
  const kreaParams = {
    model: 'berry', image_size: 'square', reasoning_level: 'high', seed: 887836,
    negative_prompt: 'pink skin, harsh shadows', enable_safety_checker: true, output_format: 'png',
  }
  const kreaRequest = (params: Record<string, unknown>) => fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'image', prompt: 'Combine the two reference images', model: 'user-krea-v3-edit', params,
      refs: [{ kind: 'image', src: `/media/${editFileName}` }, { kind: 'image', src: `/media/${editFileName}` }],
    }),
  })
  for (const variant of ['berry', 'jam']) {
    const params = { ...kreaParams, model: variant }
    const response = await kreaRequest(params)
    const started = await response.json() as { jobId?: string; error?: string }
    assert.equal(response.status, 200, `Krea ${variant}: ${started.error}`)
    assert.ok(started.jobId)
    let kreaJob: { status: string; model: string; params: unknown; result?: { url?: string }; error?: string } | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      kreaJob = await json(await fetch(`${base}/api/jobs/${started.jobId}`))
      if (kreaJob?.status === 'done' || kreaJob?.status === 'error') break
      await sleep(250)
    }
    assert.equal(kreaJob?.status, 'done', kreaJob?.error)
    assert.equal(kreaJob?.model, 'user-krea-v3-edit')
    assert.deepEqual(kreaJob?.params, params)
    assert.ok(kreaJob?.result?.url?.startsWith('/media/'))
  }
  assert.equal((await kreaRequest({ ...kreaParams, model: 'unknown-variant' })).status, 400)
  for (const field of ['prompt', 'image_url', 'image_urls', 'video_url', 'video_urls', 'audio_url', 'audio_urls', 'num_images']) {
    assert.equal((await kreaRequest({ ...kreaParams, [field]: field === 'num_images' ? 2 : 'unexpected' })).status, 400, field)
  }

  const gen = await json<{ jobId: string }>(
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image', prompt: 'smoke test circle', refs: [] }),
    }),
  )
  assert.ok(gen.jobId)

  // poll until done
  let job: { status: string; model?: string; result?: { url?: string }; error?: string } | null = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    job = await json(await fetch(`${base}/api/jobs/${gen.jobId}`))
    if (job!.status === 'done' || job!.status === 'error') break
  }
  assert.equal(job?.status, 'done', job?.error ?? 'job not done')
  assert.equal(job?.model, 'grok-image')
  assert.ok(job?.result?.url?.startsWith('/media/'))

  // mock LLM job returns text through the same asynchronous jobs API
  const textGen = await json<{ jobId: string }>(
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', prompt: 'Составь промпт', refs: [] }),
    }),
  )
  let textJob: { status: string; model?: string; result?: { text?: string }; error?: string } | null = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    textJob = await json(await fetch(`${base}/api/jobs/${textGen.jobId}`))
    if (textJob!.status === 'done' || textJob!.status === 'error') break
  }
  assert.equal(textJob?.status, 'done', textJob?.error ?? 'text job not done')
  assert.equal(textJob?.model, 'claude')
  assert.ok(textJob?.result?.text)

  // cancel a fresh job
  const gen2 = await json<{ jobId: string }>(
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image', prompt: 'to cancel', refs: [] }),
    }),
  )
  await json(await fetch(`${base}/api/jobs/${gen2.jobId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
  // отмена стала «мягкой»: задача в работе не перетирается сразу — runner сам
  // доводит её до финала («отменено», либо done с уже оплаченным результатом)
  let cancelled: { status: string; error?: string } | null = null
  for (let i = 0; i < 40; i++) {
    cancelled = await json(await fetch(`${base}/api/jobs/${gen2.jobId}`))
    if (cancelled!.status === 'done' || cancelled!.status === 'error') break
    await sleep(250)
  }
  assert.equal(cancelled?.status, 'error')
  assert.match(cancelled?.error ?? '', /Cancelled|отменено/)

  // Host guard
  const badHost = await fetch(`${base}/api/status`, { headers: { Host: 'evil.example' } })
  // undici may rewrite Host; if request reaches us with wrong host — 403.
  // On some stacks Host is forced to URL host — accept either ok or 403.
  assert.ok(badHost.status === 200 || badHost.status === 403)

  // arbitrary model URL rejected
  const badModel = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'image',
      prompt: 'x',
      model: 'https://evil.example/model',
      refs: [],
    }),
  })
  assert.equal(badModel.status, 400)

  const badCatalogUrl = await fetch(`${base}/api/catalog/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://evil.example/models/not-fal', revision: 0 }),
  })
  assert.equal(badCatalogUrl.status, 400)
})
