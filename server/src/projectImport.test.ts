import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

test('создание импортированной доски атомарно публикует снимок', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-atomic-import-'))
  process.env.CANAI_DATA_DIR = dir
  process.env.CANAI_ENV_FILE = path.join(dir, 'absent.env')
  process.env.CANAI_MOCK = '1'
  delete process.env.FAL_KEY
  const { projectRouter } = await import('./projectRoutes.js')
  const { createProject, listProjects, loadProjectSnapshot } = await import('./projects.js')
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api', projectRouter)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const resolved = path.resolve(dir)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  const original = await createProject('Исходная доска')
  const snapshot = {
    version: 1,
    items: [{ id: 'picture', kind: 'image', x: 0, y: 0, w: 100, h: 80, src: '/media/picture.png' }],
    camera: { x: 1, y: 2, scale: 1 },
  }
  const post = (body: unknown) => fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  await t.test('отказ записи project.json не публикует проект даже после повторения', async (st) => {
    const writeFile = fs.writeFile
    st.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith(`${path.sep}project.json.tmp`)) throw new Error('simulated disk full')
      return writeFile(...args)
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post({ name: 'Импорт', initialSnapshot: snapshot })
      assert.equal(response.status, 500)
      assert.deepEqual((await listProjects()).map((p) => p.id), [original.id])
      assert.deepEqual(await fs.readdir(path.join(dir, 'projects')), [original.id])
    }
  })

  await t.test('отказ финального индекса убирает только новую папку', async (st) => {
    const rename = fs.rename
    st.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[0]) === path.join(dir, 'projects.json.tmp')) throw new Error('simulated index failure')
      return rename(...args)
    })
    assert.equal((await post({ name: 'Импорт', initialSnapshot: snapshot })).status, 500)
    assert.deepEqual((await listProjects()).map((p) => p.id), [original.id])
    assert.deepEqual(await fs.readdir(path.join(dir, 'projects')), [original.id])
  })

  await t.test('начальный снимок проходит ту же проверку, что сохранение', async () => {
    const invalid = [null, { ...snapshot, items: [{ ...snapshot.items[0], src: 'data:image/png;base64,eA==' }] },
      { ...snapshot, items: Array.from({ length: 20_001 }, () => snapshot.items[0]) }]
    for (const initialSnapshot of invalid) {
      assert.equal((await post({ name: 'Неверная', initialSnapshot })).status, 400)
    }
    assert.deepEqual((await listProjects()).map((p) => p.id), [original.id])
  })

  await t.test('импорт сразу читается целиком; обычная новая доска остаётся пустой', async () => {
    const response = await post({ name: '  Импорт  ', initialSnapshot: snapshot })
    assert.equal(response.status, 200)
    const { project } = await response.json() as { project: { id: string; name: string; revision: number } }
    assert.equal(project.name, 'Импорт')
    assert.deepEqual(await loadProjectSnapshot(project.id), { snapshot, revision: 1 })
    assert.deepEqual(await loadProjectSnapshot(original.id), { snapshot: null, revision: 0 })
  })
})
