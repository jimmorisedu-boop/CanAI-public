import type {
  AgentArtifact,
  AgentArtifactRef,
  AgentCheckpointPayload,
  AgentDecisionPayload,
  AgentError,
  AgentGenerationBudgetView,
  AgentSpendBudgetView,
  AgentLlmBudgetView,
  AgentMediaRenderManifest,
  AgentReviewView,
  AgentTaskEvent,
  AgentTaskState,
  AgentTaskView,
  AgentToolResultPayload,
  ProjectRef,
} from '../../../packages/agent-protocol/index.js'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'

export interface AgentReceipt extends AgentToolResultPayload {
  argumentsHash: string
  createdAt: number
}

export type AgentLlmOperationStatus =
  | 'reserved'
  | 'submitted'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'cancelled'

export interface AgentLlmOperation {
  operationId: string
  requestId: string
  argumentsHash: string
  receiptId: string
  status: AgentLlmOperationStatus
  modelId: string
  catalogRevision: number
  /**
   * The exact catalog model used for a submitted provider request.  A current
   * catalog is allowed to archive/retire a model after a process restart; a
   * saved request must still resume against the same provider contract.
   */
  modelSnapshot?: CatalogModel
  reservedMicros: number
  providerRequestId?: string
  providerEndpoint?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string; retryable: boolean }
  createdAt: number
  updatedAt: number
}

export type AgentGenerationOperationStatus =
  | 'reserved'
  | 'submitted'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'cancelled'

export interface AgentGenerationOperation {
  operationId: string
  requestId: string
  argumentsHash: string
  receiptId: string
  status: AgentGenerationOperationStatus
  modelId: string
  catalogRevision: number
  modelSnapshot?: CatalogModel
  reservedMicros: number
  jobId?: string
  providerRequestId?: string
  reviewKey?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string; retryable: boolean }
  createdAt: number
  updatedAt: number
}

/** Host-issued, non-paid render lineage kept out of the agent wire payload. */
export interface AgentMediaRenderOperation {
  operationId: string
  receiptId: string
  argumentsHash: string
  manifestHash: string
  sourceRefs: AgentArtifactRef[]
  artifact: AgentArtifactRef
  manifest: AgentMediaRenderManifest
  createdAt: number
  updatedAt: number
}

export interface AgentReviewRecord extends AgentReviewView {
  createdAt: number
}

export interface AgentTaskRecord {
  taskId: string
  requestId: string
  requestHash: string
  packageId: string
  packageVersion: string
  packageSha: string
  installationId?: string
  protocolVersion: '1.0'
  projectRef: ProjectRef
  /** Authenticated Cloud session identity captured when a Cloud task is created. */
  cloudBinding?: { serverUrl: string; journalScope: string }
  ownerId: string
  controllerId: string
  taskType: string
  instruction: string
  input: Record<string, unknown>
  inputs: AgentTaskView['inputs']
  workspaceId: string
  workspacePath: string
  state: AgentTaskState
  progress?: { stageId: string; label: string; status: string; completed?: number; total?: number }
  revision: number
  eventCursor: number
  checkpoint?: AgentCheckpointPayload
  checkpointFile?: string
  currentExecutionId?: string
  currentMessageAcks: Record<string, number>
  operationIntents: Record<string, { tool: string; argumentsHash: string; createdAt: number }>
  controlReceipts: Record<string, { action: 'pause' | 'resume' | 'cancel'; expectedRevision: number; reason: string; resultRevision: number }>
  decisionReceipts: Record<string, { reviewId: string; requestHash: string; resultRevision: number }>
  llmBudget?: AgentLlmBudgetView
  llmOperations?: AgentLlmOperation[]
  generationBudget?: AgentGenerationBudgetView
  /**
   * Exact media defaults selected at task admission.  This is private Host
   * state (never exposed by publicTask); the bundled Creator receives the
   * resulting catalog/price pin through its start grant.
   */
  generationParams?: Record<string, unknown>
  /** Canonical aggregate ledger shared by llm.request and generation.request. */
  spendBudget?: AgentSpendBudgetView
  generationOperations?: AgentGenerationOperation[]
  mediaRenderOperations?: AgentMediaRenderOperation[]
  receipts: AgentReceipt[]
  reviews: AgentReviewRecord[]
  decisions: AgentDecisionPayload[]
  artifacts: AgentArtifact[]
  canvasItems: Array<{ slotId: string; itemId: string; revision: number; artifactId: string }>
  /**
   * Results staged for an attached local board.  They are deliberately not
   * exposed as completed canvasItems until the browser saves the item and the
   * project route reports the durable revision back to the Host.
   */
  pendingCanvasItems: Array<{
    operationId: string
    waitId: string
    workspaceId: string
    slotId: string
    itemId: string
    revision: number
    artifactId: string
  }>
  error?: AgentError
  createdAt: number
  updatedAt: number
}

export interface AgentJournalEvent extends AgentTaskEvent {
  payload: Record<string, unknown>
}

export interface AgentJournalDocument {
  version: 1
  tasks: AgentTaskRecord[]
  events: Record<string, AgentJournalEvent[]>
}

export function publicTask(task: AgentTaskRecord): AgentTaskView {
  return {
    taskId: task.taskId,
    requestId: task.requestId,
    packageId: task.packageId,
    packageVersion: task.packageVersion,
    packageSha: task.packageSha,
    ...(task.installationId ? { installationId: task.installationId } : {}),
    protocolVersion: task.protocolVersion,
    projectRef: { ...task.projectRef },
    ownerId: task.ownerId,
    controllerId: task.controllerId,
    taskType: task.taskType,
    instruction: task.instruction,
    input: structuredClone(task.input),
    inputs: structuredClone(task.inputs),
    workspaceId: task.workspaceId,
    state: task.state,
    ...(task.llmBudget ? { llmBudget: structuredClone(task.llmBudget) } : {}),
    ...(task.generationBudget ? { generationBudget: structuredClone(task.generationBudget) } : {}),
    ...(task.spendBudget ? { spendBudget: structuredClone(task.spendBudget) } : {}),
    ...(task.progress ? { progress: structuredClone(task.progress) } : {}),
    revision: task.revision,
    eventCursor: task.eventCursor,
    ...(task.checkpoint ? { checkpoint: structuredClone(task.checkpoint) } : {}),
    reviews: structuredClone(task.reviews),
    receipts: structuredClone(task.receipts),
    artifacts: structuredClone(task.artifacts),
    canvasItems: structuredClone(task.canvasItems),
    pendingCanvasItems: structuredClone(task.pendingCanvasItems),
    ...(task.error ? { error: structuredClone(task.error) } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function cloneTask(task: AgentTaskRecord): AgentTaskRecord {
  return structuredClone(task)
}

/** Return the canonical ledger when present, preserving legacy task support. */
export function spendBudgetFor(task: AgentTaskRecord, fallback: AgentSpendBudgetView): AgentSpendBudgetView {
  return task.spendBudget ?? fallback
}

/** Mirror aggregate totals into legacy tool views for old UI/receipts. */
export function syncSpendBudget(task: AgentTaskRecord): void {
  const spend = task.spendBudget
  if (!spend) return
  for (const budget of [task.llmBudget, task.generationBudget]) {
    if (!budget) continue
    budget.grantId = spend.grantId
    budget.maxCostMicros = spend.maxCostMicros
    budget.reservedMicros = spend.reservedMicros
    budget.chargedMicros = spend.chargedMicros
    budget.overshootMicros = spend.overshootMicros
    budget.status = spend.status
  }
}

export function artifactRef(artifact: AgentArtifact): AgentArtifactRef {
  return { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }
}

/**
 * Операция монтажа Host, выпустившая этот артефакт, — или undefined.
 *
 * Признак «это собрал сам Host» держится на двух записях сразу: lineage в
 * mediaRenderOperations и succeeded-квитанция той же операции media.render.
 * Одного provenance: 'derived' мало — его может назвать и сам агент в
 * artifact.publish.
 */
export function hostRenderOperationFor(task: AgentTaskRecord, ref: AgentArtifactRef): AgentMediaRenderOperation | undefined {
  return (task.mediaRenderOperations ?? []).find((operation) =>
    operation.artifact.artifactId === ref.artifactId
    && operation.artifact.revision === ref.revision
    && operation.artifact.checksum === ref.checksum
    && task.receipts.some((receipt) =>
      receipt.receiptId === operation.receiptId
      && receipt.operationId === operation.operationId
      && receipt.tool === 'media.render'
      && receipt.status === 'succeeded'))
}
