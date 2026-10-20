import type {
  AgentArtifact,
  AgentGenerationCaptureReceipt,
  AgentInputItem,
  AgentGenerationAuthorization,
  AgentLlmAuthorization,
  AgentLlmCatalogView,
  AgentPackageInstallationView,
  AgentPackageSummary,
  AgentReviewView,
  AgentSource,
  AgentTaskState,
  AgentTaskView,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'
import type { AgentPresentationCapability } from './agentCapabilities'
import type { AgentGenerationCatalog } from './agentGenerationModel'

export type AgentAction = 'pause' | 'resume' | 'cancel'

export interface AgentTaskProgress {
  stageId: string
  label: string
  status: string
  state?: AgentTaskState
  completed?: number
  total?: number
}

export interface AgentTaskSnapshot extends AgentTaskView {
  /** Local-only marker used while an optimistic command is awaiting Host. */
  optimisticAction?: AgentAction
  /** Progress is journaled as an event and is intentionally not global board state. */
  progress?: AgentTaskProgress
  /** Cloud peer summaries intentionally omit private task material. */
  redacted?: { instruction: boolean; inputs: boolean; checkpoint: boolean }
}

export interface AgentTaskStartPending {
  requestId: string
  packageId: string
  taskType: string
  instruction: string
  startedAt: number
}

export interface AgentPanelState {
  projectRef: ProjectRef
  connection: 'connecting' | 'live' | 'reconnecting' | 'offline'
  tasks: AgentTaskSnapshot[]
  packages: AgentPackageSummary[]
  installations: AgentPackageInstallationView[]
  llmCatalog: AgentLlmCatalogView | null
  generationCatalog: AgentGenerationCatalog | null
  pending: Record<string, AgentAction>
  pendingRequestIds: Record<string, string>
  retryRequestIds: Record<string, string>
  /** Snapshot captured before the optimistic action, for rejection rollback. */
  pendingBefore: Record<string, AgentTaskSnapshot>
  /** Stable request rows shown before the start POST receives an ACK. */
  pendingStarts: Record<string, AgentTaskStartPending>
  error: string | null
}

export interface AgentTaskLaunch {
  projectRef: ProjectRef
  packageId: string
  taskType: string
  instruction: string
  input: Record<string, unknown>
  inputs: AgentInputItem[]
  /** Native local Host receipts echoed only for generation admission. */
  capturedArtifacts?: AgentGenerationCaptureReceipt[]
  llm?: AgentLlmAuthorization
  generation?: AgentGenerationAuthorization
  packageVersion?: string
  packageSha?: string
  catalogRevision?: number
}

/**
 * Resolve controls from the transport grant and the selected task grant.
 *
 * Cloud advertises `canControl`/`canReview` at the transport level as false
 * because those rights are scoped to the owner of each durable task.  A task
 * DTO is therefore authoritative for Cloud, while a task-level false always
 * remains a server-owned downgrade.  Host keeps its legacy board-wide grant
 * when older task DTOs omit the optional fields.
 */
export function agentActionGrants(
  capability: Pick<AgentPresentationCapability, 'transport' | 'canControl' | 'canReview'> | undefined,
  task: Pick<AgentTaskSnapshot, 'canControl' | 'canReview'> | undefined,
): { canControl: boolean; canReview: boolean } {
  const canControl = capability?.transport !== 'cloud' && capability?.canControl === true && task?.canControl !== false
  const canReview = canControl && capability?.canReview !== false && task?.canReview !== false
  return { canControl, canReview }
}

export function makeAgentPanelState(projectRef: ProjectRef): AgentPanelState {
  return {
    projectRef,
    connection: 'connecting',
    tasks: [],
    packages: [],
    installations: [],
    llmCatalog: null,
    generationCatalog: null,
    pending: {},
    pendingRequestIds: {},
    retryRequestIds: {},
    pendingBefore: {},
    pendingStarts: {},
    error: null,
  }
}

function taskRevision(task: AgentTaskView): number {
  return Number.isSafeInteger(task.revision) && task.revision >= 0 ? task.revision : 0
}

function taskEventCursor(task: AgentTaskView): number {
  return Number.isSafeInteger(task.eventCursor) && task.eventCursor >= 0 ? task.eventCursor : 0
}

export function sameAgentProject(a: ProjectRef, b: ProjectRef): boolean {
  return a.source === b.source && a.id === b.id
}

/**
 * Merge a task update without allowing an older reconnect snapshot to erase a
 * newer optimistic action or a task from another board.
 */
export function reconcileAgentTask(
  state: AgentPanelState,
  incoming: AgentTaskSnapshot,
): AgentPanelState {
  if (!sameAgentProject(incoming.projectRef, state.projectRef)) return state
  const index = state.tasks.findIndex((task) => task.taskId === incoming.taskId)
  const current = index >= 0 ? state.tasks[index]! : undefined
  // A Cloud/SSE reconnect can replay a snapshot with the same revision.  The
  // event cursor is the remaining ordering signal; an older cursor must not
  // erase a newer review, terminal state, or optimistic action.
  if (current && (taskRevision(incoming) < taskRevision(current)
    || (taskRevision(incoming) === taskRevision(current)
      && taskEventCursor(incoming) < taskEventCursor(current)))) return state

  const pendingAction = state.pending[incoming.taskId]
  const receivedNewerRevision = Boolean(
    pendingAction
    && (taskRevision(incoming) > (current ? taskRevision(current) : -1)
      || (current
        && taskRevision(incoming) === taskRevision(current)
        && taskEventCursor(incoming) > taskEventCursor(current))),
  )
  const task = pendingAction && !receivedNewerRevision
    ? { ...incoming, optimisticAction: pendingAction }
    : { ...incoming }
  const tasks = index < 0
    ? [...state.tasks, task]
    : state.tasks.map((current, currentIndex) => currentIndex === index ? task : current)

  // The Host receipt is the commit point. A stale copy cannot clear a pending
  // action; only a newer task revision may do so.
  const pending = { ...state.pending }
  const pendingBefore = { ...state.pendingBefore }
  const pendingRequestIds = { ...state.pendingRequestIds }
  const retryRequestIds = { ...state.retryRequestIds }
  if (receivedNewerRevision) {
    delete pending[incoming.taskId]
    delete pendingBefore[incoming.taskId]
    delete pendingRequestIds[incoming.taskId]
    delete retryRequestIds[incoming.taskId]
  }
  const pendingStarts = { ...state.pendingStarts }
  if (incoming.requestId) delete pendingStarts[incoming.requestId]
  return { ...state, tasks, pending, pendingBefore, pendingRequestIds, retryRequestIds, pendingStarts }
}

export function reconcileAgentTasks(
  state: AgentPanelState,
  incoming: readonly AgentTaskSnapshot[],
): AgentPanelState {
  return incoming.reduce(reconcileAgentTask, state)
}

export function reconcileAgentTaskProgress(
  state: AgentPanelState,
  taskId: string,
  progress: AgentTaskProgress,
  revision?: number,
): AgentPanelState {
  const index = state.tasks.findIndex((task) => task.taskId === taskId)
  if (index < 0) return state
  const current = state.tasks[index]!
  if (typeof revision === 'number' && revision < taskRevision(current)) return state
  return {
    ...state,
    tasks: state.tasks.map((task, currentIndex) => currentIndex === index
      ? { ...task, progress, ...(progress.state && !task.optimisticAction ? { state: progress.state } : {}) }
      : task),
  }
}

/** Apply the button state synchronously; the network request may settle later. */
export function optimisticallyRequestAgentAction(
  state: AgentPanelState,
  taskId: string,
  action: AgentAction,
  requestId?: string,
): AgentPanelState {
  const task = state.tasks.find((candidate) => candidate.taskId === taskId)
  if (!task) return state
  const stateByAction: Partial<Record<AgentAction, AgentTaskState>> = {
    pause: 'pausing',
    resume: 'running',
    cancel: 'cancelling',
  }
  const optimisticState = stateByAction[action] ?? task.state
  return {
    ...state,
    pending: { ...state.pending, [taskId]: action },
    pendingRequestIds: { ...state.pendingRequestIds, [taskId]: requestId ?? state.pendingRequestIds[taskId] ?? '' },
    retryRequestIds: Object.fromEntries(Object.entries(state.retryRequestIds).filter(([id]) => id !== taskId)),
    pendingBefore: { ...state.pendingBefore, [taskId]: state.pendingBefore[taskId] ?? { ...task } },
    tasks: state.tasks.map((candidate) => candidate.taskId === taskId
      ? { ...candidate, state: optimisticState, optimisticAction: action }
      : candidate),
  }
}

export function rejectAgentAction(
  state: AgentPanelState,
  taskId: string,
  message: string,
): AgentPanelState {
  const pending = { ...state.pending }
  const pendingBefore = { ...state.pendingBefore }
  const pendingRequestIds = { ...state.pendingRequestIds }
  const retryRequestIds = { ...state.retryRequestIds }
  const previous = pendingBefore[taskId]
  const requestId = pendingRequestIds[taskId]
  delete pending[taskId]
  delete pendingBefore[taskId]
  delete pendingRequestIds[taskId]
  if (requestId) retryRequestIds[taskId] = requestId
  const current = state.tasks.find((task) => task.taskId === taskId)
  const canRollback = Boolean(
    previous
    && current?.optimisticAction
    && taskRevision(current) <= taskRevision(previous),
  )
  return {
    ...state,
    pending,
    pendingBefore,
    pendingRequestIds,
    retryRequestIds,
    error: message,
    tasks: state.tasks.map((task) => task.taskId !== taskId
      ? task
      : canRollback
        ? { ...previous!, optimisticAction: undefined }
        : { ...task, optimisticAction: undefined }),
  }
}

export function addPendingAgentStart(
  state: AgentPanelState,
  pending: AgentTaskStartPending,
): AgentPanelState {
  if (!pending.requestId) return state
  return {
    ...state,
    pendingStarts: { ...state.pendingStarts, [pending.requestId]: pending },
  }
}

export function rejectPendingAgentStart(
  state: AgentPanelState,
  requestId: string,
  message: string,
): AgentPanelState {
  const pendingStarts = { ...state.pendingStarts }
  delete pendingStarts[requestId]
  return { ...state, pendingStarts, error: message }
}

/** Stable key used by result delivery and by tests guarding duplicate events. */
export function agentResultKey(taskId: string, artifact: Pick<AgentArtifact, 'artifactId' | 'revision'>): string {
  return `agent:${taskId}:${artifact.artifactId}:r${artifact.revision}`
}

export function taskReview(task: AgentTaskView): AgentReviewView | undefined {
  // A stale snapshot can carry the previous pending card after a terminal
  // receipt.  It must not leave a poisoned decision form on screen or invite
  // a review for work that is already finished/cancelled.
  if (task.state !== 'awaiting_review') return undefined
  return task.reviews.find((review) => review.status === 'pending')
}

/** A decision is valid only for the currently displayed pending card. */
export function isCurrentAgentReview(task: AgentTaskView, reviewId: string): boolean {
  return task.state === 'awaiting_review'
    && task.reviews.some((review) => review.reviewId === reviewId && review.status === 'pending')
}

export interface AgentOutputSummary {
  /** Every durable artifact, including superseded/intermediate revisions. */
  materialCount: number
  /** Canonical results already attached to the board. */
  placedCount: number
  /** Results accepted by the Host but waiting for a local canvas save. */
  pendingPlacementCount: number
}

/**
 * Keep output semantics explicit.  Do not deduplicate artifacts by caption or
 * text: a changes-requested review may legitimately publish several versions
 * while only one canonical result is placed on the board.
 */
export function agentOutputSummary(task: Pick<AgentTaskSnapshot, 'artifacts' | 'canvasItems' | 'pendingCanvasItems'>): AgentOutputSummary {
  return {
    materialCount: task.artifacts.length,
    placedCount: task.canvasItems.length,
    pendingPlacementCount: task.pendingCanvasItems?.length ?? 0,
  }
}

export function selectedInputIds(task: AgentTaskView): string[] {
  return task.inputs.map((item) => item.itemId)
}

export function isAgentTaskActive(state: AgentTaskState): boolean {
  return state === 'queued'
    || state === 'running'
    || state === 'awaiting_review'
    || state === 'awaiting_input'
    || state === 'awaiting_connection'
    || state === 'pausing'
    || state === 'cancelling'
    || state === 'uncertain'
}

export function isAgentTaskTerminal(state: AgentTaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function taskProgressForDisplay(
  task: Pick<AgentTaskSnapshot, 'state' | 'progress'>,
): AgentTaskProgress | undefined {
  return isAgentTaskTerminal(task.state) ? undefined : task.progress
}

export function sourceLabel(source: AgentSource): string {
  return source === 'local' ? 'Local board' : 'Unavailable board'
}
