import type { AgentProtocolDispatcher } from './host-protocol.js'
import type { AgentTaskJournal } from './journal.js'

interface DeliveryContext {
  journal: AgentTaskJournal
  protocol: AgentProtocolDispatcher
  projectId: string
  snapshot: unknown
}

/** Promote staged local canvas slots only after the normal project save. */
export async function acknowledgeCanvasDelivery(context: DeliveryContext): Promise<void> {
  const { journal, protocol, projectId, snapshot } = context
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return
  const rawItems = (snapshot as Record<string, unknown>).items
  if (!Array.isArray(rawItems)) return
  const savedIds = new Set(rawItems.flatMap((item) => (
    item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string'
      ? [String((item as Record<string, unknown>).id)]
      : []
  )))
  if (savedIds.size === 0) return
  for (const task of await journal.list()) {
    if (task.projectRef.source !== 'local' || task.projectRef.id !== projectId || task.pendingCanvasItems.length === 0) continue
    const grouped = new Map<string, typeof task.pendingCanvasItems>()
    for (const item of task.pendingCanvasItems) {
      if (!savedIds.has(item.itemId)) continue
      const entries = grouped.get(item.operationId) ?? []
      entries.push(item)
      grouped.set(item.operationId, entries)
    }
    for (const [operationId, delivered] of grouped) {
      const pendingForOperation = task.pendingCanvasItems.filter((item) => item.operationId === operationId)
      if (delivered.length !== pendingForOperation.length) continue
      const current = await journal.get(task.taskId)
      if (!current) continue
      const pendingReceipt = [...current.receipts].reverse().find((receipt) => receipt.operationId === operationId && receipt.status === 'pending')
      if (!pendingReceipt) continue
      const finalResult = {
        workspaceId: delivered[0]?.workspaceId ?? current.workspaceId,
        items: delivered.map(({ operationId: _operationId, waitId: _waitId, workspaceId: _workspaceId, ...item }) => item),
      }
      const completed = await journal.mutate(task.taskId, (entry) => {
        const receipt = [...entry.receipts].reverse().find((candidate) => candidate.operationId === operationId && candidate.status === 'pending')
        if (!receipt) return
        receipt.status = 'succeeded'
        receipt.result = finalResult
        entry.pendingCanvasItems = entry.pendingCanvasItems.filter((item) => item.operationId !== operationId)
        entry.canvasItems.push(...finalResult.items)
        entry.revision += 1
      }, { type: 'canvas.delivery.ack', payload: { operationId, projectId, itemIds: delivered.map((item) => item.itemId) } })
      const receipt = [...completed.receipts].reverse().find((candidate) => candidate.operationId === operationId && candidate.status === 'succeeded')
      if (receipt) protocol.completePendingTool(task.taskId, operationId, receipt)
    }
  }
}
