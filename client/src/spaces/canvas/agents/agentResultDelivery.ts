import type { AgentTaskView, ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'

/**
 * Materialize only Host-staged local results.  A normal project save is the
 * durable receipt: Host then promotes these entries to `canvasItems`.  The
 * completed list is historical state and must not be replayed into a board
 * after a user has removed the item.
 */
export function deliverAgentResults(
  store: CanvasStore,
  projectRef: ProjectRef,
  task: AgentTaskView,
): void {
  if (task.projectRef.source !== projectRef.source || task.projectRef.id !== projectRef.id) return
  // Cloud Host delivery is already a canonical board operation. Replaying it
  // through CanvasStore would create a second item.add/outbox writer before
  // the board stream arrives, so Cloud results are observed from that stream.
  if (projectRef.source === 'cloud') return
  const pending = task.pendingCanvasItems ?? []
  if (pending.length === 0) return
  store.placeAgentResults(task.taskId, pending, task.artifacts)
}
