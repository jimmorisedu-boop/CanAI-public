import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogModel } from './catalog.js'
import {
  applyCatalogLibrary,
  catalogFamilyIds,
  catalogLibrary,
  CatalogLibraryError,
  type CatalogDefaults,
  type CatalogDefaultSlot,
  type Lifecycle,
} from './catalogLibrary.js'
import { config } from './config.js'
import {
  MacroNotFoundError,
  MacroRevisionConflictError,
  workflowStore,
  type Macro,
} from './workflows.js'
import { modelUses } from '../../packages/model-catalog/macroModels.js'

const DEFAULT_SLOTS: CatalogDefaultSlot[] = ['image', 'video', 'audio', 'assistant']

export interface CatalogLifecycleMacroImpact {
  id: string
  name: string
  revision: number
  nodeIds: string[]
}

export interface CatalogLifecyclePlan {
  operationId: string
  modelId: string
  target: Lifecycle
  catalogRevision: number
  familyIds: string[]
  affectedDefaults: CatalogDefaultSlot[]
  macros: CatalogLifecycleMacroImpact[]
  replacementModels: Array<Pick<CatalogModel, 'id' | 'name' | 'kind'>>
}

type OperationPhase = 'planned' | 'macros-migrated' | 'catalog-updated' | 'complete'

interface CatalogLifecycleOperation extends CatalogLifecyclePlan {
  phase: OperationPhase
  defaultReplacements?: Partial<CatalogDefaults>
  macroReplacements?: Record<string, string>
  createdAt: number
  updatedAt: number
}

interface OperationJournal {
  version: 1
  operations: CatalogLifecycleOperation[]
}

interface CatalogLibraryPort {
  models(): CatalogModel[]
  view(): { revision: number; defaults: CatalogDefaults; models: CatalogModel[] }
  applyLifecycleChange(
    id: string,
    lifecycle: Lifecycle,
    defaultReplacements: Partial<CatalogDefaults>,
    expected: number,
  ): Promise<void>
}

interface WorkflowStorePort {
  listMacros(): Promise<Macro[]>
  migrateModelsBatch(input: {
    fromFamily: string[]
    replacements: Array<{ macroId: string; revision: number; targetModelId: string }>
    models: CatalogModel[]
  }): Promise<Macro[]>
}

export class CatalogLifecycleOperationError extends CatalogLibraryError {}

function publicPlan(operation: CatalogLifecycleOperation): CatalogLifecyclePlan {
  const { operationId, modelId, target, catalogRevision, familyIds, affectedDefaults, macros, replacementModels } = operation
  return structuredClone({ operationId, modelId, target, catalogRevision, familyIds, affectedDefaults, macros, replacementModels })
}

function sameRecord(left: object | undefined, right: object): boolean {
  const sorted = (value: object | undefined) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

export class CatalogLifecycleOperations {
  private journal: OperationJournal = { version: 1, operations: [] }
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly library: CatalogLibraryPort,
    private readonly workflows: WorkflowStorePort,
    private readonly applyRuntime: () => void | Promise<void>,
  ) {}

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(run)
    this.queue = pending.catch(() => {})
    return pending
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as OperationJournal
      if (parsed.version !== 1 || !Array.isArray(parsed.operations)) throw new Error('Invalid log operations catalog')
      this.journal = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const incomplete = this.journal.operations.filter(operation => operation.phase !== 'complete')
    const completed = this.journal.operations.filter(operation => operation.phase === 'complete').slice(-20)
    this.journal.operations = [...incomplete, ...completed]
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(this.journal, null, 2))
      await fs.rename(tmp, this.file)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  private impactFor(modelId: string, target: Lifecycle, macros: Macro[]): Omit<CatalogLifecyclePlan, 'operationId'> {
    if (!['active', 'archived', 'disabled'].includes(target)) throw new CatalogLifecycleOperationError('Unknown model state')
    const view = this.library.view()
    const source = view.models.find(model => model.id === modelId)
    if (!source) throw new CatalogLifecycleOperationError('Model not found', 404)
    const familyIds = catalogFamilyIds(view.models, modelId)
    const removing = target !== 'active'
    const affectedDefaults = removing
      ? DEFAULT_SLOTS.filter(slot => view.defaults[slot] !== null && familyIds.includes(view.defaults[slot]!))
      : []
    // Архивная модель остаётся исполняемой для уже сохранённых досок и
    // макросов. Перенос макросов обязателен только при полном отключении.
    const impactedMacros = target === 'disabled'
      ? macros.map(macro => ({
          id: macro.id,
          name: macro.name,
          revision: macro.revision,
          nodeIds: [...new Set(familyIds.flatMap(id => modelUses(macro.graph, id)))],
        })).filter(macro => macro.nodeIds.length > 0)
      : []
    const pairedIds = new Set(view.models.flatMap(model => (
      [model.pairId, model.videoPairId].filter((id): id is string => Boolean(id))
    )))
    const replacementModels = removing
      ? view.models.filter(model => (
          model.kind === source.kind
          && (model.lifecycle ?? 'active') === 'active'
          && !familyIds.includes(model.id)
          && !pairedIds.has(model.id)
        )).map(({ id, name, kind }) => ({ id, name, kind }))
      : []
    return {
      modelId,
      target,
      catalogRevision: view.revision,
      familyIds,
      affectedDefaults,
      macros: impactedMacros,
      replacementModels,
    }
  }

  async inspect(modelId: string, target: Lifecycle = 'disabled'): Promise<Omit<CatalogLifecyclePlan, 'operationId'>> {
    return this.impactFor(modelId, target, await this.workflows.listMacros())
  }

  async plan(modelId: string, target: Lifecycle): Promise<CatalogLifecyclePlan> {
    return this.serialized(async () => {
      await this.load()
      const impact = this.impactFor(modelId, target, await this.workflows.listMacros())
      const operation: CatalogLifecycleOperation = {
        operationId: randomUUID(),
        ...impact,
        phase: 'planned',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.journal.operations.push(operation)
      await this.save()
      return publicPlan(operation)
    })
  }

  private validateSelections(
    operation: CatalogLifecycleOperation,
    defaultReplacements: Partial<CatalogDefaults>,
    macroReplacements: Record<string, string>,
  ): void {
    const models = this.library.models()
    const source = models.find(model => model.id === operation.modelId)
    if (!source) throw new CatalogLifecycleOperationError('Model not found', 404)
    const pairedIds = new Set(models.flatMap(model => (
      [model.pairId, model.videoPairId].filter((id): id is string => Boolean(id))
    )))
    const validTarget = (id: string | null | undefined) => models.find(model => (
      model.id === id
      && model.kind === source.kind
      && (model.lifecycle ?? 'active') === 'active'
      && !operation.familyIds.includes(model.id)
    ))
    for (const slot of operation.affectedDefaults) {
      const target = validTarget(defaultReplacements[slot])
      if (!target || pairedIds.has(target.id)) {
        throw new CatalogLifecycleOperationError(`Select a replacement for default “${slot}»`)
      }
    }
    for (const macro of operation.macros) {
      if (!validTarget(macroReplacements[macro.id])) {
        throw new CatalogLifecycleOperationError(`Select a replacement for macro “${macro.name}»`)
      }
    }
  }

  private async macrosAlreadyMigrated(operation: CatalogLifecycleOperation): Promise<boolean> {
    const byId = new Map((await this.workflows.listMacros()).map(macro => [macro.id, macro]))
    return operation.macros.every(planned => {
      const current = byId.get(planned.id)
      const target = operation.macroReplacements?.[planned.id]
      return Boolean(current && target && current.revision === planned.revision + 1
        && !operation.familyIds.some(id => modelUses(current.graph, id).length)
        && modelUses(current.graph, target).length)
    })
  }

  private catalogAlreadyUpdated(operation: CatalogLifecycleOperation): boolean {
    const view = this.library.view()
    if (view.revision !== operation.catalogRevision + 1) return false
    if (!operation.familyIds.every(id => view.models.find(model => model.id === id)?.lifecycle === operation.target)) return false
    return operation.affectedDefaults.every(slot => view.defaults[slot] === operation.defaultReplacements?.[slot])
  }

  async apply(input: {
    operationId: string
    modelId: string
    defaultReplacements?: Partial<CatalogDefaults>
    macroReplacements?: Record<string, string>
  }): Promise<{ phase: 'complete'; library: ReturnType<CatalogLibraryPort['view']> }> {
    return this.serialized(async () => {
      await this.load()
      const operation = this.journal.operations.find(item => item.operationId === input.operationId)
      if (!operation || operation.modelId !== input.modelId) throw new CatalogLifecycleOperationError('Model-change plan not found', 404)
      if (operation.phase === 'complete') return { phase: 'complete', library: this.library.view() }

      const defaultReplacements = input.defaultReplacements ?? {}
      const macroReplacements = input.macroReplacements ?? {}
      if (operation.defaultReplacements && !sameRecord(operation.defaultReplacements, defaultReplacements)) {
        throw new CatalogLifecycleOperationError('Plan already applied with other replacements', 409)
      }
      if (operation.macroReplacements && !sameRecord(operation.macroReplacements, macroReplacements)) {
        throw new CatalogLifecycleOperationError('Plan already applied with other replacements', 409)
      }
      this.validateSelections(operation, defaultReplacements, macroReplacements)
      if (!operation.defaultReplacements) {
        operation.defaultReplacements = structuredClone(defaultReplacements)
        operation.macroReplacements = structuredClone(macroReplacements)
        operation.updatedAt = Date.now()
        await this.save()
      }

      if (operation.phase === 'planned') {
        if (this.library.view().revision !== operation.catalogRevision) {
          throw new CatalogLifecycleOperationError('Catalog changed in other window. Create new plan.', 409)
        }
        const recovered = operation.macros.length > 0 && await this.macrosAlreadyMigrated(operation)
        if (!recovered && operation.macros.length > 0) {
          try {
            await this.workflows.migrateModelsBatch({
              fromFamily: operation.familyIds,
              replacements: operation.macros.map(macro => ({
                macroId: macro.id,
                revision: macro.revision,
                targetModelId: operation.macroReplacements![macro.id]!,
              })),
              models: this.library.models(),
            })
          } catch (error) {
            if (error instanceof MacroNotFoundError) throw new CatalogLifecycleOperationError('Macro deleted. Create new plan.', 409)
            if (error instanceof MacroRevisionConflictError) throw new CatalogLifecycleOperationError('Macro changed. Create new plan.', 409)
            if (error instanceof Error && /(?:нода|модел|тип результата|референс|параметр|node|model|result type|reference|parameter)/i.test(error.message)) {
              throw new CatalogLifecycleOperationError(error.message)
            }
            throw error
          }
        }
        operation.phase = 'macros-migrated'
        operation.updatedAt = Date.now()
        await this.save()
      }

      if (operation.phase === 'macros-migrated') {
        if (!this.catalogAlreadyUpdated(operation)) {
          await this.library.applyLifecycleChange(
            operation.modelId,
            operation.target,
            operation.defaultReplacements ?? {},
            operation.catalogRevision,
          )
        }
        operation.phase = 'catalog-updated'
        operation.updatedAt = Date.now()
        await this.save()
      }

      if (operation.phase === 'catalog-updated') {
        await this.applyRuntime()
        operation.phase = 'complete'
        operation.updatedAt = Date.now()
        await this.save()
      }
      return { phase: 'complete', library: this.library.view() }
    })
  }
}

export const catalogLifecycleOperations = new CatalogLifecycleOperations(
  path.join(path.dirname(config.projectFile), 'catalog-lifecycle-operations.json'),
  catalogLibrary,
  workflowStore,
  applyCatalogLibrary,
)
