import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../api'
import { notifyInTimeline } from './timelineNotice'
import { adoptForBoard } from '../konva/boardUploader'
import type { CanvasStore } from '../konva/canvasStore'
import { useContentVersion } from '../konva/useStore'
import type { CanvasItem } from '../konva/types'
import type { Rect } from '../konva/cropMath'
import {
  activeCuts,
  canCutAt,
  clamp,
  keptSegments,
  mergeCuts,
  MIN_PIECE_S,
  pluralCuts,
  pluralPieces,
  seamBounds,
  segmentAt,
  segmentsFrom,
  totalLength,
  type MergedCut,
  type Segment,
  type ShotCandidate,
} from './timelineModel'

/** Порог по умолчанию. Настоящая склейка даёт баллы в десятках, плавное
 *  движение камеры — единицы, так что десятка отделяет одно от другого. */
const DEFAULT_THRESHOLD = 10
import { getTimelineTarget, onTimelineTarget, setTimelineTarget } from './timelineBus'

// Состояние сеанса правки: что за клип, где вход/выход, где резы. Отдельно от
// отрисовки — оверлей получается тонким, а вся арифметика уже покрыта тестами
// в timelineModel.

export interface TimelineFacts {
  duration: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
}

export interface TimelineSession {
  item: CanvasItem
  facts: TimelineFacts | null
  loading: boolean
  error: string | null
  inPoint: number
  outPoint: number
  head: number
  cuts: MergedCut[]
  busy: boolean
  setHead(time: number): void
  moveIn(time: number): void
  moveOut(time: number): void
  addCut(): void
  /** Возвращает время, куда рез реально встал: тянущий его оверлей должен
   *  знать это место, а не пересчитывать ту же арифметику у себя. */
  moveCut(from: number, to: number): number
  removeCut(at: number): void
  /** Куски целиком — и те, что пойдут в результат, и удалённые: дорожка
   *  рисует удалённые перечёркнутыми, а не прячет их. */
  segments: Segment[]
  /** Начала кусков, помеченных к удалению. */
  dropped: number[]
  /** Убрать или вернуть кусок под курсором. */
  toggleDropAtHead(): void
  /** Автопоиск склеек: состояние, переключение и чувствительность. */
  shots: ShotCandidate[]
  autoOn: boolean
  autoBusy: boolean
  threshold: number
  setThreshold(value: number): void
  toggleAuto(): void
  /** Кадрирование: рамка в долях кадра, включается отдельно. */
  /** Точный рез: без притягивания к опорным кадрам, с перекодированием. */
  crop: Rect | null
  cropRatio: number | null
  setCrop(rect: Rect): void
  setCropRatio(ratio: number | null): void
  toggleCrop(): void
  pieces: number
  summary: string
  apply(): Promise<'applied' | 'failed' | 'no-op'>
  close(): void
}

export function useTimelineSession(store: CanvasStore): TimelineSession | null {
  const [targetId, setTargetId] = useState<string | null>(getTimelineTarget)
  useEffect(() => onTimelineTarget(setTargetId), [])

  // Подписка на содержимое обязательна: без неё исчезновение объекта проходило
  // незамеченным — режим оставался открытым поверх удалённого клипа, цель
  // висела в шине, а вместе с ней МОЛЧАЛИ хоткеи холста и перехватчик видео
  // (оба проверяют getTimelineTarget). Выйти из этого можно было только
  // перезагрузкой страницы.
  useContentVersion(store)
  const item = targetId ? store.getItem(targetId) : undefined
  const [facts, setFacts] = useState<TimelineFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(0)
  const [head, setHeadTime] = useState(0)
  const [manual, setManual] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [shots, setShots] = useState<ShotCandidate[]>([])
  const [autoOn, setAutoOn] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [dismissed, setDismissed] = useState<number[]>([])
  const [crop, setCrop] = useState<Rect | null>(null)
  const [cropRatio, setCropRatio] = useState<number | null>(null)
  // Куски, помеченные к удалению — по ВРЕМЕНИ НАЧАЛА (см. keptSegments).
  const [dropped, setDropped] = useState<number[]>([])
  // см. apply: замок от двойного запуска, который нельзя держать в состоянии
  const applyingRef = useRef(false)

  const src = item?.src
  useEffect(() => {
    if (!src) return
    let cancelled = false
    setFacts(null)
    setError(null)
    api.probeVideo(src)
      .then((probed) => {
        if (cancelled) return
        setFacts(probed)
        setInPoint(0)
        setOutPoint(probed.duration)
        setHeadTime(0)
        setManual([])
        setShots([])
        setAutoOn(false)
        setDismissed([])
        setThreshold(DEFAULT_THRESHOLD)
        setCrop(null)
        setCropRatio(null)
        setDropped([])
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Failed to read video')
      })
    return () => { cancelled = true }
  }, [src])

  // Цель исчезла — закрываем режим. Сюда попадают удаление объекта, отправка
  // его в архив и смена доски (там store новый, и старый id в нём не найдётся).
  useEffect(() => {
    if (targetId && (!item || item.kind !== 'video')) setTimelineTarget(null)
  }, [targetId, item])

  const close = useCallback(() => setTimelineTarget(null), [])

  const setHead = useCallback((time: number) => {
    setHeadTime(clamp(time, inPoint, outPoint))
  }, [inPoint, outPoint])

  const moveIn = useCallback((time: number) => {
    if (!facts) return
    // Вход встаёт ровно туда, куда его поставили: кусок перекодируется, а
    // перекодирование начинает его с любого кадра — притягивать не к чему.
    const next = clamp(time, 0, outPoint - MIN_PIECE_S)
    setInPoint(next)
    setHeadTime((current) => Math.max(current, next))
    // Вход — начало ПЕРВОГО куска, а метка удаления привязана к началу. Без
    // переноса она осиротела бы, и удалённый кусок молча вернулся бы в результат.
    setDropped((current) => current.map((start) => (start === inPoint ? next : start)))
  }, [facts, outPoint, inPoint])

  const moveOut = useCallback((time: number) => {
    if (!facts) return
    const next = clamp(time, inPoint + MIN_PIECE_S, facts.duration)
    setOutPoint(next)
    setHeadTime((current) => Math.min(current, next))
  }, [facts, inPoint])

  const merged = useMemo(
    () => mergeCuts({ manual, shots, threshold, dismissed, autoOn }),
    [manual, shots, threshold, dismissed, autoOn],
  )
  const cutTimes = useMemo(() => merged.map((cut) => cut.time), [merged])

  /** Автомат, тронутый руками, перестаёт участвовать в автопоиске: иначе
   *  движение ползунка вернуло бы его на прежнее место (см. mergeCuts). */
  const dismissIfAuto = useCallback((time: number) => {
    const found = merged.find((cut) => cut.time === time)
    if (found?.auto) {
      setDismissed((current) => [...current, found.time])
      return true
    }
    return false
  }, [merged])

  const addCut = useCallback(() => {
    if (!facts) return
    const at = head
    // Длительность иногда не читается вовсе (у ролика без неё в заголовке
    // ffprobe отдаёт 0). Тогда резать физически нечего, и говорить надо ИМЕННО
    // это: прежний отказ «слишком близко к краю» уводил в другую сторону —
    // человек двигал голову и не понимал, почему ничего не меняется
    // (найдено прогоном 20.08.2026).
    if (!(facts.duration > 0)) {
      notifyInTimeline({
        kind: 'info',
        message: 'Clip duration cannot be read; there is nothing to cut. Re-save the file or download it again',
        replaceKey: 'timeline-cut',
      })
      return
    }
    if (!canCutAt(at, cutTimes, inPoint, outPoint)) {
      notifyInTimeline({ kind: 'info', message: 'A cut cannot go here; it is too close to an edge or a neighbor', replaceKey: 'timeline-cut' })
      return
    }
    setManual((current) => [...current, at])
  }, [facts, head, cutTimes, inPoint, outPoint])

  const moveCut = useCallback((from: number, to: number) => {
    if (!facts) return from
    const bounds = seamBounds(from, cutTimes, inPoint, outPoint)
    const next = clamp(to, bounds.low, bounds.high)
    if (dismissIfAuto(from)) setManual((current) => [...current, next])
    else setManual((current) => current.map((cut) => (cut === from ? next : cut)))
    // Рез — начало следующего куска: метка удаления едет вместе с ним.
    setDropped((current) => current.map((start) => (start === from ? next : start)))
    return next
  }, [facts, cutTimes, inPoint, outPoint, dismissIfAuto])

  const removeCut = useCallback((at: number) => {
    // Куска, начинавшегося этим резом, больше нет — его метку снимаем. Иначе
    // она дождалась бы нового реза в той же точке и удалила бы кусок молча.
    setDropped((current) => current.filter((start) => start !== at))
    if (dismissIfAuto(at)) return
    setManual((current) => current.filter((cut) => cut !== at))
  }, [dismissIfAuto])

  const toggleAuto = useCallback(() => {
    if (autoOn) {
      setAutoOn(false)
      return
    }
    if (shots.length > 0) {
      setAutoOn(true)
      return
    }
    if (!item?.src || autoBusy) return
    setAutoBusy(true)
    api.detectShots(item.src)
      .then(({ candidates }) => {
        setShots(candidates)
        setAutoOn(true)
        const visible = candidates.filter((shot) => shot.score >= DEFAULT_THRESHOLD).length
        notifyInTimeline({
          kind: 'info',
          replaceKey: 'timeline-shots',
          message: visible > 0
            ? `Found ${visible} ${pluralCuts(visible)} — move the slider if there are extras`
            : 'No cuts found; the clip is one frame long',
        })
      })
      .catch((cause: unknown) => notifyInTimeline({
        kind: 'error',
        replaceKey: 'timeline-shots',
        message: cause instanceof Error ? cause.message : 'Failed to find cuts',
      }))
      .finally(() => setAutoBusy(false))
  }, [autoOn, shots, item, autoBusy])

  const toggleCrop = useCallback(() => {
    setCrop((current) => (current ? null : { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }))
    setCropRatio(null)
  }, [])

  const applyRatio = useCallback((ratio: number | null) => {
    setCropRatio(ratio)
    if (!ratio || !facts?.width || !facts.height) return
    // Рамка живёт в долях кадра, а пропорция задаётся в пикселях: без учёта
    // формы самого кадра «1:1» дало бы квадрат в долях, то есть прямоугольник
    // на экране.
    const frameRatio = facts.width / facts.height
    let w = 0.84
    let h = (w * frameRatio) / ratio
    if (h > 0.92) {
      h = 0.92
      w = (h * ratio) / frameRatio
    }
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
  }, [facts])

  const segments = useMemo(() => segmentsFrom(inPoint, outPoint, cutTimes), [inPoint, outPoint, cutTimes])
  const kept = useMemo(() => keptSegments(segments, dropped), [segments, dropped])

  /** Убрать или вернуть кусок под курсором.
   *
   *  Одна клавиша на оба действия намеренно: промахнуться легко, а «вернуть»
   *  обязано быть там же, где «удалить», — иначе за возвратом придётся идти в
   *  отмену всего сеанса. Кнопка при этом честно меняет подпись. */
  const toggleDropAtHead = useCallback(() => {
    const segment = segmentAt(segments, head)
    if (!segment) return
    if (dropped.includes(segment.start)) {
      setDropped((current) => current.filter((start) => start !== segment.start))
      return
    }
    // Удалить последний оставшийся кусок — значит не получить ничего. Лучше
    // сказать это сразу, чем оставить человека перед погашенным «Применить».
    if (kept.length <= 1) {
      notifyInTimeline({
        kind: 'info',
        message: 'This is the last segment; nothing would remain. Cut it first',
        replaceKey: 'timeline-drop',
      })
      return
    }
    setDropped((current) => [...current, segment.start])
  }, [segments, head, dropped, kept.length])

  const apply = useCallback(async (): Promise<'applied' | 'failed' | 'no-op'> => {
    // Замок СИНХРОННЫЙ. Состояние busy доезжает только на следующий рендер, а
    // Enter на сфокусированной кнопке «Применить» поднимает СРАЗУ ДВА события:
    // нативный клик кнопки и наш обработчик на окне. Оба видели busy === false,
    // уходили два запроса — и на холст ложились две копии каждого куска.
    if (!item || !item.src || kept.length === 0 || applyingRef.current) return 'no-op'
    applyingRef.current = true
    setBusy(true)
    // Перекодирование не мгновенно, и об этом надо сказать сразу, иначе
    // тишина в несколько секунд читается как «не сработало».
    notifyInTimeline({
      kind: 'info',
      message: 'Cutting and transcoding; this takes a moment…',
      replaceKey: 'timeline-apply',
    })
    try {
      const { pieces } = await api.cutVideo(item.src, kept, crop ?? undefined)
      if (pieces.length === 0) throw new Error('Failed to get segments; edits were saved, try again')
      // ⚠️ Куски нарезал НАШ ffmpeg и положил к себе. На сетевой доске такая
      // ссылка не значит ничего: у коллеги файла нет, а сервер команды правку
      // с ней даже не разбирает. Переселяем их к остальной доске.
      const adopted = await Promise.all(pieces.map(async (piece, index) => ({
        ...piece,
        ...await adoptForBoard(piece, `${item.name || 'clip'} — some ${index + 1}.mp4`),
      })))
      const created = store.placeVideoPieces(item, adopted)
      setTimelineTarget(null)
      notifyInTimeline({
        kind: 'success',
        message: `${pieces.length} ${pluralPieces(pieces.length)} beside the original`,
        replaceKey: 'timeline-apply',
        action: { label: 'Cancel', run: () => store.removeItems(created) },
      })
      return 'applied'
    } catch (cause) {
      notifyInTimeline({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'Failed to cut video',
        replaceKey: 'timeline-apply',
      })
      return 'failed'
    } finally {
      applyingRef.current = false
      setBusy(false)
    }
    // crop в зависимостях обязателен: без него useCallback держал бы рамку из
    // прошлого рендера, строка итога писала бы «с перекодированием», а на
    // сервер уходил бы старый (пустой) кроп — и клип возвращался нетронутым.
  }, [item, kept, busy, store, crop])

  if (!targetId || !item || item.kind !== 'video') return null

  const pieces = kept.length
  // Длина — сумма ОСТАВШИХСЯ кусков, а не расстояние от входа до выхода:
  // удалённый кусок в результат не идёт, и писать его секунды было бы враньём.
  const length = totalLength(kept)
  const gone = segments.length - kept.length
  // Порядок веток важен: пока видео не прочитано, кусков ноль по естественной
  // причине, и писать «слишком короткий кусок» значит валить вину на человека
  // за то, чего он не делал.
  const summary = error
    ? 'Video was not read'
    : !facts
      ? 'Reading video…'
      : pieces === 0
        ? 'The selected segment is too short'
        : `${pieces} ${pluralPieces(pieces)} · ${length.toFixed(1)} s${gone > 0 ? ` · removed ${gone}` : ''}`

  return {
    item,
    facts,
    loading: !facts && !error,
    error,
    inPoint,
    outPoint,
    head,
    // Резы вне выбранного куска не показываем, но и НЕ теряем: вернул ручку
    // назад — они на месте (см. activeCuts).
    cuts: merged.filter((cut) => activeCuts(cutTimes, inPoint, outPoint).includes(cut.time)),
    busy,
    setHead,
    moveIn,
    moveOut,
    addCut,
    moveCut,
    removeCut,
    segments,
    dropped,
    toggleDropAtHead,
    shots,
    autoOn,
    autoBusy,
    threshold,
    setThreshold,
    toggleAuto,
    crop,
    cropRatio,
    setCrop,
    setCropRatio: applyRatio,
    toggleCrop,
    pieces,
    summary,
    apply,
    close,
  }
}
