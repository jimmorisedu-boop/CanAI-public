import type { AgentTaskState, AgentTool } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'
import { AgentHostError, TERMINAL } from './host-shared.js'

function blocked(message: string): AgentHostError {
  return new AgentHostError('TASK_NOT_RUNNING', message, 409)
}

function hasPendingReview(task: AgentTaskRecord): boolean {
  return task.reviews.some((review) => review.status === 'pending')
}

/**
 * Read-only inspection remains useful while waiting.  Publishing is also
 * allowed for a progress-only pre-review phase; once a review card exists,
 * every new side effect must wait for the human decision.
 */
export function assertToolState(task: AgentTaskRecord, tool: AgentTool): void {
  if (TERMINAL.has(task.state) || task.state === 'pausing' || task.state === 'cancelling' || task.state === 'queued') {
    throw blocked('New actions are forbidden in the current task state')
  }
  if (tool === 'canvas.read_selected') return
  if (task.state === 'running') return
  if (task.state === 'awaiting_review' && !hasPendingReview(task) && tool === 'artifact.publish') return
  throw blocked('New side effects are forbidden until the task resumes')
}

export function assertProgressState(task: AgentTaskRecord, next: AgentTaskState): void {
  if (TERMINAL.has(task.state) || task.state === 'pausing' || task.state === 'cancelling' || task.state === 'paused' || task.state === 'queued') {
    throw blocked('Late progress cannot change the task state')
  }
  if (task.state === 'awaiting_review' && hasPendingReview(task) && next !== 'awaiting_review') {
    throw blocked('Agent progress cannot clear a pending human decision')
  }
  if (next === 'awaiting_review' && task.state === 'running' && !hasPendingReview(task)) {
    throw blocked('Late progress cannot revive an approval that was already decided')
  }
  if (task.state === 'awaiting_input' && next !== 'awaiting_input') {
    throw blocked('Agent progress cannot clear pending input')
  }
  if (task.state === 'awaiting_connection' && next !== 'awaiting_connection') {
    throw blocked('Agent progress cannot clear a pending connection')
  }
}

export function assertFinishedState(task: AgentTaskRecord): void {
  if (TERMINAL.has(task.state) || task.state === 'pausing' || task.state === 'cancelling' || task.state === 'paused') {
    throw blocked('Completion received after the task was cancelled, paused, or finished')
  }
  if (task.state !== 'running' || hasPendingReview(task)) {
    throw blocked('Completion is forbidden until the task resumes by approval')
  }
}
