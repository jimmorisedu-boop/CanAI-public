import type { NodeKind } from './types'

export const NODE_PALETTE_MIME = 'application/x-canai-node-kind'

const NODE_KINDS = new Set<NodeKind>([
  'text',
  'note',
  'image',
  'video',
  'input',
  'output',
  'media',
  'other',
  'combine',
])

interface TransferLike {
  effectAllowed: string
  setData(type: string, value: string): void
  getData(type: string): string
}
export function beginNodePaletteDrag(transfer: TransferLike, kind: NodeKind): void {
  transfer.effectAllowed = 'copy'
  transfer.setData(NODE_PALETTE_MIME, kind)
  transfer.setData('text/plain', kind)
}

export function nodeKindFromDrop(transfer: Pick<TransferLike, 'getData'>): NodeKind | null {
  const value = transfer.getData(NODE_PALETTE_MIME)
  return NODE_KINDS.has(value as NodeKind) ? value as NodeKind : null
}

export function nodePositionFromDrop(
  event: { clientX: number; clientY: number },
  screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number },
  nodeSize: { width: number; height: number },
): { x: number; y: number } {
  const center = screenToFlowPosition({ x: event.clientX, y: event.clientY })
  return {
    x: center.x - nodeSize.width / 2,
    y: center.y - nodeSize.height / 2,
  }
}
