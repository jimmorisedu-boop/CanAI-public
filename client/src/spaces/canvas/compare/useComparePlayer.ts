import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../api'
import { handleCompareFrameKey, seekCompareVideos, stepCompareFrames } from './compareFrameStep'
import {
  alternateStep,
  clampToDuration,
  syncPlan,
  timelineDuration,
  type AlternateState,
  type SyncOptions,
} from './compareSync'

/**
 * Общий плеер сравнения — один на ОБЕ раскладки.
 *
 * ⚠️ Логика жила внутри «панелей рядом», и пока видео показывалось только там,
 * это было нормально. Как только штора научилась видео, вторая копия этих ста
 * строк (синхронизация, пробел, скорость, перемотка) разъехалась бы с первой
 * при первой же правке одной из них — поэтому хук, а не копия.
 *
 * Ведущее видео — САМОЕ ДЛИННОЕ: тогда общая шкала покрывает всё, а короткие
 * сами замирают на последнем кадре (браузер зажимает currentTime по duration).
 */
export function useComparePlayer(videoRefs: React.MutableRefObject<(HTMLVideoElement | null)[]>, deps: unknown, canHandleFrameKey?: () => boolean) {
  const [durations, setDurations] = useState<number[]>([])
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState(1)
  const [alternate, setAlternate] = useState(false)
  const alternateRef = useRef<AlternateState | null>(null)
  const rafRef = useRef(0)
  const fpsRef = useRef(new Map<string, number | undefined>())
  const frameKeyGuard = useRef(canHandleFrameKey)
  frameKeyGuard.current = canHandleFrameKey

  const videoEls = useCallback(
    () => videoRefs.current.filter((el): el is HTMLVideoElement => Boolean(el)),
    [videoRefs],
  )

  const primaryIndex = durations.reduce(
    (best, value, index) => (value > (durations[best] ?? 0) ? index : best),
    0,
  )
  const duration = timelineDuration(durations)

  useEffect(() => {
    for (const video of videoEls()) {
      const src = video.getAttribute('src')
      if (!src || fpsRef.current.has(src)) continue
      fpsRef.current.set(src, undefined)
      // Тот же локальный анализ, что и в редакторе клипа; один запрос на файл
      // за сеанс сравнения, независимо от числа нажатий и перерисовок.
      void api.probeVideo(src).then(({ fps }) => {
        fpsRef.current.set(src, fps)
      }).catch(() => { /* неизвестная частота — запасной шаг таймлайна */ })
    }
  }, [deps, videoEls])

  const applySync = useCallback(
    (options: SyncOptions = {}) => {
      if (alternate) return // в режиме «по очереди» синхронизация не нужна
      const els = videoEls()
      if (els.length < 2) return
      const primary = els[Math.min(primaryIndex, els.length - 1)]
      const rest = els.filter((el) => el !== primary)
      for (const command of syncPlan(primary, rest, options)) {
        const el = rest[command.index]
        if (!el) continue
        if (command.setRate !== undefined) el.playbackRate = command.setRate
        if (command.seekTo !== undefined) {
          try {
            el.currentTime = command.seekTo
          } catch {
            /* элемент ещё не готов — подтянется на canplay */
          }
        }
        if (command.play === true) void el.play().catch(() => {})
        if (command.play === false) el.pause()
      }
    },
    [alternate, primaryIndex, videoEls],
  )

  const scheduleSync = useCallback(
    (options: SyncOptions = {}) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        applySync(options)
      })
    },
    [applySync],
  )

  // подписка на ведущее видео: время, готовность, смена скорости
  useEffect(() => {
    const els = videoEls()
    const primary = els[Math.min(primaryIndex, els.length - 1)]
    if (!primary) return

    const onTime = () => {
      setTime(primary.currentTime)
      applySync()
    }
    const onMeta = () => {
      setDurations(videoEls().map((el) => el.duration || 0))
      scheduleSync({ force: true })
    }
    const onPlay = () => {
      setPlaying(true)
      scheduleSync({ force: true })
    }
    const onPause = () => {
      setPlaying(false)
      scheduleSync({ force: true })
    }

    primary.addEventListener('timeupdate', onTime)
    primary.addEventListener('seeked', onTime)
    els.forEach((el) => {
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('durationchange', onMeta)
    })
    onMeta()
    primary.addEventListener('play', onPlay)
    primary.addEventListener('pause', onPause)
    return () => {
      primary.removeEventListener('timeupdate', onTime)
      primary.removeEventListener('seeked', onTime)
      els.forEach((el) => {
        el.removeEventListener('loadedmetadata', onMeta)
        el.removeEventListener('durationchange', onMeta)
      })
      primary.removeEventListener('play', onPlay)
      primary.removeEventListener('pause', onPause)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [deps, primaryIndex, applySync, scheduleSync, videoEls])

  const togglePlay = useCallback(() => {
    const els = videoEls()
    if (els.length === 0) return

    if (alternate && els.length === 2) {
      // играет то одно, то другое, каждое С НАЧАЛА — режим `enhance` из Lmd_sku
      const step = alternateStep(alternateRef.current)
      alternateRef.current = { playingIndex: step.playingIndex }
      const target = els[step.playFrom]
      const other = els[step.pause]
      other.pause()
      target.currentTime = 0
      void target.play().catch(() => {})
      setPlaying(true)
      return
    }

    const shouldPlay = els.some((el) => el.paused)
    els.forEach((el) => {
      if (shouldPlay) void el.play().catch(() => {})
      else el.pause()
    })
    setPlaying(shouldPlay)
    // СИНХРОННО, не через rAF: play() у подчинённого видео обязан вызваться
    // внутри пользовательского жеста, иначе браузер режет автоплей со звуком
    // и второе видео молча не стартует
    applySync({ force: true })
  }, [alternate, applySync, videoEls])

  const seek = useCallback(
    (next: number) => {
      const value = clampToDuration(next, duration)
      setTime(value)
      seekCompareVideos(videoEls(), value)
    },
    [duration, videoEls],
  )

  const stepFrames = useCallback((frames: number) => {
    const next = stepCompareFrames(videoEls(), frames, (video) => fpsRef.current.get(video.getAttribute('src') ?? ''))
    setPlaying(false)
    if (next === null) return false
    setTime(next)
    return true
  }, [videoEls])

  useEffect(() => {
    if (!videoEls().length) return
    const onKey = (event: KeyboardEvent) => {
      if (frameKeyGuard.current && !frameKeyGuard.current()) return
      handleCompareFrameKey(event, stepFrames)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [deps, stepFrames, videoEls])

  const changeRate = useCallback(
    (next: number) => {
      setRate(next)
      videoEls().forEach((el) => {
        el.playbackRate = next
      })
    },
    [videoEls],
  )

  return {
    playing,
    time,
    duration,
    rate,
    alternate,
    setAlternate,
    togglePlay,
    seek,
    stepFrames,
    changeRate,
  }
}

/**
 * Пробел = играть/пауза.
 *
 * ⚠️ Слушаем в ФАЗЕ ЗАХВАТА: выделенное на холсте видео слушает пробел в той же
 * фазе и делает stopImmediatePropagation — иначе оно съедает наш пробел.
 * В наложении пробел принадлежит режиму «Переключение», поэтому там плеер его
 * не забирает (`enabled: false`).
 */
export function useComparePlayerSpace(togglePlay: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    function onKey(event: KeyboardEvent): void {
      if (event.code !== 'Space' || event.repeat) return
      // фокус может стоять на кнопке плеера, скорости или миниатюре — тогда
      // пробел «нажимал» бы её и отменял наше действие вторым переключением
      event.preventDefault()
      event.stopPropagation()
      togglePlay()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [togglePlay, enabled])
}
