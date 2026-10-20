import crypto from 'node:crypto'
import type { AgentPackageRegistry } from './packages.js'
import type { AgentTaskJournal } from './journal.js'
import type { AgentTaskRecord } from './types.js'
import type { AgentToolBroker } from './tools.js'
import { AgentHostAdmission } from './host-admission.js'
import { validateCapturedArtifacts } from './generation-input-capture.js'
import { resolveWorkspacePath } from './host-path.js'
import { AgentHostError, type CreateAgentTaskInput, checkIdentifier, clone, hash } from './host-shared.js'

export interface AgentCreateContext {
  journal: AgentTaskJournal
  packages: AgentPackageRegistry
  broker: AgentToolBroker
  workspaceRoot: string
  mediaDir?: string
  admission: AgentHostAdmission
  ownerId?: string
  controllerId?: string
  now: () => number
  identity(value: string | undefined, fallback: string): string
  start(taskId: string): Promise<AgentTaskRecord>
}

export async function createAgentTask(context: AgentCreateContext, input: CreateAgentTaskInput): Promise<AgentTaskRecord> {
  const requestId = checkIdentifier(input.requestId, 'requestId')
  const packageId = checkIdentifier(input.packageId, 'packageId')
  const taskType = checkIdentifier(input.taskType, 'taskType')
  if (typeof input.instruction !== 'string' || !/\S/u.test(input.instruction) || input.instruction.length > 16_000) throw new AgentHostError('INPUT_INVALID', 'instruction is required')
  if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new AgentHostError('INPUT_INVALID', 'input must be an object')
  if (!input.projectRef || (input.projectRef.source !== 'local' && input.projectRef.source !== 'cloud')) throw new AgentHostError('INPUT_INVALID', 'Invalid projectRef.source')
  if (input.projectRef.source !== 'local') throw new AgentHostError('CLOUD_AGENT_DELIVERY_UNSUPPORTED', 'The local Host cannot execute a shared Cloud task', 409)
  const projectId = checkIdentifier(input.projectRef.id, 'projectRef.id')
  const requestHash = hash({ requestId, packageId, taskType, instruction: input.instruction, input: input.input, projectRef: input.projectRef, inputs: input.inputs ?? [], capturedArtifacts: input.capturedArtifacts ?? [], llm: input.llm ?? null, generation: input.generation ?? null })
  return context.admission.withRequestLock(requestId, async () => {
    const previous = await context.journal.findRequest(requestId)
    if (previous) {
      if (previous.requestHash !== requestHash) throw new AgentHostError('OPERATION_CONFLICT', 'requestId was already used with different parameters', 409)
      return previous
    }
    const capturedArtifacts = await validateCapturedArtifacts(
      input.capturedArtifacts,
      context.mediaDir,
      input.generation?.artifactRefs ?? [],
      projectId,
    )
    const inputRefs = new Set((input.inputs ?? []).map((item) => `${item.artifactId}\0${item.revision}\0${item.checksum}`))
    if ((input.generation?.artifactRefs ?? []).some((ref) => !inputRefs.has(`${ref.artifactId}\0${ref.revision}\0${ref.checksum}`))) {
      throw new AgentHostError('CAPTURE_INVALID', 'generation grant does not match task inputs', 409)
    }    return context.admission.withPackageLifecycleLock(async () => {
      // Re-read the active package after acquiring the shared lifecycle lock.
      // A concurrent disable/remove may have changed the registry while the
      // request was waiting; stale package objects must never become pins.
      const pkg = context.packages.get(packageId)
      const descriptor = pkg.manifest.taskTypes.find((entry) => entry.id === taskType)
      if (!descriptor) throw new AgentHostError('INPUT_INVALID', `Package does not support task type ${taskType}`)
      context.packages.assertTaskInput(pkg, taskType, input.input)
      if (input.generation) {
        if (descriptor.generation) {
          if (Array.isArray(input.generation.models) && input.generation.models.length > 0) {
            for (const pin of input.generation.models) {
              if (!descriptor.generation.kinds.includes(pin.kind)) {
                throw new AgentHostError('INPUT_INVALID', `Package does not support generation kind ${pin.kind}`)
              }
            }
          }
          if (input.generation.maxCalls !== undefined && input.generation.maxCalls > descriptor.generation.maxCalls) {
            throw new AgentHostError('BUDGET_INVALID', `Generation call count (${input.generation.maxCalls}) exceeds the manifest limit (${descriptor.generation.maxCalls})`)
          }
        } else {
          if ((Array.isArray(input.generation.models) && input.generation.models.length > 0) || (input.generation.maxCalls !== undefined && input.generation.maxCalls > 1)) {
            throw new AgentHostError('INPUT_INVALID', 'Package does not support multiple generation operations in one task')
          }
        }
      }
      if (input.llm && descriptor.llmCalls !== undefined) {
        const requestedLlmCalls = input.llm.maxCalls ?? 8
        if (requestedLlmCalls > descriptor.llmCalls) {
          throw new AgentHostError('BUDGET_INVALID', `LLM call count (${requestedLlmCalls}) exceeds the manifest limit (${descriptor.llmCalls})`)
        }
      }
      const packageReservation = context.admission.packageKey(pkg)
      context.admission.reservePackage(packageReservation, requestId, pkg.manifest.runtime.maxParallelTasks)
      const taskId = `agent-task-${crypto.randomUUID()}`
      try {
        const llmBudget = context.broker.prepareLlmTask(taskId, input.projectRef.source as 'local', pkg.manifest.permissions, input.llm)
        const generationBudget = context.broker.prepareGenerationTask?.(
          taskId,
          input.projectRef.source as 'local',
          pkg.manifest.permissions,
          input.generation,
        )
        const spendBudget = context.broker.createSpendBudget?.(taskId, llmBudget, generationBudget)
        await resolveWorkspacePath(context.workspaceRoot, taskId, true)
        const now = context.now()
        const task: AgentTaskRecord = {
          taskId, requestId, requestHash, packageId, packageVersion: pkg.manifest.version, packageSha: pkg.packageSha,
          ...(pkg.installationId ? { installationId: pkg.installationId } : {}), protocolVersion: '1.0',
          projectRef: { source: input.projectRef.source, id: projectId },
          ownerId: context.identity(context.ownerId, 'local-host-owner'),
          controllerId: context.identity(context.controllerId, context.ownerId ?? 'local-host-controller'),
          taskType, instruction: input.instruction, input: clone(input.input), inputs: clone(input.inputs ?? []),
          workspaceId: `workspace-${taskId}`, workspacePath: taskId, state: 'queued', revision: 1, eventCursor: 0,
          currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {}, ...(llmBudget ? { llmBudget } : {}), llmOperations: [], ...(generationBudget ? { generationBudget } : {}), generationOperations: [], mediaRenderOperations: [], ...(spendBudget ? { spendBudget } : {}), receipts: [], reviews: [], decisions: [], artifacts: capturedArtifacts, canvasItems: [], pendingCanvasItems: [], createdAt: now, updatedAt: now,
          ...(input.generation ? { generationParams: clone(input.generation.params ?? {}) } : {}),
        }
        // Validate the exact catalog defaults before a process is started.  A
        // stale/unsupported default must fail admission, not surface later as
        // a missing grant after the package has already begun execution.
        context.broker.assertGenerationGrant?.(task)
        await context.journal.create(task)
        context.admission.transferPackage(packageReservation, requestId, taskId, pkg.manifest.runtime.maxParallelTasks)
        const created = await context.journal.mutate(taskId, (entry) => { entry.state = 'queued' }, { type: 'task.created', payload: { requestId, projectRef: task.projectRef } })
        void context.start(taskId).catch(() => undefined)
        return created
      } catch (error) {
        context.admission.release(taskId)
        context.admission.release(requestId)
        throw error
      }
    })
  })
}
