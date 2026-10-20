import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForStatus(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/status`)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }

  throw lastError instanceof Error ? lastError : new Error('сервер не поднялся')
}

test('без ключа fal.ai и явного mock-режима генерация не ставится в очередь', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-no-key-'))
  const port = 9200 + Math.floor(Math.random() * 300)
  const base = `http://127.0.0.1:${port}`
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CANAI_DATA_DIR: dataDir,
    CANAI_ENV_FILE: path.join(dataDir, 'server.env'),
    FAL_KEY: '',
  }
  delete env.CANAI_MOCK

  const child: ChildProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env,
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
  } catch (error) {
    throw new Error(
      `не дождались /api/status: ${error instanceof Error ? error.message : error}\n${stderr}`,
    )
  }

  const status = (await (await fetch(`${base}/api/status`)).json()) as {
    falConfigured: boolean
    mockMode: boolean
    instanceId: string
    shuttingDown: boolean
  }
  assert.equal(status.falConfigured, false)
  assert.equal(status.mockMode, false)
  assert.equal(typeof status.instanceId, 'string')
  assert.equal(status.shuttingDown, false)

  const response = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'image', prompt: 'Белый круг на чёрном фоне' }),
  })
  const body = (await response.json()) as { error?: string; jobId?: string }

  assert.equal(response.status, 503)
  assert.match(body.error ?? '', /key fal\.ai/u)
  assert.equal(body.jobId, undefined)

  const created = (await (
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Проверка чата без ключа' }),
    })
  ).json()) as { project: { id: string } }
  const projectId = created.project.id
  const chatsBeforeCreate = (await (
    await fetch(`${base}/api/prompt-chats?project=${encodeURIComponent(projectId)}`)
  ).json()) as {
    index: { activeConversationId: string | null }
  }
  assert.equal(chatsBeforeCreate.index.activeConversationId, null)
  const chatCreated = (await (
    await fetch(`${base}/api/prompt-chats?project=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'create-no-key-chat' }),
    })
  ).json()) as { conversation: { id: string } }
  const conversationId = chatCreated.conversation.id

  const chatResponse = await fetch(
    `${base}/api/prompt-chats/${encodeURIComponent(conversationId)}/messages?project=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'no-key-chat',
        text: 'Составь промпт',
        attachments: [],
      }),
    },
  )
  const chatBody = (await chatResponse.json()) as { error?: string }
  assert.equal(chatResponse.status, 503)
  assert.match(chatBody.error ?? '', /fal\.ai key|fal\.ai key/u)

  const page = (await (
    await fetch(
      `${base}/api/prompt-chats/${encodeURIComponent(conversationId)}?project=${encodeURIComponent(projectId)}&limit=50`,
    )
  ).json()) as { messages: unknown[] }
  assert.deepEqual(page.messages, [])
})

test('лимиты референсов проверяются по эффективной модели до постановки задачи', async () => {
  const limits = await import('./modelRefLimits.js').catch(() => null)
  assert.ok(limits, 'нужна единая серверная проверка лимитов референсов')

  const images = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'image' as const,
      src: `/media/image-${index}.png`,
    }))
  const videos = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'video' as const,
      src: `/media/video-${index}.mp4`,
    }))
  const audios = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'audio' as const,
      src: `/media/audio-${index}.mp3`,
    }))

  assert.equal(limits.validateModelRefs('chatgpt-image-2', 'image', images(16)), null)
  assert.match(
    limits.validateModelRefs('chatgpt-image-2', 'image', images(17)) ?? '',
    /no more than 16 image references/i,
  )
  assert.equal(
    limits.validateModelRefs('seedance-2', 'video', [...images(7), ...videos(2), ...audios(3)]),
    null,
  )
  assert.equal(
    limits.validateModelRefs('seedance-2', 'video', [
      ...images(7),
      ...videos(2),
      ...audios(3),
      { kind: 'text' as const, text: 'контекст не является медиа-референсом' },
    ]),
    null,
  )
  assert.match(
    limits.validateModelRefs('seedance-2', 'video', [...images(10), ...videos(2)]) ?? '',
    /no more than 9 image references/i,
  )
  assert.equal(limits.validateModelRefs('seedance-2-i2v', 'video', images(2)), null)
  assert.match(
    limits.validateModelRefs('seedance-2', 'video', [...images(7), ...videos(2), ...audios(4)]) ?? '',
    /accepts no more than 3$/u,
  )
  assert.match(
    limits.validateModelRefs('seedance-2', 'video', audios(1)) ?? '',
    /requires at least one image or video with audio/u,
  )
  assert.match(
    limits.validateModelRefs('seedance-2', 'video', [
      ...images(1),
      { kind: 'audio' as const, src: '/media/soundtrack.flac' },
    ]) ?? '',
    /MP3.*WAV/i,
  )
  assert.match(
    limits.validateModelRefs('grok', 'video', [...images(1), ...videos(1)]) ?? '',
    /does not accept images/u,
  )
  assert.match(
    limits.validateModelRefs('sam-image', 'other', images(2)) ?? '',
    /no more than 1 image references/u,
  )
  assert.match(
    limits.validateModelRefs('grok-image', 'image', images(4)) ?? '',
    /no more than 3 image references/u,
  )
  // Модель не выбрана — Seedance по умолчанию: три картинки уходят «по
  // референсам», а не отказом «кадров» (аудит моделей 19.10.2026, находка 4;
  // прежде здесь закреплялся отказ «не больше двух»).
  assert.equal(limits.validateModelRefs(undefined, 'video', images(3)), null)
  assert.match(
    limits.validateModelRefs(undefined, 'video', images(10)) ?? '',
    /no more than 9 image references/u,
  )
  assert.equal(
    limits.validateModelRefs('seedance-2-i2v', 'video', videos(1)),
    null,
  )
})

test('параметры проверяются по реально включившейся ref-модели', async () => {
  const module = await import('./modelParams.js').catch(() => null)
  assert.ok(module, 'нужна единая проверка параметров эффективной модели')

  const refs = [{ kind: 'image' as const, src: '/media/start.png' }]
  assert.equal(
    module.validateModelParams('seedance-2', 'video', refs, { resolution: '1080p' }),
    true,
  )
  assert.equal(
    module.validateModelParams('seedance-2', 'video', [], { resolution: '1080p' }),
    true,
  )
})
