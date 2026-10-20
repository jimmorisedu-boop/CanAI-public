import express, { Router } from 'express'
import {
  boardHolder,
  claimBoard,
  heartbeatBoard,
  listBoardHolders,
  releaseBoard,
} from './boardPresence.js'
import { isSafeProjectId } from './projects.js'
import {
  deleteSessionDraft,
  isEmptySessionDraft,
  loadSessionDraft,
  normalizeDeviceName,
  sanitizeSessionDraft,
  saveSessionDraft,
} from './sessionDraft.js'

// Непрерывность сеанса между устройствами: черновик промпта и то, кто держит
// доску. Обе ручки маленькие и обе про одно — начал на компьютере, продолжил на
// планшете.
export const continuityRouter = Router()

// ⚠️ Держатель — это устройство И вкладка: «<устройство>~<вкладка>»
// (ownerId на клиенте). 18.09.2026 клиент перешёл на составное имя, а здесь
// осталось старое правило — одна часть без «~», не длиннее 64 знаков. С того
// дня КАЖДАЯ отметка присутствия отклонялась ответом «Не указано устройство»,
// клиент молча считал это сетевой заминкой, и сервер ни разу не видел открытой
// доски. Итог — ровно то, от чего присутствие и заведено: сервер сам ставил
// готовый результат в файл доски прямо под открытой вкладкой, вкладка ставила
// его же у себя, и её сохранение уезжало в конфликтную копию. Со стороны это
// выглядело как «после каждой генерации вылетает» (жалобы 19–20.09.2026). В
// журнале тестировщика строки «Доска открыта на …» шли сотнями каждый день —
// и оборвались 18.09 навсегда.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}(?:~[A-Za-z0-9_-]{8,64})?$/

function reqProjectId(req: express.Request): string | null {
  const raw = req.query.project
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return id && isSafeProjectId(id) ? id : null
}

continuityRouter.get('/session-draft', async (req, res) => {
  const id = reqProjectId(req)
  if (!id) return res.status(400).json({ error: 'Missing board' })
  try {
    const stored = await loadSessionDraft(id)
    res.json(stored ?? { draft: null })
  } catch {
    res.status(500).json({ error: 'Could not read draft' })
  }
})

continuityRouter.post('/session-draft', async (req, res) => {
  const id = reqProjectId(req)
  if (!id) return res.status(400).json({ error: 'Missing board' })
  const body = (req.body ?? {}) as { draft?: unknown; device?: unknown }
  const draft = sanitizeSessionDraft(body.draft)
  if (!draft) return res.status(400).json({ error: 'Invalid draft session' })
  try {
    // Опустевший черновик — это отсутствие черновика. Иначе на новом
    // устройстве всплывала бы пустая подсказка «продолжить».
    if (isEmptySessionDraft(draft)) {
      await deleteSessionDraft(id)
      return res.json({ ok: true, draft: null })
    }
    const stored = await saveSessionDraft(id, draft, normalizeDeviceName(body.device))
    res.json({ ok: true, ...stored })
  } catch {
    res.status(500).json({ error: 'Could not save draft' })
  }
})

continuityRouter.delete('/session-draft', async (req, res) => {
  const id = reqProjectId(req)
  if (!id) return res.status(400).json({ error: 'Missing board' })
  try {
    await deleteSessionDraft(id)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not delete draft' })
  }
})

continuityRouter.get('/board-presence', (req, res) => {
  const raw = req.query.project
  if (typeof raw === 'string' && raw.trim()) {
    const id = reqProjectId(req)
    if (!id) return res.status(400).json({ error: 'Missing board' })
    return res.json({ holder: boardHolder(id) })
  }
  res.json({ boards: listBoardHolders() })
})

continuityRouter.post('/board-presence', (req, res) => {
  const body = (req.body ?? {}) as {
    project?: unknown
    clientId?: unknown
    device?: unknown
    action?: unknown
    visible?: unknown
  }
  const id = typeof body.project === 'string' && isSafeProjectId(body.project.trim())
    ? body.project.trim()
    : null
  if (!id) return res.status(400).json({ error: 'Missing board' })
  const clientId = typeof body.clientId === 'string' && CLIENT_ID_RE.test(body.clientId)
    ? body.clientId
    : null
  if (!clientId) return res.status(400).json({ error: 'Missing device' })
  const device = normalizeDeviceName(body.device)
  if (body.action === 'claim') return res.json(claimBoard(id, clientId, device))
  if (body.action === 'release') return res.json(releaseBoard(id, clientId))
  if (body.action === 'heartbeat' || body.action === undefined) {
    // Спрятанная вкладка отмечается тоже: держателем она быть перестаёт, но
    // доска у неё ОТКРЫТА — и серверная доставка не должна писать под ней.
    return res.json(heartbeatBoard(id, clientId, device, Date.now(), body.visible !== false))
  }
  res.status(400).json({ error: 'Unknown action' })
})
