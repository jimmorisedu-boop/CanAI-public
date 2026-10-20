import { Router } from 'express'
import { isSafeProjectId } from './projects.js'
import { cancelMacroRun, listMacroRuns, startMacroRun } from './macroRuns.js'
import { deliveringNodeIds } from './macroGraph.js'
import type { MacroGraph, MacroInputSnapshot } from './macroGraph.js'
import { parseRefs } from './refs.js'
import { workflowStore } from './workflows.js'

// Запуск макроса. Граф берётся с сервера по id — клиент присылает только то,
// чего у сервера нет: выделение доски, разложенное по входам, и номера
// заглушек, которые он уже занял под будущие результаты.
export const macroRunRouter = Router()

const MAX_PLACEHOLDERS = 64
const ID_RE = /^[A-Za-z0-9_:-]{1,120}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseSnapshot(value: unknown): MacroInputSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const refs = parseRefs(value.refs) ?? []
  const refsByEdge: Record<string, ReturnType<typeof parseRefs>> = {}
  if (isRecord(value.refsByEdge)) {
    for (const [edgeId, list] of Object.entries(value.refsByEdge)) {
      if (!ID_RE.test(edgeId)) continue
      const parsed = parseRefs(list)
      if (parsed) refsByEdge[edgeId] = parsed
    }
  }
  const assetsBySlot: MacroInputSnapshot['assetsBySlot'] = {}
  if (isRecord(value.assetsBySlot)) {
    for (const [slot, asset] of Object.entries(value.assetsBySlot)) {
      if (!/^\d{1,2}$/.test(slot) || !isRecord(asset)) continue
      const src = typeof asset.src === 'string' ? asset.src : undefined
      // Инвариант «без base64» действует и на входах макроса.
      if (src && !src.startsWith('/media/')) continue
      assetsBySlot[slot] = {
        kind: typeof asset.kind === 'string' ? asset.kind : 'image',
        src,
        text: typeof asset.text === 'string' ? asset.text : undefined,
      }
    }
  }
  return {
    refs,
    refsByEdge: refsByEdge as MacroInputSnapshot['refsByEdge'],
    assetsBySlot,
  }
}

// Сколько мест на доске займёт один прогон. Спрашивается ОТДЕЛЬНО, потому что
// заглушки ставит клиент (он знает, где на доске свободно), а правило «чей
// результат уезжает на холст» живёт в графе — то есть на сервере. Дублировать
// это правило в браузере значит однажды получить два разных ответа.
macroRunRouter.get('/macros/:id/plan', async (req, res) => {
  try {
    const macros = await workflowStore.listMacros()
    const macro = macros.find((entry) => entry.id === req.params.id)
    if (!macro) return res.status(404).json({ error: 'Macro not found' })
    const graph = macro.graph as unknown as MacroGraph
    if (!graph || !Array.isArray(graph.nodes)) return res.json({ deliveringNodeIds: [] })
    res.json({ deliveringNodeIds: deliveringNodeIds(graph) })
  } catch {
    res.status(500).json({ error: 'Could not read macro' })
  }
})

macroRunRouter.post('/macros/:id/run', async (req, res) => {
  const body = (req.body ?? {}) as {
    project?: unknown
    refs?: unknown
    snapshot?: unknown
    placeholderIds?: unknown
  }
  const projectId = typeof body.project === 'string' && isSafeProjectId(body.project.trim())
    ? body.project.trim()
    : null
  if (!projectId) return res.status(400).json({ error: 'Missing board' })

  const seedRefs = parseRefs(body.refs ?? [])
  if (seedRefs === null) return res.status(400).json({ error: 'References have an invalid format' })

  const placeholderIds = Array.isArray(body.placeholderIds)
    ? body.placeholderIds.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)).slice(0, MAX_PLACEHOLDERS)
    : []

  try {
    const macros = await workflowStore.listMacros()
    const macro = macros.find((entry) => entry.id === req.params.id)
    if (!macro) return res.status(404).json({ error: 'Macro not found' })
    const graph = macro.graph as unknown as MacroGraph
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return res.status(400).json({ error: 'The macro graph is empty' })
    }
    const run = startMacroRun({
      macroId: macro.id,
      macroName: macro.name,
      projectId,
      graph,
      seedRefs,
      snapshot: parseSnapshot(body.snapshot),
      placeholderIds,
    })
    res.json({ run })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not run macro' })
  }
})

macroRunRouter.get('/macro-runs', (req, res) => {
  const raw = req.query.project
  const projectId = typeof raw === 'string' && raw.trim() && isSafeProjectId(raw.trim())
    ? raw.trim()
    : undefined
  res.json({ runs: listMacroRuns(projectId) })
})

macroRunRouter.post('/macro-runs/:id/cancel', (req, res) => {
  const stopped = cancelMacroRun(req.params.id)
  res.json({ ok: stopped })
})
