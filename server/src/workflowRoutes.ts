import { Router } from 'express'
import { GraphTooLargeError } from './graphLimits.js'
import {
  MacroNotFoundError,
  MacroOrderMismatchError,
  MacroRevisionConflictError,
  normalizeScope,
  SLOT_COUNT,
  workflowStore,
} from './workflows.js'

// Роуты нодовых workflow: черновик графа + сохранённые макросы.
export const workflowRouter = Router()

const MAX_NAME = 60

// ── черновик текущего графа нод ─────────────────────────────
workflowRouter.get('/workflow-draft', async (_req, res) => {
  try {
    res.json({ graph: await workflowStore.loadDraft() })
  } catch {
    res.status(500).json({ error: 'Could not read draft' })
  }
})

workflowRouter.post('/workflow-draft', async (req, res) => {
  const { graph } = (req.body ?? {}) as { graph?: unknown }
  if (!graph || typeof graph !== 'object') {
    return res.status(400).json({ error: 'No workflow data' })
  }
  try {
    await workflowStore.saveDraft(graph)
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof GraphTooLargeError) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: 'Could not save draft' })
  }
})

// ── макросы (сохранённые workflow под именем) ───────────────
workflowRouter.get('/macros', async (_req, res) => {
  try {
    res.json({ macros: await workflowStore.listMacros() })
  } catch {
    res.status(500).json({ error: 'Could not read macros' })
  }
})

workflowRouter.post('/macros', async (req, res) => {
  const { name, graph, id, slot, baseRevision, scope } = (req.body ?? {}) as {
    name?: unknown
    graph?: unknown
    id?: unknown
    slot?: unknown
    baseRevision?: unknown
    scope?: unknown
  }
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A macro name is required' })
  }
  if (!graph || typeof graph !== 'object') {
    return res.status(400).json({ error: 'No workflow data' })
  }
  if (slot !== undefined && (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= SLOT_COUNT)) {
    return res.status(400).json({ error: 'Invalid slot' })
  }
  if (
    typeof id === 'string' &&
    (!Number.isInteger(baseRevision) || (baseRevision as number) < 1)
  ) {
    return res.status(400).json({
      error: 'A macro version is required',
      code: 'MACRO_REVISION_REQUIRED',
    })
  }
  try {
    const macro = await workflowStore.saveMacro(
      name.trim().slice(0, MAX_NAME),
      graph,
      typeof id === 'string' ? id : undefined,
      slot as number | undefined,
      typeof baseRevision === 'number' ? baseRevision : undefined,
      normalizeScope(scope),
    )
    res.json({ macro })
  } catch (err) {
    if (err instanceof MacroRevisionConflictError) {
      return res.status(409).json({
        error: err.message,
        code: 'MACRO_REVISION_CONFLICT',
        currentRevision: err.currentRevision,
      })
    }
    if (err instanceof MacroNotFoundError) {
      return res.status(404).json({
        error: err.message,
        code: 'MACRO_NOT_FOUND',
      })
    }
    if (err instanceof GraphTooLargeError) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: 'Could not save macro' })
  }
})

// Порядок кнопок области целиком: слот = позиция в присланном списке.
workflowRouter.post('/macros/order', async (req, res) => {
  const { scope, ids } = (req.body ?? {}) as { scope?: unknown; ids?: unknown }
  if (
    !Array.isArray(ids) ||
    ids.length > SLOT_COUNT ||
    !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
  ) {
    return res.status(400).json({ error: 'Invalid macro list' })
  }
  try {
    const macros = await workflowStore.reorderMacros(normalizeScope(scope), ids as string[])
    res.json({ macros })
  } catch (err) {
    if (err instanceof MacroOrderMismatchError) {
      return res.status(409).json({ error: err.message, code: 'MACRO_ORDER_MISMATCH' })
    }
    res.status(500).json({ error: 'Could not change the order' })
  }
})

workflowRouter.delete('/macros/:id', async (req, res) => {
  const { baseRevision } = (req.body ?? {}) as { baseRevision?: unknown }
  if (!Number.isInteger(baseRevision) || (baseRevision as number) < 1) {
    return res.status(400).json({
      error: 'A macro version is required',
      code: 'MACRO_REVISION_REQUIRED',
    })
  }
  try {
    await workflowStore.deleteMacro(req.params.id, baseRevision as number)
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof MacroRevisionConflictError) {
      return res.status(409).json({
        error: err.message,
        code: 'MACRO_REVISION_CONFLICT',
        currentRevision: err.currentRevision,
      })
    }
    if (err instanceof MacroNotFoundError) {
      return res.status(404).json({
        error: err.message,
        code: 'MACRO_NOT_FOUND',
      })
    }
    res.status(500).json({ error: 'Could not delete macro' })
  }
})
