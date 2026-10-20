import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-project-routes-'))
const previousDataDir = process.env.CANAI_DATA_DIR
process.env.CANAI_DATA_DIR = dataDir

const { projectRouter } = await import('./projectRoutes.js')

test('PATCH /api/projects/:id обновляет только допустимые поля доски', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api', projectRouter)
  const server = http.createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previousDataDir
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Исходное' }),
  })
  assert.equal(created.status, 200)
  const { project } = await created.json() as { project: { id: string } }

  const save = (snapshot: unknown, expectedRevision: number, conflictKey?: string) => fetch(
    `${base}/api/project?project=${project.id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot, expectedRevision, conflictKey }),
    },
  )
  const firstSnapshot = {
    version: 1,
    items: [{ id: 'first', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'серверная ветка' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  assert.equal((await save(firstSnapshot, 0)).status, 200)

  // A structurally valid /media link is not enough: acknowledge a save only
  // when its bytes exist in this installation. The revision must remain
  // untouched so the caller can restore the file and retry safely.
  const missingMediaSnapshot = {
    version: 1,
    items: [{ id: 'missing', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/media/not-on-disk.png' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const missingMediaResponse = await save(missingMediaSnapshot, 1)
  assert.equal(missingMediaResponse.status, 400)
  const missingMediaBody = await missingMediaResponse.json() as {
    code: string
    details: { sources: string[] }
  }
  assert.equal(missingMediaBody.code, 'MISSING_MEDIA')
  assert.deepEqual(missingMediaBody.details.sources, ['/media/not-on-disk.png'])
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'media', 'not-on-disk.png'), Buffer.from('restored'))
  assert.equal((await save(missingMediaSnapshot, 1)).status, 200, 'после возврата байтов сохранение проходит')
  await fs.unlink(path.join(dataDir, 'media', 'not-on-disk.png'))
  const loadedWithMissing = await fetch(`${base}/api/project?project=${encodeURIComponent(project.id)}`)
  assert.equal(loadedWithMissing.status, 200)
  assert.deepEqual(
    (await loadedWithMissing.json() as { missingMedia?: string[] }).missingMedia,
    ['/media/not-on-disk.png'],
    'GET явно сообщает ENOENT, чтобы клиент не принимал доску за здоровую',
  )

  const conflictKey = 'c4d77f33-7839-4f0d-bf90-5f41ebc958bb'
  const staleSnapshot = {
    version: 1,
    items: [{ id: 'stale', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'локальная ветка' }],
    camera: { x: 10, y: 0, scale: 1 },
  }
  const conflictResponse = await save(staleSnapshot, 0, conflictKey)
  assert.equal(conflictResponse.status, 409)
  const conflictBody = await conflictResponse.json() as {
    code: string
    details: {
      serverRevision: number
      recoveryProject: { id: string; name: string; revision: number }
    }
  }
  assert.equal(conflictBody.code, 'PROJECT_CONFLICT')
  assert.equal(conflictBody.details.serverRevision, 2)
  assert.equal(conflictBody.details.recoveryProject.id, `conflict-${conflictKey}`)

  const recovered = await fetch(
    `${base}/api/project?project=${encodeURIComponent(conflictBody.details.recoveryProject.id)}`,
  )
  assert.equal(recovered.status, 200)
  assert.deepEqual((await recovered.json() as { snapshot: unknown }).snapshot, staleSnapshot)

  const repeatedSnapshot = {
    ...staleSnapshot,
    camera: { x: 20, y: 0, scale: 1 },
  }
  const repeatedResponse = await save(repeatedSnapshot, 0, conflictKey)
  assert.equal(repeatedResponse.status, 409)
  const repeatedBody = await repeatedResponse.json() as typeof conflictBody
  assert.equal(repeatedBody.details.recoveryProject.id, conflictBody.details.recoveryProject.id)
  assert.equal(repeatedBody.details.recoveryProject.revision, 1)

  const projectsResponse = await fetch(`${base}/api/projects`)
  const projects = (await projectsResponse.json() as { projects: Array<{ id: string }> }).projects
  assert.equal(
    projects.filter((candidate) => candidate.id === conflictBody.details.recoveryProject.id).length,
    1,
  )
  const repeatedRecovered = await fetch(
    `${base}/api/project?project=${encodeURIComponent(conflictBody.details.recoveryProject.id)}`,
  )
  assert.deepEqual((await repeatedRecovered.json() as { snapshot: unknown }).snapshot, repeatedSnapshot)

  assert.equal((await save(staleSnapshot, 0, 'not-a-uuid')).status, 400)

  const patch = (body: unknown) => fetch(`${base}/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const pinned = await patch({ pinned: true })
  assert.equal(pinned.status, 200)
  assert.equal((await pinned.json() as { project: { pinned: boolean } }).project.pinned, true)

  const both = await patch({ name: 'Новое', pinned: false })
  assert.equal(both.status, 200)
  const bothProject = (await both.json() as { project: { name: string; pinned: boolean } }).project
  assert.equal(bothProject.name, 'Новое')
  assert.equal(bothProject.pinned, false)

  assert.equal((await patch({})).status, 400)
  assert.equal((await patch({ pinned: 'yes' })).status, 400)
  assert.equal((await patch({ name: '   ' })).status, 400)
  assert.equal((await patch({ unknown: true })).status, 400)
})
