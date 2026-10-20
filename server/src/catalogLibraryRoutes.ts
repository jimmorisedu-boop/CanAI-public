import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { catalogLibrary, applyCatalogLibrary, CatalogLibraryError, catalogFamilyIds, type Lifecycle } from './catalogLibrary.js'
import { catalogLifecycleOperations } from './catalogLifecycleOperations.js'
import { workflowStore } from './workflows.js'
import { config } from './config.js'
import { modelUses, migrateGraphModel } from '../../packages/model-catalog/macroModels.js'
import { discoverFalModel, FalDiscoveryError } from './discoverFalModel.js'
import { catalogDraftTestService } from './catalogDraftTests.js'
import { prepareFalModelSetup, FalModelSetupError } from './falModelSetup.js'
import { prepareFalModelTestSamples } from './falModelTestSamples.js'
import { JobLimitError } from './jobs.js'
import type { IncomingRef } from './refs.js'

export const catalogLibraryRouter = Router()

export function catalogLibraryErrorResponse(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof FalDiscoveryError) return { status:error.status, body:{error:error.message} }
  if (error instanceof FalModelSetupError) return { status:error.status, body:{error:error.message} }
  if (error instanceof JobLimitError) return { status: 429, body: { error: error.message } }
  if (error instanceof CatalogLibraryError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return { status: error.status, body: { error: error.message } }
  }
  return { status: 500, body: { error: 'Could not complete the model-catalog operation' } }
}

const familyIds = (id: string) => {
  return catalogFamilyIds(catalogLibrary.models(), id)
}

catalogLibraryRouter.get('/catalog/library', (_req, res) => res.json(catalogLibrary.view()))
catalogLibraryRouter.patch('/catalog/defaults', async (req, res, next) => {
  try {
    await catalogLibrary.setDefaults(req.body?.defaults ?? {}, req.body?.revision)
    res.json(catalogLibrary.view())
  } catch (error) { next(error) }
})
catalogLibraryRouter.get('/catalog/models/:id/impact', async (req, res, next) => {
  try { res.json(await catalogLifecycleOperations.inspect(req.params.id, 'disabled')) } catch (error) { next(error) }
})

catalogLibraryRouter.post('/catalog/models/:id/lifecycle/plan', async (req, res, next) => {
  try {
    res.json(await catalogLifecycleOperations.plan(req.params.id, req.body?.lifecycle as Lifecycle))
  } catch (error) { next(error) }
})

catalogLibraryRouter.post('/catalog/models/:id/lifecycle', async (req, res, next) => {
  try {
    const result = await catalogLifecycleOperations.apply({
      operationId: req.body?.operationId,
      modelId: req.params.id,
      defaultReplacements: req.body?.defaultReplacements,
      macroReplacements: req.body?.macroReplacements,
    })
    res.json(result.library)
  } catch (error) { next(error) }
})

catalogLibraryRouter.post('/catalog/drafts', async (req, res, next) => {
  try {
    await catalogLibrary.saveDraft(req.body?.model, req.body?.revision)
    res.json(catalogLibrary.view())
  } catch (error) { next(error) }
})
catalogLibraryRouter.post('/catalog/discover', async (req, res, next) => {
  try {
    const result = await discoverFalModel(req.body?.url)
    const existing = catalogLibrary.models().find(model => model.endpoint === result.model.endpoint)
    if (existing) { res.json({ existingModel: existing.id, issues: ['This model is already in the library.'] }); return }
    const current = catalogLibrary.view()
    const existingDraft = current.drafts.find(model => model.endpoint === result.model.endpoint)
    if (existingDraft) {
      // Re-discovering a draft is a read operation. Saving the fresh schema
      // again would clear a successful receipt (and can race the setup step),
      // even when the provider returned the same contract.
      if (req.body?.revision !== undefined && req.body.revision !== current.revision) {
        throw new CatalogLibraryError('Catalog changed in other window. Refresh list.', 409)
      }
      res.json({ library: current, issues: ['This model is already among the drafts; its pricing and test result were saved.'] })
      return
    }
    await catalogLibrary.saveDraft(result.model, req.body?.revision)
    res.json({ library: catalogLibrary.view(), issues: result.issues })
  } catch (error) { next(error) }
})
catalogLibraryRouter.post('/catalog/drafts/:id/setup', async (req, res, next) => {
  try {
    const revision = req.body?.revision
    if (!Number.isSafeInteger(revision) || revision < 0) throw new CatalogLibraryError('Provide current revision catalog', 409)
    const current = catalogLibrary.view()
    if (revision !== current.revision) throw new CatalogLibraryError('Catalog changed in other window. Refresh list.', 409)
    const draft = current.drafts.find(model => model.id === req.params.id)
    if (!draft) throw new CatalogLibraryError('Model draft not found', 404)
    const prepared = await prepareFalModelSetup(draft, { buildSamples: prepareFalModelTestSamples })
    if (prepared.persist) {
      await catalogLibrary.updateDraftTariff(req.params.id, {
        pricing: prepared.persist.pricing,
        textPricing: prepared.persist.textPricing,
        tariffSourceUrl: prepared.persist.sourceUrl,
        pricingNote: prepared.persist.pricingNote,
      }, revision)
    }
    res.json({
      library: catalogLibrary.view(),
      input: prepared.input,
      pricing: prepared.pricing,
      samples: prepared.samples,
      warnings: prepared.warnings,
    })
  } catch (error) { next(error) }
})
catalogLibraryRouter.patch('/catalog/drafts/:id/tariff', async (req, res, next) => {
  try {
    await catalogLibrary.updateDraftTariff(req.params.id, {
      pricing: req.body?.pricing,
      textPricing: req.body?.textPricing,
      tariffSourceUrl: req.body?.tariffSourceUrl,
    }, req.body?.revision)
    res.json(catalogLibrary.view())
  } catch (error) { next(error) }
})
catalogLibraryRouter.post('/catalog/drafts/:id/tests/quote', async (req, res, next) => {
  try {
    const params = req.body?.params
    const refs = req.body?.refs
    if (!params || typeof params !== 'object' || Array.isArray(params) || !Array.isArray(refs)) {
      throw new CatalogLibraryError('Invalid parameters test')
    }
    res.json(await catalogDraftTestService.quote(req.params.id, params, refs as IncomingRef[]))
  } catch (error) { next(error) }
})
catalogLibraryRouter.post('/catalog/drafts/:id/tests', async (req, res, next) => {
  try {
    const params = req.body?.params
    const refs = req.body?.refs
    if (!params || typeof params !== 'object' || Array.isArray(params) || !Array.isArray(refs)) {
      throw new CatalogLibraryError('Invalid parameters test')
    }
    const job = await catalogDraftTestService.start({
      draftId: req.params.id,
      prompt: req.body?.prompt,
      refs: refs as IncomingRef[],
      params,
      idempotencyKey: req.body?.idempotencyKey,
      confirmedAmountUsd: req.body?.confirmedAmountUsd,
    })
    res.status(202).json({ jobId: job.id, status: job.status })
  } catch (error) { next(error) }
})
catalogLibraryRouter.get('/catalog/drafts/:id/tests/:jobId', async (req, res, next) => {
  try {
    res.json(await catalogDraftTestService.status(req.params.id, req.params.jobId))
  } catch (error) { next(error) }
})
catalogLibraryRouter.post('/catalog/drafts/:id/publish', async (req, res, next) => {
  try {
    await catalogLibrary.publish(req.params.id, req.body?.revision)
    applyCatalogLibrary()
    res.json(catalogLibrary.view())
  } catch (error) { next(error) }
})

catalogLibraryRouter.post('/catalog/macros/:id/migrate', async (req, res, next) => {
  try {
    const macro = (await workflowStore.listMacros()).find(m => m.id === req.params.id)
    if (!macro) throw new CatalogLibraryError('Macro not found', 404)
    if (macro.revision !== req.body?.revision) throw new CatalogLibraryError('Macro changed. Refresh list.', 409)
    const models = catalogLibrary.models()
    const target = models.find(model => model.id === req.body?.targetModel)
    if (!target || typeof req.body?.fromModel !== 'string') throw new CatalogLibraryError('Select new model')
    const sources = familyIds(req.body.fromModel)
    if (!sources.some(id => modelUses(macro.graph, id).length)) throw new CatalogLibraryError('The model specified in the macro was not found', 409)
    const graph = sources.reduce<unknown>((graph, id) => migrateGraphModel(graph, id, target, models), macro.graph)
    // Durable prior version before CAS-save. Active runs own a separate graph snapshot.
    const archive = path.join(path.dirname(config.projectFile), 'macro-versions')
    await fs.mkdir(archive, { recursive: true })
    const safeId = /^[A-Za-z0-9_-]+$/.test(macro.id) ? macro.id : null
    if (!safeId) throw new CatalogLibraryError('Invalid ID macro')
    await fs.writeFile(path.join(archive, `${safeId}.${macro.revision}.json`), JSON.stringify(macro, null, 2), { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    res.json({ macro: await workflowStore.saveMacro(macro.name, graph, macro.id, macro.slot, macro.revision, macro.scope) })
  } catch (error) { next(error) }
})

catalogLibraryRouter.use((error: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
  const response = catalogLibraryErrorResponse(error)
  res.status(response.status).json(response.body)
})
