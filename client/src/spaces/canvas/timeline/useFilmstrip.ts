import { useEffect, useMemo, useState } from 'react'
import { FILMSTRIP_DEFAULT_ASPECT, filmstripCellTimes, isPositive } from './filmstripMath'
import { startFilmstripJob } from './filmstripJob'

// Фильмштрих дорожки (§8 ТЗ): плёнка РЕАЛЬНЫХ кадров клипа под разметкой.
// Снимается отдельным <video>, чтобы перемотки ради превью не дёргали картинку
// под курсором.
//
// Устройство (переписано 09.10.2026, прежнее склеивало 24 ячейки в одну
// картинку и показывало её только целиком):
//  - ячеек столько, сколько с пропорцией кадра помещается по ширине дорожки
//    (`filmstripCellCount`), и каждая — это кадр из СВОЕГО места клипа: под
//    x% дорожки лежит кадр из x% длительности (`filmstripCellTimes`);
//  - каждая ячейка — отдельный маленький JPEG и появляется, как только готова:
//    плёнка заполняется на глазах, а не после последней перемотки;
//  - снимаем сначала редкую сетку, потом уплотняем (`filmstripCaptureOrder`):
//    даже недоснятая плёнка равномерно покрывает клип;
//  - сборка стартует, только когда известно всё нужное (файл, длительность,
//    число ячеек), а смена любого из них или уход с экрана останавливает
//    прежнюю СРАЗУ — иначе нерасторопная сборка продолжала бы гонять перемотки
//    для плёнки, которую никто не увидит.
//
// Файлы: filmstripMath.ts — арифметика, filmstripJob.ts — съёмка, здесь — хук.

export { filmstripCellCount, filmstripCellTimes } from './filmstripMath'

export interface Filmstrip {
  /** По одной на ячейку: data-URL готового кадра или null, пока не снят. */
  cells: readonly (string | null)[]
  /** Файл не удалось прочитать: готовые ячейки остаются, новых не будет. */
  failed: boolean
}

function blankFilmstrip(count: number): Filmstrip {
  return { cells: Array.from({ length: count }, () => null), failed: false }
}

/**
 * Плёнка клипа. Стартует только когда есть файл, длительность и число ячеек
 * (`filmstripCellCount` по размеру дорожки). Пока что-то неизвестно, отдаёт
 * пустую плёнку нужной длины — вёрстка не прыгает, когда кадры начинают
 * появляться. На каждый рендер `cells.length` равен числу ячеек, даже если
 * оно только что сменилось: чужие кадры прошлой сборки наружу не выходят.
 */
export function useFilmstrip(
  src: string | undefined,
  duration: number,
  cellCount: number,
  aspect: number = FILMSTRIP_DEFAULT_ASPECT,
): Filmstrip {
  const count = Number.isFinite(cellCount) ? Math.max(0, Math.floor(cellCount)) : 0
  const ratio = isPositive(aspect) ? aspect : FILMSTRIP_DEFAULT_ASPECT
  const key = `${src ?? ''}\u0000${duration}\u0000${count}\u0000${ratio}`
  const [built, setBuilt] = useState<{ key: string; strip: Filmstrip }>({ key: '', strip: blankFilmstrip(0) })
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
        setBuilt({ key, strip: { cells: [...cells], failed: false } })
      },
      onFailed: () => {
        if (!stopped) setBuilt({ key, strip: { cells: [...cells], failed: true } })
      },
    })
    return () => {
      stopped = true
      job.stop()
    }
  }, [src, duration, count, ratio, key])

  return built.key === key ? built.strip : blank
}
