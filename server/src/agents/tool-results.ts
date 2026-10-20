import { mutateProjectSnapshot } from '../projects.js'
import { boardBusy, presenceWarmingUp } from '../boardPresence.js'
import type { AgentTaskRecord } from './types.js'
import {
  AgentToolError,
  SAFE_PROJECT,
  type CanvasResultItem,
    type PreparedCanvasItem,
  type PreparedCanvasResult,
  type ToolBrokerOptions,
  type ToolResult,
  projectId,
  record,
  safeSegment,
  stableId,
  stableScopedId,
  text,
} from './tool-shared.js'

function finiteOffset(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000 ? value : fallback
}

function prepareCanvasResults(task: AgentTaskRecord, args: Record<string, unknown>): PreparedCanvasResult {
  const workspaceId = text(args.workspaceId, 'workspaceId')
  if (workspaceId !== task.workspaceId) throw new AgentToolError('TASK_MISMATCH', 'workspaceId does not belong to the task')
  const entries = Array.isArray(args.items) ? args.items : []
  if (entries.length < 1 || entries.length > 100) throw new AgentToolError('INPUT_INVALID', 'canvas.create_results.items is empty')
  const created: CanvasResultItem[] = []
  const canvasItems: PreparedCanvasItem[] = []
  let cursor = 0
  for (const rawEntry of entries) {
    const entry = record(rawEntry, 'items[]')
    const slotId = text(entry.slotId, 'slotId')
    const artifactRef = record(entry.artifact, 'items[].artifact')
    const artifactId = text(artifactRef.artifactId, 'artifactId')
    const artifact = task.artifacts.find((candidate) => candidate.artifactId === artifactId && candidate.revision === artifactRef.revision && candidate.checksum === artifactRef.checksum)
    if (!artifact) throw new AgentToolError('MEDIA_MISSING', 'Result ' + artifactId + ' was not found in the task')
    const itemId = stableId('agent', task.taskId, slotId)
    const offset = entry.offset && typeof entry.offset === 'object' && !Array.isArray(entry.offset)
      ? entry.offset as Record<string, unknown>
      : {}
    const x = finiteOffset(offset.x, 80 + cursor * 48)
    const y = finiteOffset(offset.y, 80 + cursor * 48)
    const caption = text(entry.caption, 'caption')
    const body = artifact.text ?? caption

    let kind: 'image' | 'video' | 'audio' | 'text' = 'text'
    let w = 520
    let h = Math.max(120, Math.min(600, (body.split('\n').length ?? 4) * 24 + 50))
    let src: string | undefined
    let mime: string | undefined
    let naturalWidth: number | undefined
    let naturalHeight: number | undefined
    let duration: number | undefined
    let textBody: string | undefined = body

    if (artifact.kind === 'audio') {
      kind = 'audio'
      w = 320
      h = 96
      src = artifact.mediaSrc
      mime = artifact.mimeType
      duration = artifact.durationMs ? artifact.durationMs / 1000 : undefined
      textBody = undefined
    } else if (artifact.kind === 'image' || artifact.kind === 'video') {
      kind = artifact.kind
      w = 440
      const hasDims = typeof artifact.width === 'number' && typeof artifact.height === 'number' && artifact.width > 0 && artifact.height > 0
      h = hasDims ? Math.round((artifact.height! / artifact.width!) * 440) : 440
      naturalWidth = artifact.width ?? 440
      naturalHeight = artifact.height ?? 440
      src = artifact.mediaSrc
      mime = artifact.mimeType
      duration = (artifact.kind === 'video' && artifact.durationMs) ? artifact.durationMs / 1000 : undefined
      textBody = undefined
    }

    const item: PreparedCanvasItem = {
      itemId,
      artifactId,
      slotId,
      kind,
      x,
      y,
      w,
      h,
      name: caption,
      ...(textBody !== undefined ? { text: textBody } : {}),
      ...(src ? { src } : {}),
      ...(mime ? { mime } : {}),
      ...(naturalWidth !== undefined ? { naturalWidth } : {}),
      ...(naturalHeight !== undefined ? { naturalHeight } : {}),
      ...(duration !== undefined ? { duration } : {}),
    }
    canvasItems.push(item)
    created.push({ slotId, itemId, revision: 1, artifactId })
    cursor += 1
  }
  return { workspaceId, items: created, canvasItems, textItems: canvasItems }
}

function localCanvasSnapshot(prepared: PreparedCanvasResult, task: AgentTaskRecord, raw: unknown): Record<string, unknown> | null {
  const snapshot = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  const items = Array.isArray(snapshot.items) ? [...snapshot.items] as Array<Record<string, unknown>> : []
  let changed = false
  for (const entry of prepared.canvasItems ?? prepared.textItems) {
    const existing = items.find((item) => item.id === entry.itemId)
    if (existing) {
      if (existing.agentTaskId !== task.taskId || existing.agentArtifactId !== entry.artifactId) {
        throw new AgentToolError('OPERATION_CONFLICT', 'Object ' + entry.itemId + ' already belongs to another task', false)
      }
      continue
    }
    const itemData: Record<string, unknown> = {
      id: entry.itemId,
      kind: entry.kind,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      name: entry.name,
      agentTaskId: task.taskId,
      agentOperationId: 'canvas.create_results',
      agentArtifactId: entry.artifactId,
    }
    if (entry.kind === 'text') {
      itemData.text = entry.text
    } else {
      if (entry.src) itemData.src = entry.src
      if (entry.mime) itemData.mime = entry.mime
      if (entry.naturalWidth !== undefined) itemData.naturalWidth = entry.naturalWidth
      if (entry.naturalHeight !== undefined) itemData.naturalHeight = entry.naturalHeight
      if (entry.duration !== undefined) itemData.duration = entry.duration
    }
    items.push(itemData)
    changed = true
  }
  return changed ? { ...snapshot, items } : null
}

async function createLocalResults(task: AgentTaskRecord, prepared: PreparedCanvasResult, operationId: string): Promise<ToolResult> {
  const project = projectId(task)
  if (presenceWarmingUp() || boardBusy(project)) {
    return {
      pending: { waitId: 'canvas-save:' + task.taskId + ':' + safeSegment(operationId) },
      result: { workspaceId: prepared.workspaceId, items: prepared.items },
    }
  }
  let deferredByPresence = false
  const outcome = await mutateProjectSnapshot(project, (raw) => {
    if (presenceWarmingUp() || boardBusy(project)) {
      deferredByPresence = true
      return null
    }
    return localCanvasSnapshot(prepared, task, raw)
  })
  if (deferredByPresence) {
    return {
      pending: { waitId: 'canvas-save:' + task.taskId + ':' + safeSegment(operationId) },
      result: { workspaceId: prepared.workspaceId, items: prepared.items },
    }
  }
  if (outcome === 'not-found') throw new AgentToolError('BOARD_NOT_FOUND', 'Local board is unavailable')
  return { result: { workspaceId: prepared.workspaceId, items: prepared.items } }
}

export function createResults(
  task: AgentTaskRecord,
  args: Record<string, unknown>,
  operationId: string,
  _options: ToolBrokerOptions,
): Promise<ToolResult> {
  const prepared = prepareCanvasResults(task, args)
  return createLocalResults(task, prepared, operationId)
}
