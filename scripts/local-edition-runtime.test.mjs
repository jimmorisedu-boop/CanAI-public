import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { removeOwnedTemp } from './prepare-public-release-artifacts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const local = await fs.readFile(path.join(root, 'PUBLIC-SOURCE-MANIFEST.json'), 'utf8').then(text => JSON.parse(text).edition === 'local', () => false)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('local production runtime: Cloud absent, local save/generation/cancel and restart work', { skip: !local, timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-verify-local-runtime-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  let child = null
  let output = ''
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const current = child
    const exited = once(current, 'exit')
    current.kill('SIGTERM')
    await Promise.race([exited, delay(6000)])
    if (current.exitCode === null) {
      current.kill('SIGKILL')
      await exited
    }
    child = null
  }
  t.after(async () => {
    await stop()
    await removeOwnedTemp(dataDir, 'canai-verify-local-runtime-')
  })
  const start = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(root, 'server'),
      env: { ...process.env, PORT: String(port), CANAI_DATA_DIR: dataDir, CANAI_MOCK: '1', FAL_KEY: '', CANAI_REMOTE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000) })
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000) })
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`Local server exited: ${output}`)
      if (await fetch(`${base}/api/status`).then(res => res.ok, () => false)) return
      await delay(150)
    }
    throw new Error(`Local server did not start: ${output}`)
  }
  const json = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    assert.equal(response.status, 200, `${method} ${route}: ${await response.clone().text()}`)
    return response.json()
  }
  const terminalJob = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await json(`/api/jobs/${id}`)
      if (job.status === 'done' || job.status === 'error') return job
      await delay(150)
    }
    throw new Error(`Mock job did not finish: ${id}`)
  }
  await start()
  const status = await json('/api/status')
  assert.equal(status.mockMode, true)
  assert.equal(status.falConfigured, false)
  for (const route of ['/api/cloud-account', '/api/cloud-mirror', '/api/cloud-board/socket', '/api/cloud/pairing', '/api/cloud-account/projects']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route)
  }
  assert.equal((await fetch(`${base}/api/cloud-account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404)
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
  const badHost = await new Promise((resolve, reject) => {
    http.get(`${base}/api/status`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
  })
  assert.equal(badHost, 403)
  const { project } = await json('/api/projects', { name: 'Local edition regression' })
  const route = `/api/project?project=${encodeURIComponent(project.id)}`
  const snapshot = { version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [{ id: 'text', kind: 'text', x: 10, y: 20, w: 200, h: 60, text: 'Saved local content' }] }
  assert.equal((await json(route, { snapshot, expectedRevision: 0 })).revision, 1)
  assert.deepEqual((await json(route)).snapshot, snapshot)
  const conflict = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot, expectedRevision: 0 }) })
  assert.equal(conflict.status, 409)
  const unsafe = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'image', prompt: 'test', model: 'https://untrusted.example/model', refs: [] }) })
  assert.equal(unsafe.status, 400)
  const generation = await json('/api/generate', { kind: 'image', prompt: 'local production regression', refs: [] })
  const job = await terminalJob(generation.jobId)
  assert.equal(job.status, 'done', job.error)
  assert.match(job.result.url, /^\/media\//u)
  assert.equal((await fetch(`${base}${job.result.url}`)).status, 200)
  const cancelled = await json('/api/generate', { kind: 'image', prompt: 'cancel regression', refs: [] })
  await json(`/api/jobs/${cancelled.jobId}/cancel`, {})
  const cancelledJob = await terminalJob(cancelled.jobId)
  assert.equal(cancelledJob.status, 'error')
  assert.match(cancelledJob.error, /Cancelled|отменено/u)
  await stop()
  await start()
  assert.deepEqual((await json(route)).snapshot, snapshot)
  assert.equal((await json(`/api/jobs/${generation.jobId}`)).status, 'done')
  assert.equal((await fetch(`${base}${job.result.url}`)).status, 200)
})
