import express, { Router } from 'express'
import { isCanvasSnapshot } from './canvasSnapshot.js'
import {
  createProject,
  listProjects,
  loadProjectSnapshot,
  projectPreview,
  saveProjectSnapshot,
  updateProject,
} from './projects.js'
import {
  deleteTrashedProjectPermanently,
  listTrashedProjects,
  restoreTrashedProject,
  trashProject,
} from './projectTrash.js'
import { listProjectVersions, restoreProjectVersion } from './projectVersions.js'
import { exportBoardName, reserveExportNumbers } from './exportNumbers.js'
import { scheduleMediaSort } from './mediaSort.js'
import { boardPresenceSummary } from './boardPresence.js'
import { logNote } from './log.js'
import { conflictLine, repeatedWriteLine } from './projectWriteLog.js'
import { missingCanvasMedia } from './canvasMediaIntegrity.js'
import { agentHost } from './agents/runtime.js'

// CRUD досок + чтение/запись холста
export const projectRouter = Router()

function reqProjectId(req: express.Request): string | null {
  const raw = req.query.project
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

projectRouter.get('/projects', async (_req, res) => {
  try {
    const list = await listProjects()
    const projects = await Promise.all(
      list.map(async (p) => {
        const preview = await projectPreview(p.id)
        return { ...p, preview, thumb: preview?.src ?? null }
      }),
    )
    res.json({ projects })
  } catch {
    res.status(500).json({ error: 'Could not read the board list' })
  }
})

projectRouter.post('/projects', async (req, res) => {
  const { name, initialSnapshot } = (req.body ?? {}) as { name?: unknown; initialSnapshot?: unknown }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid board name' })
  }
  if (initialSnapshot !== undefined && !isCanvasSnapshot(initialSnapshot)) {
    return res.status(400).json({
      error: 'Invalid board data (images/videos must use /media/… links, not base64)',
    })
  }
  try {
    const project = await createProject(typeof name === 'string' ? name : '', initialSnapshot)
    if (initialSnapshot !== undefined) scheduleMediaSort()
    res.json({ project })
  } catch {
    res.status(500).json({ error: 'Could not create board' })
  }
})

projectRouter.patch('/projects/:id', async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid board update' })
  }
  const raw = body as Record<string, unknown>
  const fields = Object.keys(raw)
  if (!fields.length || fields.some((field) => field !== 'name' && field !== 'pinned')) {
    return res.status(400).json({ error: 'Invalid board update' })
  }
  const patch: { name?: string; pinned?: boolean } = {}
  if ('name' in raw) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      return res.status(400).json({ error: 'Invalid board update' })
    }
    patch.name = raw.name
  }
  if ('pinned' in raw) {
    if (typeof raw.pinned !== 'boolean') {
      return res.status(400).json({ error: 'Invalid board update' })
    }
    patch.pinned = raw.pinned
  }
  try {
    const project = await updateProject(req.params.id, patch)
    if (!project) return res.status(404).json({ error: 'Board not found' })
    res.json({ project })
  } catch {
    res.status(500).json({ error: 'Could not refresh board' })
  }
})

projectRouter.delete('/projects/:id', async (req, res) => {
  try {
    const project = await trashProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'Board not found' })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not delete board' })
  }
})

projectRouter.get('/project-trash', async (_req, res) => {
  try {
    res.json({ projects: await listTrashedProjects() })
  } catch {
    res.status(500).json({ error: 'Could not read Trash' })
  }
})

projectRouter.post('/project-trash/:id/restore', async (req, res) => {
  try {
    const project = await restoreTrashedProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'Board not found in trash' })
    res.json({ project })
  } catch {
    res.status(500).json({ error: 'Could not restore board' })
  }
})

// Очистить корзину целиком. Срока жизни у неё нет намеренно (восстановление
// доски должно работать и через месяц), но чистить по одной доске — работа на
// час: у пользователя их накопилось шесть десятков, и они держали 766 МБ медиа,
// которые иначе убрал бы сборщик мусора (найдено прогоном 20.08.2026).
// Возвращаем, сколько удалили: человеку важно видеть, что действие сработало.
projectRouter.delete('/project-trash', async (_req, res) => {
  try {
    const trashed = await listTrashedProjects()
    let deleted = 0
    for (const project of trashed) {
      if (await deleteTrashedProjectPermanently(project.id)) deleted += 1
    }
    res.json({ deleted })
  } catch {
    res.status(500).json({ error: 'Could not empty Trash' })
  }
})

projectRouter.delete('/project-trash/:id', async (req, res) => {
  try {
    const deleted = await deleteTrashedProjectPermanently(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Board not found in trash' })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not permanently delete the board' })
  }
})

projectRouter.get('/projects/:id/versions', async (req, res) => {
  try {
    const versions = await listProjectVersions(req.params.id)
    if (!versions) return res.status(404).json({ error: 'Board not found' })
    res.json({ versions })
  } catch {
    res.status(500).json({ error: 'Could not read the board versions' })
  }
})

projectRouter.post('/projects/:id/versions/:version/restore', async (req, res) => {
  try {
    const project = await restoreProjectVersion(req.params.id, req.params.version)
    if (!project) return res.status(404).json({ error: 'Version not found' })
    res.json({ project })
  } catch {
    res.status(500).json({ error: 'Could not restore version' })
  }
})

projectRouter.get('/project', async (req, res) => {
  const id = reqProjectId(req)
  if (!id) return res.status(400).json({ error: 'Missing board' })
  try {
    const loaded = await loadProjectSnapshot(id)
    if (!loaded) return res.status(404).json({ error: 'Board not found' })
    const missingMedia = await missingCanvasMedia(loaded.snapshot)
    res.json({
      ...loaded,
      ...(missingMedia.length > 0 ? { missingMedia } : {}),
    })
  } catch {
    res.status(500).json({ error: 'Could not read the board' })
  }
})

projectRouter.post('/project', async (req, res) => {
  const id = reqProjectId(req)
  if (!id) return res.status(400).json({ error: 'Missing board' })
  const { snapshot, expectedRevision, conflictKey } = (req.body ?? {}) as {
    snapshot?: unknown
    expectedRevision?: unknown
    conflictKey?: unknown
  }
  if (!isCanvasSnapshot(snapshot)) {
    return res.status(400).json({
      error: 'Invalid board data (images/videos must use /media/… links, not base64)',
    })
  }
  // Structural validation cannot tell whether a local /media link still has
  // bytes on this installation.  Reject only that proven case before the
  // revision check/write so a stale or partially restored board is never
  // acknowledged as saved while silently retaining ENOENT references.
  const missingMedia = await missingCanvasMedia(snapshot)
  if (missingMedia.length > 0) {
    return res.status(400).json({
      error: 'Snapshot references missing media files. Restore the original files and save again.',
      code: 'MISSING_MEDIA',
      details: { sources: missingMedia },
    })
  }
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return res.status(400).json({ error: 'Missing board version' })
  }
  if (conflictKey !== undefined && (
    typeof conflictKey !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conflictKey)
  )) {
    return res.status(400).json({ error: 'Invalid tab-conflict key' })
  }
  try {
    const result = await saveProjectSnapshot(
      id,
      snapshot,
      expectedRevision as number,
      conflictKey as string | undefined,
    )
    if (result.status === 'not-found') return res.status(404).json({ error: 'Board not found' })
    if (result.status === 'conflict') {
      const presence = boardPresenceSummary(id)
      logNote('project', conflictLine({
        projectId: id,
        sessionKey: typeof conflictKey === 'string' ? conflictKey : null,
        expectedRevision: expectedRevision as number,
        serverRevision: result.revision,
        lastWriter: result.lastWriter,
        openTabs: presence.openTabs,
        holder: presence.holder,
        copyName: result.recoveryProject.name,
      }))
      scheduleMediaSort()
      return res.status(409).json({
        error: 'Board changed in another tab.',
        code: 'PROJECT_CONFLICT',
        details: {
          serverRevision: result.revision,
          recoveryProject: result.recoveryProject,
        },
      })
    }
    if (result.repeatedFrom !== undefined) {
      logNote('project', repeatedWriteLine({
        projectId: id,
        sessionKey: typeof conflictKey === 'string' ? conflictKey : null,
        from: result.repeatedFrom,
        to: result.revision,
      }))
    }
    // Холст сохранён — значит про часть файлов теперь известно, к какой доске
    // они относятся. Раскладку просим фоном и с задержкой: ответ клиенту ждать
    // обхода папок не должен.
    scheduleMediaSort()
    // ⚠️ Отвечаем ДО личного черновика. Он пишет свою очередь на диск и при
    // включённой отправке держит там копию доски целиком, а `.catch` спасает
    // от ошибки, но не от медлительности. Задержанный ответ хуже ошибки: через
    // 30 секунд вкладка решает, что запись не удалась, и повторяет её со
    // старым номером ревизии — доска уже записана, и повтор раньше уходил в
    // конфликтную копию «из-за другой вкладки», которой не было.
    res.json({ ok: true, revision: result.revision })
    // The regular browser save is the commit point for staged agent canvas
    // results.  The Host only updates its receipt after this durable write;
    // it never rewrites the open board behind the browser.
    void agentHost.acknowledgeCanvasDelivery(id, snapshot).catch((error) => {
      logNote('agents', `Could not confirm delivery of result ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch {
    res.status(500).json({ error: 'Could not save the board' })
  }
})

// Нумерация экспорта: клиент просит номера для меток, сервер их выдаёт и
// запоминает. Имя доски берём ЗДЕСЬ, а не с клиента: оно должно совпадать с
// тем, по которому считается счётчик, иначе номера разъедутся с именами.
projectRouter.post('/exports/reserve', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { project?: unknown; groups?: unknown }
    const id = typeof body.project === 'string' ? body.project.trim() : ''
    const raw = Array.isArray(body.groups) ? body.groups : []
    const groups = raw
      .map((entry) => entry as { mark?: unknown; count?: unknown })
      .filter((entry) => typeof entry.mark === 'number' && typeof entry.count === 'number')
      .map((entry) => ({ mark: Number(entry.mark), count: Number(entry.count) }))
      .filter((entry) => Number.isFinite(entry.mark) && entry.count > 0 && entry.count <= 5000)
      .slice(0, 1000)
    if (groups.length === 0) {
      res.status(400).json({ error: 'No numbers requested' })
      return
    }
    const meta = id ? (await listProjects()).find((project) => project.id === id) : undefined
    const board = exportBoardName(meta?.name)
    res.json({ board, starts: await reserveExportNumbers(board, groups) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not issue numbers' })
  }
})
