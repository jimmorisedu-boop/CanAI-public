import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('trash preserves the project, backups and prompt chat and can restore them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-project-trash-'))
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    delete process.env.CANAI_DATA_DIR
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    }).catch(() => {})
  })

  const { createProject, saveProjectSnapshot } = await import('./projects.js')
  const {
    listTrashedProjects,
    restoreTrashedProject,
    trashProject,
  } = await import('./projectTrash.js')
  const { listProjectVersions, restoreProjectVersion } = await import('./projectVersions.js')
  const project = await createProject('Тест')
  await saveProjectSnapshot(project.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const projectDir = path.join(dir, 'projects', project.id)
  await fs.mkdir(path.join(projectDir, 'backups'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'backups', 'project-one.json'), '{}')
  await fs.mkdir(path.join(dir, 'prompt-chats'), { recursive: true })
  await fs.writeFile(path.join(dir, 'prompt-chats', `${project.id}.json`), '{"revision":0,"document":{"version":1,"conversationId":"","messages":[]}}')
  const v2Dir = path.join(dir, 'prompt-chats', project.id)
  await fs.mkdir(v2Dir, { recursive: true })
  await fs.writeFile(path.join(v2Dir, 'index.json'), '{"version":2,"revision":0,"activeConversationId":null,"conversations":[],"hasTrash":false}')

  await trashProject(project.id)

  assert.equal((await listTrashedProjects())[0].name, 'Тест')
  await fs.access(path.join(dir, 'trash', project.id, 'project', 'project.json'))
  await fs.access(path.join(dir, 'trash', project.id, 'project', 'backups', 'project-one.json'))
  await fs.access(path.join(dir, 'trash', project.id, 'prompt-chat.json'))
  await fs.access(path.join(dir, 'trash', project.id, 'prompt-chat', 'index.json'))

  const restored = await restoreTrashedProject(project.id)
  assert.ok(restored)
  assert.equal(restored.name, 'Тест')
  await fs.access(path.join(dir, 'projects', restored.id, 'project.json'))
  await fs.access(path.join(dir, 'prompt-chats', `${restored.id}.json`))
  await fs.access(path.join(dir, 'prompt-chats', restored.id, 'index.json'))

  // До удаления вкладка могла успеть прочитать revision 1. Восстановление должно
  // инвалидировать такую устаревшую вкладку, а не давать ей затереть возвращённый снимок.
  const staleSave = await saveProjectSnapshot(
    restored.id,
    { version: 1, items: [], camera: { x: 999, y: 0, scale: 1 } },
    1,
  )
  assert.equal(staleSave.status, 'conflict')

  const backupDir = path.join(dir, 'projects', restored.id, 'backups')
  await fs.mkdir(backupDir, { recursive: true })
  await fs.writeFile(path.join(backupDir, 'project-2026-07-25T10-00-00-000Z.json'), '{"version":1,"items":[],"camera":{"x":5,"y":0,"scale":1}}')

  const versions = await listProjectVersions(restored.id)
  assert.ok(versions)
  const versionCopy = await restoreProjectVersion(restored.id, versions[0].id)
  assert.ok(versionCopy)

  assert.notEqual(versionCopy.id, restored.id)
  assert.match(versionCopy.name, /restored/)
  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'projects', versionCopy.id, 'project.json'), 'utf8'))
  assert.equal(snapshot.camera.x, 5)

  const projectDirsBeforeVersionRollback = (await fs.readdir(path.join(dir, 'projects'))).sort()
  const realVersionRename = fs.rename
  const versionRenameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated version restore index write failure')
    }
    return realVersionRename(...args)
  })

  await assert.rejects(
    () => restoreProjectVersion(restored.id, versions[0].id),
    /simulated version restore index write failure/,
  )
  versionRenameMock.mock.restore()
  assert.deepEqual((await fs.readdir(path.join(dir, 'projects'))).sort(), projectDirsBeforeVersionRollback)

  const rollbackProject = await createProject('Rollback trash')
  await saveProjectSnapshot(
    rollbackProject.id,
    { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } },
    0,
  )
  const legacyChat = path.join(dir, 'prompt-chats', `${rollbackProject.id}.json`)
  await fs.writeFile(legacyChat, '{"revision":0,"document":{"version":1,"conversationId":"","messages":[]}}')
  await fs.writeFile(`${legacyChat}.bak`, '{"revision":0,"document":{"version":1,"conversationId":"","messages":[]}}')
  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated index write failure')
    }
    return realRename(...args)
  })

  await assert.rejects(
    () => trashProject(rollbackProject.id),
    /simulated index write failure/,
  )
  renameMock.mock.restore()
  await fs.access(legacyChat)
  await fs.access(`${legacyChat}.bak`)

  const restoreRollbackProject = await createProject('Restore rollback')
  await saveProjectSnapshot(
    restoreRollbackProject.id,
    { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } },
    0,
  )
  await trashProject(restoreRollbackProject.id)
  const realRestoreRename = fs.rename
  const restoreRenameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      source === path.join(dir, 'projects.json.tmp')
      && destination === path.join(dir, 'projects.json')
    ) {
      throw new Error('simulated restore index write failure')
    }
    return realRestoreRename(...args)
  })

  await assert.rejects(
    () => restoreTrashedProject(restoreRollbackProject.id),
    /simulated restore index write failure/,
  )
  restoreRenameMock.mock.restore()
  await fs.access(path.join(dir, 'trash', restoreRollbackProject.id, 'project', 'project.json'))

  const deliveryProject = await createProject('Ответ после восстановления')
  await saveProjectSnapshot(
    deliveryProject.id,
    { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } },
    0,
  )
  const { promptChatRepository } = await import('./promptChatDelivery.js')
  const { deliverJobResult } = await import('./runner.js')
  const { jobs } = await import('./jobs.js')
  const conversation = await promptChatRepository.createOrReuseEmpty(deliveryProject.id, 'gemini')
  const jobId = 'delivery-after-restore'
  await promptChatRepository.appendMessages(deliveryProject.id, conversation.id, [
    { id: 'question-1', role: 'user', text: 'Составь промпт', createdAt: 10 },
    {
      id: 'answer-1',
      role: 'assistant',
      text: '',
      createdAt: 11,
      status: 'queued',
      jobId,
      requestMessageId: 'question-1',
      modelId: 'gemini',
    },
  ])
  await promptChatRepository.patchMeta(deliveryProject.id, conversation.id, {
    activeJobIds: [jobId],
  })
  const completedJob = jobs.create(
    'text',
    'Составь промпт',
    [],
    'gemini',
    {},
    {
      kind: 'prompt-chat',
      projectId: deliveryProject.id,
      conversationId: conversation.id,
      requestMessageId: 'question-1',
      responseMessageId: 'answer-1',
      requestId: 'send-1',
    },
    false,
    jobId,
  )
  completedJob.status = 'done'
  completedJob.result = { text: '{"reply":"Готово","prompts":[]}' }
  await jobs.persistNow()

  await trashProject(deliveryProject.id)
  await deliverJobResult(completedJob)
  await restoreTrashedProject(deliveryProject.id)

  assert.ok(completedJob.deliveredAt, 'восстановление повторяет недоставленный ответ')
  assert.equal(
    (await promptChatRepository.findMessage(deliveryProject.id, conversation.id, 'answer-1'))?.status,
    'done',
  )
  assert.deepEqual(
    (await promptChatRepository.loadMeta(deliveryProject.id, conversation.id)).activeJobIds,
    [],
  )
})

// ⚠️ По строке «Без названия — удалено 6 августа» нельзя было понять, что
// внутри: 65 картинок или ничего. Чтобы взглянуть, доску приходилось
// восстанавливать и удалять заново (вопрос пользователя 21.08.2026).
test('список корзины называет число объектов и показывает превью', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-trash-preview-'))
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    delete process.env.CANAI_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {})
  })

  const { createProject, saveProjectSnapshot } = await import(`./projects.js?trash-preview=${path.basename(dir)}`)
  const { listTrashedProjects, trashProject } = await import(`./projectTrash.js?trash-preview=${path.basename(dir)}`)

  const media = '/media/kartinka.png'
  const withMedia = await createProject('Со снимком')
  await saveProjectSnapshot(withMedia.id, {
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      { id: 'a', kind: 'text', x: 0, y: 0, w: 10, h: 10, text: 'подпись' },
      { id: 'b', kind: 'image', x: 0, y: 0, w: 10, h: 10, src: media },
    ],
  }, 0)
  const textOnly = await createProject('Только текст')
  await saveProjectSnapshot(textOnly.id, {
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{ id: 'a', kind: 'text', x: 0, y: 0, w: 10, h: 10, text: 'только текст' }],
  }, 0)

  await trashProject(withMedia.id)
  await trashProject(textOnly.id)
  const list = await listTrashedProjects()
  const снимок = list.find((item: { name: string }) => item.name === 'Со снимком')
  const текст = list.find((item: { name: string }) => item.name === 'Только текст')

  assert.equal(снимок?.itemCount, 2)
  assert.deepEqual(снимок?.preview, { src: media, kind: 'image' })
  // доска без картинок остаётся без превью, но со счётчиком: место в списке
  // занято одинаково, и строки не прыгают
  assert.equal(текст?.itemCount, 1)
  assert.equal(текст?.preview, null)
})
