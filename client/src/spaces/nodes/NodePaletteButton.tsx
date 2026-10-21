import type { DragEvent, KeyboardEvent, ReactElement } from 'react'
import { beginNodePaletteDrag } from './nodePaletteDnd'
import { NODE_META } from './ports'
import type { NodeKind } from './types'
import { useT } from '../../i18n/context.js'


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
  const t = useT()
  const NodeIcon = NODE_META[kind].icon
  return (
    <button
      type="button"
      className="node-add-btn node-palette-item icon-tab"
      draggable={loaded}
      disabled={!loaded}
      title={t('Click or drag “{0}” onto the canvas', { 0: t(label) })}
      onClick={() => onAdd(kind)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onAdd(kind)
      }}
      onDragStart={(event: DragEvent<HTMLButtonElement>) =>
        beginNodePaletteDrag(event.dataTransfer, kind)}
    >
      <NodeIcon size={16} /> {t(label)}
    </button>
  )
}
