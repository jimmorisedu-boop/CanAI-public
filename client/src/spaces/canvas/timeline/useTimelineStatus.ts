import { useEffect, useRef, useState } from 'react'
import type { CapturePhase, FrameCaptureRecord } from './frameCaptureQueue'
import { clearTimelineNotice, getTimelineNotice, notifyInTimeline, onTimelineNotice } from './timelineNotice'
import { frameTransitionNotice, statusLine, type StatusLine } from './timelineStatus'

/**
 * Строка состояния транспорта: свежее сообщение режима → идущее снятие кадра →
 * «Готово». Сообщения приходят через `notifyInTimeline` (резы, применение,
 * автопоиск…); итог снятия кадра («на холсте», «не сохранился») оверлей
 * говорит сам по смене фазы записи — полка может быть закрыта, и без слов
 * кадр просто молча появился бы на доске.
 */
export function useTimelineStatus(records: readonly FrameCaptureRecord[]): StatusLine {
  const [notice, setNotice] = useState(getTimelineNotice)
  useEffect(() => onTimelineNotice(setNotice), [])
  // Сообщение прошлого сеанса не должно встречать в новом клипе.
  useEffect(() => clearTimelineNotice, [])

  // Какой фазы была каждая запись в прошлый раз: сообщаем только о ПЕРЕХОДЕ.
  const phases = useRef(new Map<string, CapturePhase>())
  useEffect(() => {
    const seen = phases.current
    const alive = new Set<string>()
    for (const record of records) {
      alive.add(record.id)
      const note = frameTransitionNotice(seen.get(record.id), record)
      seen.set(record.id, record.phase)
      if (note) notifyInTimeline(note)
    }
    // Убранные с полки записи забываем: id в очереди не повторяются, но карта
    // не должна расти за весь сеанс.
    for (const id of [...seen.keys()]) if (!alive.has(id)) seen.delete(id)
  }, [records])

  return statusLine({ notice, records })
}
