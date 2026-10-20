import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('an intentionally empty project index stays empty after startup initialization', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-projects-empty-'))
  const previousDataDir = process.env.CANAI_DATA_DIR
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previousDataDir
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  const {
    createProject,
    deleteProject,
    ensureProjects,
    listProjects,
    loadProjectSnapshot,
    saveProjectSnapshot,
    updateProject,
  } = await import('./projects.js')

  const legacyProject = {
    id: 'legacy-project',
    name: 'Старая доска',
    createdAt: 1,
    updatedAt: 2,
    revision: 0,
  }
  await fs.writeFile(path.join(dir, 'projects.json'), JSON.stringify([legacyProject]))
  assert.equal((await listProjects())[0]?.pinned, false)

  await ensureProjects()
  const initial = await listProjects()
  assert.equal(initial.length, 1)

  const project = await createProject('Опорная доска')
  assert.equal(project.pinned, false)
  const updatedAt = project.updatedAt
  const pinned = await updateProject(project.id, { pinned: true })
  assert.equal(pinned?.pinned, true)
  assert.equal(pinned?.updatedAt, updatedAt)
  assert.equal((await listProjects()).find((item) => item.id === project.id)?.pinned, true)

  const initialSnapshot = { version: 1, items: [], camera: { x: 1, y: 0, scale: 1 } }
  const failedSnapshot = { version: 1, items: [], camera: { x: 2, y: 0, scale: 1 } }
  assert.deepEqual(await saveProjectSnapshot(project.id, initialSnapshot, 0), { status: 'saved', revision: 1 })
  const savedProjectMeta = (await listProjects()).find((item) => item.id === project.id)
  assert.equal(Object.hasOwn(savedProjectMeta ?? {}, 'snapshotFingerprint'), false, 'внутренний hash не входит в API')

  const conflictKey = '9b2ca32f-c155-4c5e-b5db-8273070710de'
  const localConflict = { version: 1, items: [], camera: { x: 9, y: 0, scale: 1 } }
  const firstConflict = await saveProjectSnapshot(project.id, localConflict, 0, conflictKey)
  assert.equal(firstConflict.status, 'conflict')
  if (firstConflict.status !== 'conflict') throw new Error('ожидался конфликт')
  assert.equal(firstConflict.revision, 1)
  assert.equal(firstConflict.recoveryProject.id, `conflict-${conflictKey}`)
  assert.match(firstConflict.recoveryProject.name, /^Опорная доска — conflict copy /)
  assert.deepEqual(await loadProjectSnapshot(project.id), { snapshot: initialSnapshot, revision: 1 })
  assert.deepEqual(await loadProjectSnapshot(firstConflict.recoveryProject.id), {
    snapshot: localConflict,
    revision: 0,
  })

  const newerConflict = { version: 1, items: [], camera: { x: 10, y: 0, scale: 1 } }
  const repeated = await saveProjectSnapshot(project.id, newerConflict, 0, conflictKey)
  assert.equal(repeated.status, 'conflict')
  if (repeated.status !== 'conflict') throw new Error('ожидался повторный конфликт')
  assert.equal(repeated.recoveryProject.id, firstConflict.recoveryProject.id)
  assert.deepEqual(await loadProjectSnapshot(firstConflict.recoveryProject.id), {
    snapshot: newerConflict,
    revision: 1,
  })
  assert.equal(
    (await listProjects()).filter((item) => item.id === firstConflict.recoveryProject.id).length,
    1,
  )

  const otherKey = '8716e395-aa08-4928-8b9b-a582ed3765fd'
  const otherConflict = await saveProjectSnapshot(project.id, localConflict, 0, otherKey)
  assert.equal(otherConflict.status, 'conflict')
  if (otherConflict.status !== 'conflict') throw new Error('ожидался конфликт второй вкладки')
  assert.notEqual(otherConflict.recoveryProject.id, firstConflict.recoveryProject.id)

  const projectDirsBeforeFailedConflict = (await fs.readdir(path.join(dir, 'projects'))).sort()
  const conflictRename = fs.rename
  const conflictRenameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated conflict index write failure')
    }
    return conflictRename(...args)
  })

  await assert.rejects(
    () => saveProjectSnapshot(
      project.id,
      failedSnapshot,
      0,
      '4ca31b88-82ce-46b5-85a9-7c743e763952',
    ),
    /simulated conflict index write failure/,
  )
  conflictRenameMock.mock.restore()
  assert.deepEqual((await fs.readdir(path.join(dir, 'projects'))).sort(), projectDirsBeforeFailedConflict)
  assert.deepEqual(await loadProjectSnapshot(project.id), { snapshot: initialSnapshot, revision: 1 })

  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated save index write failure')
    }
    return realRename(...args)
  })

  await assert.rejects(
    () => saveProjectSnapshot(project.id, failedSnapshot, 1),
    /simulated save index write failure/,
  )
  renameMock.mock.restore()
  assert.deepEqual(await loadProjectSnapshot(project.id), { snapshot: initialSnapshot, revision: 1 })

  // Состояние после аварийного завершения между rename(project.json) и
  // writeIndex(projects.json): новый снимок уже на диске, revision ещё старая.
  const crashResidue = { version: 1, items: [], camera: { x: 7, y: 0, scale: 1 } }
  const staleAfterCrash = { version: 1, items: [], camera: { x: 8, y: 0, scale: 1 } }
  await fs.writeFile(
    path.join(dir, 'projects', project.id, 'project.json'),
    JSON.stringify(crashResidue),
    'utf8',
  )
  const crashConflict = await saveProjectSnapshot(project.id, staleAfterCrash, 1, conflictKey)
  assert.deepEqual(
    await loadProjectSnapshot(project.id),
    { snapshot: crashResidue, revision: 2 },
    'snapshot, переживший падение до обновления индекса, нельзя перезаписывать stale-сохранением',
  )
  assert.equal(
    crashConflict.status,
    'conflict',
    'stale revision не должна перезаписать snapshot, переживший падение до обновления индекса',
  )
  if (crashConflict.status !== 'conflict') throw new Error('ожидался конфликт после crash residue')
  await deleteProject(crashConflict.recoveryProject.id)

  await deleteProject(project.id)
  await deleteProject(initial[0].id)
  await deleteProject(firstConflict.recoveryProject.id)
  await deleteProject(otherConflict.recoveryProject.id)
  assert.deepEqual(await listProjects(), [])

  await ensureProjects()

  assert.deepEqual(await listProjects(), [])

  const projectDirsBeforeFailedCreate = (await fs.readdir(path.join(dir, 'projects'))).sort()
  const realCreateRename = fs.rename
  const createRenameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated create index write failure')
    }
    return realCreateRename(...args)
  })

  await assert.rejects(
    () => createProject('Неиндексированная доска'),
    /simulated create index write failure/,
  )
  createRenameMock.mock.restore()
  assert.deepEqual((await fs.readdir(path.join(dir, 'projects'))).sort(), projectDirsBeforeFailedCreate)
})
