import type { DragEvent, KeyboardEvent, ReactElement } from 'react'
import { beginNodePaletteDrag } from './nodePaletteDnd'
import { NODE_META } from './ports'
import type { NodeKind } from './types'

interface NodePaletteButtonProps {
  kind: NodeKind
  label: string
  loaded: boolean
  onAdd: (kind: NodeKind) => void
}

export function NodePaletteButton({
  kind,
  label,
  loaded,
  onAdd,
}: NodePaletteButtonProps): ReactElement {
  const NodeIcon = NODE_META[kind].icon
  return (
    <button
      type="button"
      className="node-add-btn node-palette-item icon-tab"
      draggable={loaded}
      disabled={!loaded}
      title={`Click or drag “${label}” onto the canvas`}
      onClick={() => onAdd(kind)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onAdd(kind)
      }}
      onDragStart={(event: DragEvent<HTMLButtonElement>) =>
        beginNodePaletteDrag(event.dataTransfer, kind)}
    >
      <NodeIcon size={16} /> {label}
    </button>
  )
}
