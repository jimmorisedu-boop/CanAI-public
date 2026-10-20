import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

// Находка 7 аудита моделей 19.10.2026: resolveModel молча увозил ролик или
// звук к другой модели — MiniMax H3 с роликом запускался как Seedance «по
// референсам», за другие деньги. Маршрут и макросы отказывали раньше, но
// любая новая дорога запуска попала бы сюда.

const video = { kind: 'video' as const, src: '/media/clip.mp4' }
const audio = { kind: 'audio' as const, src: '/media/voice.mp3' }
const image = { kind: 'image' as const, src: '/media/frame.png' }

test('новая задача с роликом к модели без роликов не уезжает в другую семью', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-refs-guard-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  process.env.CANAI_MOCK = '1'
  const [{ jobs }, runner, guard, { apiRouter }] = await Promise.all([
    import('./jobs.js'), import('./runner.js'), import('./jobRefsGuard.js'), import('./routes.js'),
  ])
  const app = express()
  app.use(express.json())
  app.use('/api', apiRouter)
  const http = app.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    for (const job of jobs.all()) jobs.remove(job.id)
    await jobs.persistNow()
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  await t.test('запуск отвечает словами и ничего не генерирует', async () => {
    const job = jobs.create('video', 'танец', [video], 'minimax-h3', {})
    await runner.runJob(job)
    assert.equal(job.status, 'error')
    assert.match(job.error ?? '', /MiniMax H3 Max.*does not accept video/u)
    assert.equal(job.result, undefined)
  })

  await t.test('звук к Grok Video — тоже отказ, а не правка ролика без дорожки', async () => {
    const job = jobs.create('video', 'танец', [image, audio], 'grok', {})
    await runner.runJob(job)
    assert.equal(job.status, 'error')
    assert.match(job.error ?? '', /Grok Video.*does not accept audio/u)
  })

  await t.test('своя семья по-прежнему работает: Seedance с роликом уходит «по референсам»', async () => {
    const job = jobs.create('video', 'танец', [image, video], 'seedance-2', {})
    await runner.runJob(job)
    assert.equal(job.status, 'done', job.error)
  })

  await t.test('маршрут /generate называет настоящую причину, а не «Parameters do not match»', async () => {
    // параметры — родные для MiniMax: сверка с чужой моделью их не узнавала
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'video', model: 'minimax-h3', prompt: 'танец', refs: [video], params: { resolution: '768P' } }),
    })
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /MiniMax H3 Max.*does not accept video/u)
  })

  await t.test('уже отправленное провайдеру восстановление не отказывает', () => {
    const job = jobs.create('video', 'танец', [video], 'minimax-h3', {})
    assert.match(guard.newJobRefsRefusal(job, job.refs) ?? '', /does not accept video/u)
    job.falRequestId = 'paid-request'
    assert.equal(guard.newJobRefsRefusal(job, job.refs), null)
    jobs.remove(job.id)
  })

  await t.test('закреплённую агентом модель проверяют другие', () => {
    const pinned = jobs.create('video', 'танец', [video], 'minimax-h3', {})
    pinned.modelSnapshot = { id: 'minimax-h3', name: 'MiniMax H3 Max', kind: 'video', endpoint: 'minimax/h3-max/text-to-video', params: [] }
    assert.equal(guard.newJobRefsRefusal(pinned, pinned.refs), null)
    jobs.remove(pinned.id)
  })
})
