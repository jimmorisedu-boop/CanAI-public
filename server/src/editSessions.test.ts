import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  createEditSessionService,
  EditSessionError,
  type EditSessionServiceDependencies,
} from './editSessions.js'
import type { StoredEditSessionV2 } from './editSessionStore.js'

function stored(patch: Partial<StoredEditSessionV2> = {}): StoredEditSessionV2 {
  return {
    id: 'session-1',
    projectId: 'project-1',
    sourceItemId: 'image-1',
    sourceName: 'Фото',
    fileName: 'edit-session-1.png',
    createdAt: 1_000,
    expiresAt: 1_000 + 7 * 24 * 60 * 60 * 1000,
    lastMtime: 100,
    appliedMtime: 100,
    placedItemId: null,
    state: 'waiting',
    ...patch,
  }
}

function fixture(options: {
  active?: Array<{ id: string; name: string }>
  trashed?: Array<{ id: string; name: string }>
  sessions?: StoredEditSessionV2[]
  accessError?: Error
  launchError?: Error
  statMtime?: number
} = {}) {
  const records = new Map((options.sessions ?? []).map((session) => [session.id, { ...session }]))
  const unlinked: string[] = []
  const copied: Array<[string, string]> = []
  let sequence = 0
  const store = {
    async create(session: StoredEditSessionV2) {
      records.set(session.id, { ...session })
      return { ...session }
    },
    async list() {
      return [...records.values()].map((session) => ({ ...session }))
    },
    async acknowledge(id: string, input: { appliedMtime: number; placedItemId: string }) {
      const session = records.get(id)
      if (!session) return null
      session.appliedMtime = input.appliedMtime
      session.placedItemId = input.placedItemId
      session.state = session.lastMtime > input.appliedMtime ? 'ready' : 'applied'
      return { ...session }
    },
    async markBroken(id: string, error: string) {
      const session = records.get(id)
      if (!session) return null
      session.state = 'broken'
      session.error = error
      return { ...session }
    },
    async remove(id: string) {
      return records.delete(id)
    },
  }
  const deps: EditSessionServiceDependencies = {
    store,
    mediaDir: 'C:\\portable\\media',
    now: () => 1_000,
    uuid: () => `uuid-${++sequence}`,
    loadEditorPath: async () => 'C:\\Photoshop.exe',
    listProjects: async () => options.active ?? [{ id: 'project-1', name: 'Доска 1' }],
    listTrashedProjects: async () => options.trashed ?? [],
    access: async () => {
      if (options.accessError) throw options.accessError
    },
    copyFile: async (source, destination) => {
      copied.push([source, destination])
    },
    unlink: async (file) => {
      unlinked.push(file)
    },
    stat: async () => ({ mtimeMs: options.statMtime ?? 100 }),
    launch: async () => {
      if (options.launchError) throw options.launchError
    },
  }
  return { service: createEditSessionService(deps), records, copied, unlinked }
}

const input = {
  src: '/media/source.png',
  projectId: 'project-1',
  sourceItemId: 'image-1',
  sourceName: 'Фото',
}

test('сохраняет точный mtime, чтобы первый poll не выдумывал сохранение', async () => {
  const f = fixture({ statMtime: 100.75 })
  const result = await f.service.start(input)
  assert.equal(result.lastMtime, 100.75)
  assert.equal(result.appliedMtime, 100.75)
  assert.equal(f.records.get(result.id)?.lastMtime, 100.75)
})

test('создаёт waiting-сессию, привязанную к активной доске и исходнику', async () => {
  const f = fixture()
  const result = await f.service.start(input)
  assert.equal(result.projectId, 'project-1')
  assert.equal(result.projectName, 'Доска 1')
  assert.equal(result.projectStatus, 'active')
  assert.equal(result.lastMtime, 100)
  assert.equal(result.appliedMtime, 100)
  assert.equal(result.state, 'waiting')
  assert.match(result.url, /^\/media\/edit-uuid-1\.png$/)
})

test('не запускает редактор для не-изображения', async () => {
  const f = fixture()
  await assert.rejects(
    () => f.service.start({ ...input, src: '/media/source.mp4' }),
    (error: unknown) => error instanceof EditSessionError && error.code === 'not_image',
  )
})

test('не создаёт новую сессию для удалённой или отсутствующей доски', async () => {
  const trashed = fixture({ active: [], trashed: [{ id: 'project-1', name: 'В корзине' }] })
  await assert.rejects(
    () => trashed.service.start(input),
    (error: unknown) => error instanceof EditSessionError && error.code === 'project_trashed',
  )
  const missing = fixture({ active: [], trashed: [] })
  await assert.rejects(
    () => missing.service.start(input),
    (error: unknown) => error instanceof EditSessionError && error.code === 'project_missing',
  )
})

test('сообщает о пропавшем исходном файле', async () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
  const f = fixture({ accessError: error })
  await assert.rejects(
    () => f.service.start(input),
    (caught: unknown) => caught instanceof EditSessionError && caught.code === 'no_file',
  )
})

test('при ошибке запуска удаляет созданную edit-копию', async () => {
  const f = fixture({ launchError: new Error('spawn failed') })
  await assert.rejects(
    () => f.service.start(input),
    (error: unknown) => error instanceof EditSessionError && error.code === 'editor_launch_failed',
  )
  assert.equal(f.copied.length, 1)
  assert.deepEqual(f.unlinked, [f.copied[0][1]])
  assert.equal(f.records.size, 0)
})

test('list подхватывает новое имя активной доски', async () => {
  const f = fixture({ active: [{ id: 'project-1', name: 'Новое имя' }], sessions: [stored()] })
  const [session] = await f.service.list()
  assert.equal(session.projectName, 'Новое имя')
  assert.equal(session.projectStatus, 'active')
})

test('сессия доски в корзине остаётся видимой', async () => {
  const f = fixture({
    active: [],
    trashed: [{ id: 'project-1', name: 'Удалённая доска' }],
    sessions: [stored({ state: 'ready', lastMtime: 200 })],
  })
  const [session] = await f.service.list()
  assert.equal(session.projectName, 'Удалённая доска')
  assert.equal(session.projectStatus, 'trashed')
  assert.equal(session.state, 'ready')
})

test('сессия окончательно удалённой доски становится broken', async () => {
  const f = fixture({ active: [], trashed: [], sessions: [stored()] })
  const [session] = await f.service.list()
  assert.equal(session.projectName, null)
  assert.equal(session.projectStatus, 'missing')
  assert.equal(session.state, 'broken')
  assert.match(session.error ?? '', /not found/i)
})

test('правка на командной доске не ломается первым же опросом списка', async () => {
  // Жалоба 22.09.2026: Фотошоп открылся, а в углу — «Доска внешней правки не
  // найдена». Командной доски в локальном индексе нет никогда: запуск это
  // знал, а список — нет, и помечал правку сломанной.
  const f = fixture({ active: [], trashed: [] })
  const started = await f.service.start({
    ...input, projectId: 'prj_team', boardSource: 'cloud', boardName: 'Командная доска',
  })
  const [listed] = await f.service.list()
  assert.equal(listed?.state, 'waiting')
  assert.equal(listed?.error, undefined)
  assert.equal(listed?.projectName, 'Командная доска')
  assert.equal(listed?.projectStatus, 'active')
  // Сломанную правку перестают слушать: сохранение в Фотошопе не доехало бы.
  assert.equal(await f.service.mtime(started.id), 100)
})

test('stop удаляет только запрошенную сессию', async () => {
  const f = fixture({ sessions: [stored(), stored({ id: 'session-2', fileName: 'edit-session-2.png' })] })
  assert.equal(await f.service.stop('session-1'), true)
  assert.equal(await f.service.stop('unknown'), false)
  assert.deepEqual([...f.records.keys()], ['session-2'])
})

test('ack возвращает публичную сессию и сохраняет идентификатор результата', async () => {
  const f = fixture({ sessions: [stored({ state: 'ready', lastMtime: 200 })] })
  const result = await f.service.acknowledge('session-1', { appliedMtime: 200, placedItemId: 'placed-1' })
  assert.equal(result?.placedItemId, 'placed-1')
  assert.equal(result?.state, 'applied')
  assert.equal(result?.projectStatus, 'active')
})
