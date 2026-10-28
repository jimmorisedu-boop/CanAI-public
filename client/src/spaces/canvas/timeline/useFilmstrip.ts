import { useEffect, useMemo, useState } from 'react'
import {
  FILMSTRIP_DEFAULT_ASPECT,
  filmstripCellTimes,
  filmstripRangeTimes,
  isPositive,
} from './filmstripMath'
import { startFilmstripJob } from './filmstripJob'

// Фильмштрих дорожки (§8 ТЗ): плёнка РЕАЛЬНЫХ кадров клипа под разметкой.
// Снимается отдельным <video>, чтобы перемотки ради превью не дёргали картинку
// под курсором. При приближении по времени (Alt + колесо) мгновенно подставляет
// ближайшие кадры из базовой плёнки всего клипа без мигания пустотой, а следом
// доснимает детальные кадры видимого диапазона [range.start, range.end].

export { filmstripCellCount, filmstripCellTimes, filmstripRangeTimes } from './filmstripMath'

export interface Filmstrip {
  /** По одной на ячейку: data-URL готового кадра или null, пока не снят. */
  cells: readonly (string | null)[]
  /** Файл не удалось прочитать: готовые ячейки остаются, новых не будет. */
  failed: boolean
}

function blankFilmstrip(count: number): Filmstrip {
  return { cells: Array.from({ length: count }, () => null), failed: false }
}

export function useFilmstrip(
  src: string | undefined,
  duration: number,
  cellCount: number,
  aspect: number = FILMSTRIP_DEFAULT_ASPECT,
  range?: { start: number; end: number },
): Filmstrip {
  const count = Number.isFinite(cellCount) ? Math.max(0, Math.floor(cellCount)) : 0
  const ratio = isPositive(aspect) ? aspect : FILMSTRIP_DEFAULT_ASPECT
  const baseKey = `${src ?? ''}|${duration}|${count}|${ratio}`
  const [baseBuilt, setBaseBuilt] = useState<{ key: string; strip: Filmstrip }>({ key: '', strip: blankFilmstrip(0) })
  const blank = useMemo(() => blankFilmstrip(count), [count])

  useEffect(() => {
    if (!src || !isPositive(duration) || count < 1) return
    const cells: (string | null)[] = Array.from({ length: count }, () => null)
    let stopped = false
    const job = startFilmstripJob({
      src,
      times: filmstripCellTimes(duration, count),
      aspect: ratio,
      onCell: (index, url) => {
        if (stopped) return
        cells[index] = url
        setBaseBuilt({ key: baseKey, strip: { cells: [...cells], failed: false } })
      },
      onFailed: () => {
        if (!stopped) setBaseBuilt({ key: baseKey, strip: { cells: [...cells], failed: true } })
      },
    })
    return () => {
      stopped = true
      job.stop()
    }
  }, [src, duration, count, ratio, baseKey])

  const rangeStart = range ? range.start : 0
  const rangeEnd = range ? range.end : duration
  const zoomed = Boolean(
    range && isPositive(duration) && (rangeStart > 0.002 || rangeEnd < duration - 0.002),
  )
  const zoomKey = zoomed
    ? `${baseKey}|${rangeStart.toFixed(3)}|${rangeEnd.toFixed(3)}`
    : ''
  const [zoomBuilt, setZoomBuilt] = useState<{ key: string; strip: Filmstrip }>({ key: '', strip: blankFilmstrip(0) })

  useEffect(() => {
    if (!zoomed || !src || !isPositive(duration) || count < 1) return
    const cells: (string | null)[] = Array.from({ length: count }, () => null)
    let stopped = false
    let job: { stop(): void } | null = null
    const timer = setTimeout(() => {
      if (stopped) return
      job = startFilmstripJob({
        src,
        times: filmstripRangeTimes(rangeStart, rangeEnd, duration, count),
        aspect: ratio,
        onCell: (index, url) => {
          if (stopped) return
          cells[index] = url
          setZoomBuilt({ key: zoomKey, strip: { cells: [...cells], failed: false } })
        },
        onFailed: () => {
          if (!stopped) setZoomBuilt({ key: zoomKey, strip: { cells: [...cells], failed: true } })
        },
      })
    }, 110)
    return () => {
      stopped = true
      clearTimeout(timer)
      job?.stop()
    }
  }, [zoomed, src, duration, count, ratio, rangeStart, rangeEnd, zoomKey])

  const base = baseBuilt.key === baseKey ? baseBuilt.strip : blank
  if (!zoomed) return base

  const detail = zoomBuilt.key === zoomKey ? zoomBuilt.strip : null
  const rangeTimes = filmstripRangeTimes(rangeStart, rangeEnd, duration, count)
  const mergedCells = Array.from({ length: count }, (_, index) => {
    const ready = detail?.cells[index]
    if (ready) return ready
    if (base.cells.length === 0 || !isPositive(duration)) return null
    const time = rangeTimes[index] ?? 0
    const baseIdx = Math.min(base.cells.length - 1, Math.max(0, Math.floor((time / duration) * base.cells.length)))
    return base.cells[baseIdx] ?? null
  })
  return { cells: mergedCells, failed: detail ? detail.failed : base.failed }
}
