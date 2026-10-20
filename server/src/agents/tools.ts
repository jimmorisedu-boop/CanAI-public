import type { AgentTool } from '../../../packages/agent-protocol/index.js'
import type { AgentConnection, AgentGenerationAuthorization, AgentGenerationBudgetView, AgentGenerationGrantSpec, AgentGrant, AgentLlmAuthorization, AgentLlmBudgetView, AgentLlmCatalogView, AgentSpendBudgetView } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'
import { copyArtifact } from './tool-artifact.js'
import { readMedia } from './tool-media-read.js'
import { cancelMediaRenders, renderMedia } from './tool-media-render.js'
import { createResults } from './tool-results.js'
import { requireDeliverableResults } from './result-review-gate.js'
import {
  AgentToolError,
    type ToolBrokerOptions,
  type ToolResult,
  createSharedSpendBudget,
  record,
} from './tool-shared.js'

export {
  AgentToolError,
    type ToolBrokerOptions,
  type ToolResult,
} from './tool-shared.js'
import type { AgentLlmBroker } from './llm-broker.js'
import { artifactForRef, estimateMicros, modelParamCheck, validateModelRefs } from './generation-broker-helpers.js'

export class AgentToolBroker {
  constructor(private readonly options: ToolBrokerOptions) {}

  prepareLlmTask(taskId: string, projectSource: 'local', permissions: string[], authorization?: AgentLlmAuthorization): AgentLlmBudgetView | undefined {
    if (!this.options.llm) {
      if (permissions.includes('llm.request') || authorization) throw new AgentToolError('LLM_UNAVAILABLE', 'LLM broker is not configured in this Host')
      return undefined
    }
    return this.options.llm.prepareTask(taskId, projectSource, permissions, authorization)
  }

  prepareGenerationTask(
    taskId: string,
    projectSource: 'local',
    permissions: string[],
    authorization?: AgentGenerationAuthorization,
    existingBudget?: AgentGenerationBudgetView,
  ): AgentGenerationBudgetView | undefined {
    if (!this.options.generation) {
      if (permissions.includes('generation.request') || authorization) throw new AgentToolError('GENERATION_UNAVAILABLE', 'Generation broker is not configured in this Host')
      return undefined
    }
    return this.options.generation.prepareTask(taskId, projectSource, permissions, authorization, existingBudget)
  }

  createSpendBudget(taskId: string, llmBudget?: AgentLlmBudgetView, generationBudget?: AgentGenerationBudgetView): AgentSpendBudgetView | undefined {
    return createSharedSpendBudget(taskId, llmBudget, generationBudget)
  }

  /**
   * The bundled Creator must receive one Host-calculated media pin.  Keep this
   * calculation outside the generation broker so the package cannot invent an
   * estimate or silently change the selected catalog defaults.
   */
  generationGrantSpec(task: AgentTaskRecord): AgentGenerationGrantSpec | undefined {
    if (task.packageId !== 'canai.creator' || !task.generationBudget || Boolean(task.generationBudget.pins?.length) || !this.options.generation) return undefined
    const catalog = this.options.generation.catalogView()
    const model = catalog.models.find((candidate) => candidate.id === task.generationBudget!.modelId)
    if (!model || (model.kind !== 'image' && model.kind !== 'video' && model.kind !== 'audio') || model.lifecycle !== 'active') {
      throw new AgentToolError('GENERATION_MODEL_UNSUPPORTED', 'Pinned Creator media model is unavailable')
    }
    if (task.generationBudget.catalogRevision !== catalog.revision) {
      throw new AgentToolError('GENERATION_CATALOG_STALE', 'Pinned Creator media catalog is stale')
    }
    const params = structuredClone(task.generationParams ?? {})
    modelParamCheck(model, params)
    const refs = (task.generationBudget.artifactRefs ?? []).map((ref) => artifactForRef(task, ref))
    validateModelRefs(model, refs)
    return {
      kind: model.kind,
      modelId: model.id,
      catalogRevision: catalog.revision,
      params,
      // Без промпта: его ещё нет. Creator отдаёт это число в ревью как есть,
      // поэтому цена, зависящая от длины текста, здесь — отказ (см. estimateMicros).
      estimateMicros: estimateMicros(model, params, refs),
    }
  }

  /** Admission hook used by Host before the child process is launched. */
  assertGenerationGrant(task: AgentTaskRecord): void {
    this.generationGrantSpec(task)
  }

  computeGenerationSpec(task: AgentTaskRecord, rawInput: unknown) {
    if (!this.options.generation) throw new AgentToolError('GENERATION_UNAVAILABLE', 'Generation broker is not configured in this Host')
    return this.options.generation.computeGenerationSpec(task, rawInput)
  }

  llmCatalog(): AgentLlmCatalogView {
    if (!this.options.llm) return { revision: 0, connection: { id: 'local-fal', kind: 'llm', status: 'unavailable' }, defaultModelId: null, models: [] }
    return this.options.llm.catalogView()
  }

  generationCatalog(): ReturnType<NonNullable<ToolBrokerOptions['generation']>['catalogView']> {
    if (!this.options.generation) return {
      revision: 0,
      connection: { id: 'local-fal', kind: 'generation', status: 'unavailable' },
      models: [],
    }
    return this.options.generation.catalogView()
  }

  llmStartAccess(task: AgentTaskRecord): ReturnType<AgentLlmBroker['startAccess']> {
    return this.options.llm?.startAccess(task) ?? { connections: [], grants: [] }
  }

  startAccess(task: AgentTaskRecord): { connections: AgentConnection[]; grants: AgentGrant[] } {
    if (task.spendBudget) {
      const connections: AgentConnection[] = []
      if (task.llmBudget) connections.push({ id: 'local-fal', kind: 'llm', status: this.options.llm?.connectionStatus() ?? 'unavailable' })
      if (task.generationBudget) connections.push({ id: 'local-fal', kind: 'generation', status: this.options.generation?.connectionStatus() ?? 'unavailable' })
      const refs = task.generationBudget?.artifactRefs ?? []
      const maxCalls = (task.llmBudget?.maxCalls ?? 0) + (task.generationBudget?.maxCalls ?? 0)
      const generationSpec = this.generationGrantSpec(task)
      return {
        connections,
        grants: [{
          id: task.spendBudget.grantId,
          tools: [
            ...(task.llmBudget ? ['llm.request' as const] : []),
            ...(task.generationBudget ? ['generation.request' as const] : []),
          ],
          connectionId: 'local-fal',
          artifactRefs: structuredClone(refs),
          maxCalls: Math.max(1, Math.min(maxCalls, task.spendBudget.maxCalls)),
          maxCost: { currency: 'USD', amountMicros: task.spendBudget.maxCostMicros },
          status: task.spendBudget.status === 'active' ? 'active' : 'exhausted',
          ...(generationSpec ? { generationSpec } : {}),
        }],
      }
    }
    const llm = this.llmStartAccess(task)
    const generation = this.options.generation?.startAccess(task) ?? { connections: [], grants: [] }
    const connections = [...llm.connections]
    for (const connection of generation.connections) {
      if (!connections.some((candidate) => candidate.id === connection.id && candidate.kind === connection.kind)) connections.push(connection)
    }
    const grants = [...llm.grants]
    for (const grant of generation.grants) {
      const existing = grants.find((candidate) => candidate.id === grant.id)
      if (!existing) grants.push(grant)
      else {
        existing.tools = Array.from(new Set([...existing.tools, ...grant.tools]))
        existing.artifactRefs = grant.artifactRefs.length ? grant.artifactRefs : existing.artifactRefs
        existing.maxCalls = Math.max(existing.maxCalls, grant.maxCalls)
        existing.maxCost.amountMicros = Math.max(existing.maxCost.amountMicros, grant.maxCost.amountMicros)
        if (grant.status !== 'active') existing.status = grant.status
      }
    }
    const generationSpec = this.generationGrantSpec(task)
    if (generationSpec) {
      const grant = grants.find((candidate) => candidate.tools.includes('generation.request'))
      if (grant) grant.generationSpec = generationSpec
    }
    return { connections, grants }
  }

  async cancelExternal(task: AgentTaskRecord): Promise<void> {
    // Свой ffmpeg гасим первым: это мгновенно, без сети и не может упасть.
    // Платные брокеры — строго по очереди, как и было: их отмена ходит к
    // провайдеру и пишет в общий журнал расходов.
    cancelMediaRenders(task.taskId)
    await this.options.llm?.cancelTask(task)
    await this.options.generation?.cancelTask(task)
  }

  /**
   * Reconcile journaled paid work after Host restart.  This method deliberately
   * has no task-state admission: each broker only resumes a saved provider/job
   * ID against its immutable model snapshot and never starts a new operation.
   */
  async recoverPersisted(task: AgentTaskRecord): Promise<void> {
    await Promise.all([
      this.options.llm?.recoverPersisted(task),
      this.options.generation?.recoverPersisted(task),
    ])
  }

  async execute(task: AgentTaskRecord, tool: AgentTool, rawArguments: unknown, operationId = 'operation'): Promise<ToolResult> {
    const args = record(rawArguments, 'arguments')
    if (tool === 'artifact.publish') {
      const artifact = await copyArtifact(task, args, operationId)
      return { result: { artifact } }
    }
    if (tool === 'media.read') {
      return readMedia(task, this.options.mediaDir, args, { link: this.options.linkFile })
    }
    if (tool === 'media.render') {
      return renderMedia(task, this.options.mediaDir, args, operationId, this.options.mediaRender)
    }
    if (tool === 'canvas.create_results') {
      requireDeliverableResults(task, args)
      return createResults(task, args, operationId, this.options)
    }
    if (tool === 'canvas.read_selected') {
      return { result: { items: structuredClone(Array.isArray(task.inputs) ? task.inputs : []) } }
    }
    if (tool === 'llm.request') {
      if (!this.options.llm) throw new AgentToolError('LLM_UNAVAILABLE', 'LLM broker is not configured in this Host')
      return this.options.llm.execute(task, rawArguments, operationId)
    }
    if (tool === 'generation.quote') {
      if (!this.options.generation) throw new AgentToolError('GENERATION_UNAVAILABLE', 'Generation broker is not configured in this Host')
      return this.options.generation.quote(task, rawArguments, operationId)
    }
    if (tool === 'generation.request') {
      if (!this.options.generation) throw new AgentToolError('GENERATION_UNAVAILABLE', 'Generation broker is not configured in this Host')
      return this.options.generation.execute(task, rawArguments, operationId)
    }
    throw new AgentToolError('UNSUPPORTED_TOOL', 'Tool ' + tool + ' is not yet supported by the local Host')
  }
}
