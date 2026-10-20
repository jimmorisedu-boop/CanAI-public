import type { AgentGenerationCaptureReceipt, AgentInputItem, AgentTaskEvent, AgentTaskView } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { agentStageLabel } from './agentPanelPresentation'
import type { AgentTaskProgress } from './agentPanelModel'

export function eventTask(event: AgentTaskEvent | AgentTaskView): AgentTaskView | null {
  if ('taskId' in event && 'revision' in event && 'state' in event) return event
  const record = event as unknown as Record<string, unknown>
  const payload = record.payload
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const nested = record.task ?? record.snapshot
    ?? (value && ('task' in value ? value.task : 'snapshot' in value ? value.snapshot : undefined))
  if (!nested || typeof nested !== 'object') return null
  const task = nested as AgentTaskView
  return typeof task.taskId === 'string' && typeof task.revision === 'number' ? task : null
}

export function eventProgress(event: AgentTaskEvent | AgentTaskView): { taskId: string; progress: AgentTaskProgress; revision?: number } | null {
  if ('taskId' in event && 'revision' in event && 'state' in event) return null
  const record = event as unknown as Record<string, unknown>
  if (record.type !== 'task.progress' && record.type !== 'agent.progress') return null
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : null
  if (!payload || typeof record.taskId !== 'string') return null
  const stageId = typeof payload.stageId === 'string' ? payload.stageId : ''
  const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label : agentStageLabel(stageId)
  const status = typeof payload.status === 'string' ? payload.status : 'running'
  if (!stageId || !label) return null
  const progress: AgentTaskProgress = { stageId, label, status }
  const eventState = payload.state
  if (eventState === 'queued' || eventState === 'running' || eventState === 'awaiting_review' || eventState === 'awaiting_input' || eventState === 'awaiting_connection' || eventState === 'pausing' || eventState === 'paused' || eventState === 'cancelling' || eventState === 'cancelled' || eventState === 'succeeded' || eventState === 'failed' || eventState === 'uncertain') {
    progress.state = eventState
  }
  if (typeof payload.completed === 'number') progress.completed = payload.completed
  if (typeof payload.total === 'number') progress.total = payload.total
  return {
    taskId: record.taskId,
    progress,
    revision: typeof payload.revision === 'number' ? payload.revision : undefined,
  }
}

export function eventTaskId(event: AgentTaskEvent | AgentTaskView): string | null {
  const value = event as unknown as Record<string, unknown>
  return typeof value.taskId === 'string' ? value.taskId : null
}

export function agentInputFromCanvasItem(item: ReturnType<CanvasStore['getSelectedItems']>[number]): AgentInputItem {
  const kind: AgentInputItem['kind'] = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio'
    ? item.kind
    : 'text'
  const text = item.text ?? item.name ?? item.src ?? item.id
  return {
    itemId: item.id,
    artifactId: item.assetId ?? item.id,
    revision: 1,
    checksum: item.assetId ?? item.src ?? item.id,
    kind,
    caption: item.name ?? text.slice(0, 120),
    ...(item.text ? { text: item.text } : {}),
    ...(item.naturalWidth ? { width: item.naturalWidth } : {}),
    ...(item.naturalHeight ? { height: item.naturalHeight } : {}),
    ...(item.duration ? { durationMs: Math.round(item.duration * 1000) } : {}),
  }
}

/**
 * Replace browser-derived media identity fields with the Host-owned capture
 * receipt before creating a paid generation task.  The browser's src/assetId
 * is useful for the ordinary task input, but it is never the checksum
 * authority for generation.request.
 */
export function applyCapturedArtifacts(
  inputs: readonly AgentInputItem[],
  receipts: readonly AgentGenerationCaptureReceipt[] | undefined,
): AgentInputItem[] {
  if (!receipts || receipts.length === 0) return inputs.map((input) => ({ ...input }))
  const byItemId = new Map(receipts.map((receipt) => [receipt.itemId, receipt.artifact]))
  return inputs.map((input) => {
    const artifact = byItemId.get(input.itemId)
    if (!artifact || artifact.kind !== input.kind) return { ...input }
    return {
      ...input,
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      checksum: artifact.checksum,
      caption: artifact.caption,
    }
  })
}
