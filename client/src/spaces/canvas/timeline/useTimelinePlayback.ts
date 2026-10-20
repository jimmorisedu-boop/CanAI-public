import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { TimelineSession } from './useTimelineSession'

/**
 * Воспроизведение превью правки клипа: играть/пауза, звук, слежение курсора
 * за видео и видео за курсором.
 *
 * Всё, что обработчики читают «на момент вызова» (голова, границы куска),
 * берётся через ref: подписка на события видео одна на жизнь элемента, а не
 * пересоздаётся на каждый кадр воспроизведения (session — новый объект на
 * каждый рендер, и подписка, зависящая от него, переподписывалась бы на
 * КАЖДЫЙ timeupdate).
 */
export function useTimelinePlayback(
  videoRef: RefObject<HTMLVideoElement>,
  session: TimelineSession,
  shownTime: number,
) {
  const [playing, setPlaying] = useState(false)
  // Зеркало playing, которое обновляется СИНХРОННО. Состояние React доезжает
  // на следующий рендер, и в эту щель успевало провалиться воспроизведение:
  // первый timeupdate менял позицию, эффект перемотки видел playing ещё
  // false, дёргал currentTime и прерывал только что запущенный play. Со
  // стороны это выглядело как «пробел работает со второго раза».
  const playingRef = useRef(false)
  // Звук предпросмотра. Раньше <video> был наглухо muted, и клип смотрели
  // немым — а по речи как раз и ищут, где резать. Теперь звук есть, а кнопка
  // рядом его глушит, когда он мешает.
  const [muted, setMuted] = useState(false)

  const latest = useRef(session)
  latest.current = session

  // muted у <video> — свойство, а не атрибут: React его выставляет, но
  // полагаться на это нельзя, поэтому ставим сами и на каждое переключение.
  useEffect(() => {
    const el = videoRef.current
    if (el) el.muted = muted
  }, [videoRef, muted])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [videoRef])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      playingRef.current = false
      video.pause()
      return
    }
    const { head, inPoint, outPoint } = latest.current
    // Играем ТОЛЬКО выбранный кусок: за его границами смотреть нечего, а
    // курсор, убежавший за выход, пришлось бы возвращать руками.
    if (head < inPoint || head >= outPoint - 0.05) video.currentTime = inPoint
    playingRef.current = true
    setPlaying(true)
    void video.play().catch(() => {
      playingRef.current = false
      setPlaying(false)
    })
  }, [videoRef])

  // Во время воспроизведения курсор ведёт ВИДЕО, а не наоборот: иначе каждое
  // обновление позиции перематывало бы плеер обратно и он стоял бы на месте.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => {
      if (video.paused) return
      const { outPoint, setHead } = latest.current
      if (video.currentTime >= outPoint) {
        playingRef.current = false
        video.pause()
        setHead(outPoint)
        return
      }
      setHead(video.currentTime)
    }
    const onPlay = () => {
      playingRef.current = true
      setPlaying(true)
    }
    const onPause = () => {
      playingRef.current = false
      setPlaying(false)
    }
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [videoRef])

  // Превью следует за тем, что двигают: рез двигают ровно потому, что
  // промахнулись на кадр, и делать это вслепую бессмысленно.
  useEffect(() => {
    const video = videoRef.current
    if (!video || playingRef.current || !Number.isFinite(shownTime)) return
    if (Math.abs(video.currentTime - shownTime) > 0.001) video.currentTime = shownTime
  }, [videoRef, shownTime, playing])

  return {
    playing,
    muted,
    toggleMute: useCallback(() => setMuted((value) => !value), []),
    togglePlay,
    pause,
  }
}
