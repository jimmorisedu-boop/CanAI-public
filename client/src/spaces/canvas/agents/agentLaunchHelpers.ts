import { emptyAgentBudgetDraft, type AgentBudgetDraft } from './agentLaunchModel'
import type {
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'

export const agentBudgetDrafts = new Map<string, AgentBudgetDraft>()

export function budgetKey(projectRef: ProjectRef, packageId: string | undefined, taskType: string | undefined): string {
  return `${projectRef.source}:${projectRef.id}:${packageId ?? ''}:${taskType ?? ''}`
}

export type BoardSaveReceipt = { revision: number }

/**
 * Native media capture is authoritative only after optimistic board state has
 * reached the persisted project snapshot. Keep that ordering explicit: a
 * capture request without this receipt could freeze an older source and make
 * the later Host admission reject the user's current selection.
 */
export async function captureGenerationInputsAfterBoardSave(
  flushBoardBeforeCapture: (() => Promise<BoardSaveReceipt>) | undefined,
  capture: (request: AgentGenerationCaptureRequest) => Promise<AgentGenerationCaptureReceipt[]>,
  request: Omit<AgentGenerationCaptureRequest, 'projectRevision'>,
): Promise<AgentGenerationCaptureReceipt[]> {
  if (!flushBoardBeforeCapture) {
    throw new Error('Wait for the canvas to finish saving before capturing native media')
  }
  const receipt = await flushBoardBeforeCapture()
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw new Error('Server did not confirm the saved canvas revision')
  }
  return capture({ ...request, projectRevision: receipt.revision })
}

export function readBudgetDraft(key: string): AgentBudgetDraft {
  return agentBudgetDrafts.get(key) ?? emptyAgentBudgetDraft()
}

export function packageIsDemo(id: string, name: string): boolean {
  return /demo|test|example/i.test(`${id} ${name}`)
}

export function selectedInputKey(items: ReadonlyArray<{
  id: string
  kind: string
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  src?: string
  text?: string
}>): string {
  return items.map((item) => [
    item.id, item.kind, item.assetId ?? '', item.assetRevision ?? '', item.assetChecksum ?? '', item.src ?? '', item.text ?? '',
  ].join(':')).join('|')
}
