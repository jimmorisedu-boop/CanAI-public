import express, { Router } from 'express'
import {
  AssistantFileError,
  AssistantsStoreError,
  addAssistantDoc,
  deleteAssistant,
  duplicateAssistant,
  exportAssistant,
  importAssistant,
  listAssistants,
  removeAssistantDoc,
  saveAssistant,
  setActiveAssistant,
} from './assistants.js'

// Помощники: список, правка, включение и документы знаний.
export const assistantRouter = Router()

const MAX_DOC_BYTES = 2 * 1024 * 1024

function fail(res: express.Response, error: unknown): void {
  res.status(500).json({ error: error instanceof Error ? error.message : 'Assistant error' })
}

/**
 * Отказ по существу запроса (нет такого помощника) — со своим кодом ответа.
 * Беда с самой библиотекой на диске — всегда 500: это не «не найдено» и не
 * «неверный запрос», и текст у неё свой.
 */
function refuse(res: express.Response, error: unknown, status: number, fallback: string): void {
  if (error instanceof AssistantsStoreError) return fail(res, error)
  res.status(status).json({ error: error instanceof Error ? error.message : fallback })
}

assistantRouter.get('/assistants', async (_req, res) => {
  try {
    res.json(await listAssistants())
  } catch (error) {
    fail(res, error)
  }
})

assistantRouter.post('/assistants', async (req, res) => {
  const body = (req.body ?? {}) as { id?: unknown; name?: unknown; instructions?: unknown; modelId?: unknown }
  if (typeof body.name !== 'string' || typeof body.instructions !== 'string' || typeof body.modelId !== 'string') {
    res.status(400).json({ error: 'Name, instructions, and model are required' })
    return
  }
  try {
    res.json({
      preset: await saveAssistant({
        id: typeof body.id === 'string' ? body.id : null,
        name: body.name,
        instructions: body.instructions,
        modelId: body.modelId,
      }),
    })
  } catch (error) {
    fail(res, error)
  }
})

// Файл обмена: помощник целиком, вместе с текстами документов знаний.
// ⚠️ В белом списке планшета этих ручек нет намеренно: правка помощников на
// планшете закрыта, а выгрузка отдаёт тексты документов.
assistantRouter.get('/assistants/:id/export', async (req, res) => {
  try {
    res.json(await exportAssistant(String(req.params.id)))
  } catch (error) {
    refuse(res, error, 404, 'Assistant not found')
  }
})

assistantRouter.post('/assistants/import', async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; instructions?: unknown; modelId?: unknown; docs?: unknown }
  if (typeof body.name !== 'string' || !body.name.trim() || typeof body.instructions !== 'string') {
    res.status(400).json({ error: 'The file has no assistant name or instructions' })
    return
  }
  const docs = (Array.isArray(body.docs) ? body.docs : []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const doc = raw as { name?: unknown; text?: unknown }
    if (typeof doc.text !== 'string') return []
    return [{ name: typeof doc.name === 'string' ? doc.name : 'document', text: doc.text }]
  })
  try {
    // Ответ — `{ preset, notes }`: в notes готовыми фразами сказано, что при
    // приёме пришлось урезать или заменить. Пустой список — вошло всё.
    res.json(await importAssistant({
      name: body.name,
      instructions: body.instructions,
      modelId: typeof body.modelId === 'string' ? body.modelId : '',
      docs,
    }))
  } catch (error) {
    // Негодный файл — отказ запросу; всё остальное — беда на нашей стороне.
    if (error instanceof AssistantFileError) res.status(400).json({ error: error.message })
    else fail(res, error)
  }
})

assistantRouter.post('/assistants/:id/duplicate', async (req, res) => {
  try {
    res.json({ preset: await duplicateAssistant(String(req.params.id)) })
  } catch (error) {
    fail(res, error)
  }
})

assistantRouter.delete('/assistants/:id', async (req, res) => {
  try {
    await deleteAssistant(String(req.params.id))
    res.json({ ok: true })
  } catch (error) {
    fail(res, error)
  }
})

assistantRouter.post('/assistants/active', async (req, res) => {
  const body = (req.body ?? {}) as { id?: unknown }
  try {
    res.json(await setActiveAssistant(typeof body.id === 'string' ? body.id : null))
  } catch (error) {
    fail(res, error)
  }
})

// Документ приходит ТЕКСТОМ: разбирать pdf и docx нечем, и молча принять такой
// файл значило бы отдать модели мусор вместо знаний.
assistantRouter.post(
  '/assistants/:id/docs',
  express.text({ type: '*/*', limit: MAX_DOC_BYTES }),
  async (req, res) => {
    const name = String(req.get('x-file-name') || 'document')
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text.trim()) {
      res.status(400).json({ error: 'The file is empty or not text' })
      return
    }
    try {
      res.json({ doc: await addAssistantDoc(String(req.params.id), decodeURIComponent(name), text) })
    } catch (error) {
      refuse(res, error, 400, 'Could not attach the file')
    }
  },
)

assistantRouter.delete('/assistants/:id/docs/:docId', async (req, res) => {
  try {
    await removeAssistantDoc(String(req.params.id), String(req.params.docId))
    res.json({ ok: true })
  } catch (error) {
    fail(res, error)
  }
})
