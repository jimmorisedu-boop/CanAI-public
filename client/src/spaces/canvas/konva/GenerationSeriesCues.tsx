import {
  IconBack,
  IconCaretDown,
  IconCaretUp,
  IconFit,
  IconNext,
} from '../../../ui/icons'
import { useRef } from 'react'
import type { CueDirection } from './generationSeriesGeometry'
import type { GenerationSeriesCueModel } from './useGenerationSeriesReveal'
import { useT } from '../../../i18n/context.js'


interface FocusTarget {
  isConnected?: boolean
  matches?(selector: string): boolean
  focus(options?: { preventScroll?: boolean }): void
}

function asPersistentFocusTarget(value: unknown): FocusTarget | null {
  if (!value || typeof (value as FocusTarget).focus !== 'function') return null
  const target = value as FocusTarget
  return target.matches?.('.generation-series-cue') ? null : target
}

export function createGenerationSeriesCueFocusKeeper(
  getActiveElement: () => unknown = () => (
    typeof document === 'undefined' ? null : document.activeElement
  ),
): {
  capturePointer(event: { preventDefault(): void }): void
  remember(target: unknown): void
  restoreForActivation(detail: number): void
} {
  let previous: FocusTarget | null = null

  const restore = (): void => {
    if (!previous || previous.isConnected === false) return
    previous.focus({ preventScroll: true })
  }

  return {
    capturePointer(event) {
      const active = getActiveElement()
      const persistent = asPersistentFocusTarget(active)
      if (persistent) previous = persistent
      else restore()
      event.preventDefault()
    },
    remember(target) {
      const persistent = asPersistentFocusTarget(target)
      if (persistent) previous = persistent
    },
    restoreForActivation(_detail) {
      queueMicrotask(() => {
        if (getActiveElement() !== previous) restore()
      })
    },
  }
}

function DirectionIcon({ direction }: { direction: CueDirection }): JSX.Element {
  const props = { size: 16, className: 'generation-series-cue-icon', 'aria-hidden': true } as const
  if (direction === 'left') return <IconBack {...props} />
  if (direction === 'right') return <IconNext {...props} />
  if (direction === 'up') return <IconCaretUp {...props} />
  if (direction === 'down') return <IconCaretDown {...props} />
  return <IconFit {...props} />
}

export function GenerationSeriesCues({
  cues,
  onShow,
}: {
  cues: GenerationSeriesCueModel[]
  onShow(launchId: string): void
}): JSX.Element | null {
  const t = useT()
  const focusKeeperRef = useRef<ReturnType<typeof createGenerationSeriesCueFocusKeeper> | null>(null)
  if (!focusKeeperRef.current) focusKeeperRef.current = createGenerationSeriesCueFocusKeeper()
  if (cues.length === 0) return null

  return (
    <>
      {cues.map((cue) => (
        <button
          key={cue.launchId}
          type="button"
          className="generation-series-cue"
          aria-label={cue.accessibleName}
          style={{ left: cue.x, top: cue.y }}
          onFocus={(event) => focusKeeperRef.current?.remember(event.relatedTarget)}
          onMouseDown={(event) => focusKeeperRef.current?.capturePointer(event)}
          onClick={(event) => {
            focusKeeperRef.current?.restoreForActivation(event.detail)
            onShow(cue.launchId)
          }}
        >
          <DirectionIcon direction={cue.direction} />
          <span>{cue.direction === 'mixed' ? t('All {0}', { 0: cue.totalCount }) : t('More {0}', { 0: cue.hiddenCount })}</span>
        </button>
      ))}
    </>
  )
}
