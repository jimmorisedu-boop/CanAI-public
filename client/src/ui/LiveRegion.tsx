import { useSyncExternalStore } from 'react'
import { getAnnouncement, subscribeAnnouncement } from './announce'

// Невидимая область объявлений. Смонтирована в корне один раз: диктор читает
// её содержимое при каждой смене, а глазами её никто не видит (.sr-only).
export function LiveRegion() {
  const current = useSyncExternalStore(subscribeAnnouncement, getAnnouncement, getAnnouncement)
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {current.text && current.priority === 'polite'
          ? <span key={current.seq}>{current.text}</span>
          : null}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {current.text && current.priority === 'assertive'
          ? <span key={current.seq}>{current.text}</span>
          : null}
      </div>
    </>
  )
}
