import { useEffect } from 'react'
import { IconClose, IconCompare } from '../../../ui/icons'
import type { CanvasStore } from '../konva/canvasStore'
import type { CanvasItem } from '../konva/types'
import {
  closeCompare,
  confirmComparePicking,
  setCompareCandidates,
  type ComparePicking,
} from './compareBus'
import { descendantsOf } from './compareSelection'

// Плашка режима набора. Живёт СВЕРХУ холста: пользователь в этот момент
// смотрит на объекты, а не на промпт-бар внизу. Держим её короткой — длинные
// имена файлов и пояснения раздували её на пол-экрана.

export function ComparePickerBar({
  store,
  session,
}: {
  store: CanvasStore
  session: ComparePicking
}) {
  const chosen = session.candidateIds
    .map((id) => store.getItem(id))
    .filter((item): item is CanvasItem => Boolean(item))

  const generations = descendantsOf(session.baselineId, store.getItems())
  const notYetTaken = generations.filter((id) => !session.candidateIds.includes(id))

  // Enter = кнопка «Сравнить»: набрал и поехали, не целясь мышью
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Enter' || chosen.length === 0) return
      event.preventDefault()
      confirmComparePicking()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chosen.length])

  return (
    <div className="compare-picker" role="status">
      <span className="compare-picker-icon" aria-hidden="true">
        <IconCompare size={15} />
      </span>

      <span className="compare-picker-text">
        {session.candidateIds.length === 0
          ? 'Choose what to compare'
          : `Selected: ${session.candidateIds.length}`}
      </span>

      {notYetTaken.length > 0 && (
        <button
          className="chip-btn"
          onClick={(event) => {
            event.currentTarget.blur()
            setCompareCandidates([...session.candidateIds, ...notYetTaken])
          }}
        >
          All generations ({notYetTaken.length})
        </button>
      )}

      <button
        className="chip-btn primary"
        disabled={session.candidateIds.length === 0}
        title="Enter"
        onClick={confirmComparePicking}
      >
        Compare
      </button>

      <button className="icon-btn compare-dismiss" aria-label="Cancel comparison" onClick={closeCompare}>
        <IconClose size={15} />
      </button>
    </div>
  )
}
