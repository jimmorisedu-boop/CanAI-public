import { useEffect, useState } from 'react'
import type { SelectionRef } from './konva/selection'
import { mediaReferences } from './referenceComposer'
import { RefChip } from './RefChip'

export function ReferenceChips({
  refs,
  onRemove,
  onTag,
  onReplace,
  replacingShapeId,
  gifUsage = 'neutral',
}: {
  refs: SelectionRef[]
  onRemove(ref: SelectionRef): void
  onTag(ref: SelectionRef, number: number): void
  onReplace?(ref: SelectionRef): void
  replacingShapeId?: string | null
  gifUsage?: 'frame' | 'unsupported' | 'neutral'
}) {
  const [expanded, setExpanded] = useState(false)

  const MAX_VISIBLE = 15
  useEffect(() => {
    if (refs.length <= MAX_VISIBLE) {
      setExpanded(false)
    }
  }, [refs.length])

  if (refs.length === 0) return null
  const media = mediaReferences(refs)

  const showMore = refs.length > MAX_VISIBLE && !expanded
  const visibleRefs = showMore ? refs.slice(0, MAX_VISIBLE) : refs
  const remainingCount = refs.length - MAX_VISIBLE

  return (
    <div className="ref-chips">
      {visibleRefs.map((ref) => {
        const mediaIndex = ref.kind === 'text'
          ? -1
          : media.findIndex((candidate) => candidate.shapeId === ref.shapeId)
        const number = mediaIndex >= 0 ? mediaIndex + 1 : undefined
        return (
          <RefChip
            key={ref.shapeId}
            refItem={ref}
            num={number}
            onRemove={() => onRemove(ref)}
            onTag={number == null ? undefined : () => onTag(ref, number)}
            onReplace={onReplace ? () => onReplace(ref) : undefined}
            replacing={replacingShapeId === ref.shapeId}
            gifUsage={gifUsage}
          />
        )
      })}
      {showMore && (
        <button
          type="button"
          className="ref-chip ref-chip-more"
          title={`Show ${remainingCount} more objects`}
          onClick={() => setExpanded(true)}
        >
          <span>+{remainingCount}</span>
        </button>
      )}
    </div>
  )
}
