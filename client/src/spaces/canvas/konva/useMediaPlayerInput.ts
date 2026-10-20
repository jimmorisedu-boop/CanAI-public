import { useEffect, useRef, useState, type RefObject } from 'react'
import type Konva from 'konva'
import { getCompareSession } from '../compare/compareBus'
import { timelineBlocksCanvas } from '../timeline/timelineBus'

/**
 * Ввод плеера на холсте — один на видео и GIF (см. mediaPlayerChrome).
 */

/**
 * Перемотка за полосу снизу. Возвращает обработчик нажатия на полосу.
 *
 * Слушатели на window живут ТОЛЬКО пока тянем полосу: раньше каждый
 * смонтированный клип вешал свои mousemove/touchmove навсегда, и доска с
 * десятками видео тратила CPU на каждый пиксель движения мыши. На время
 * перемотки фигура не перетаскивается — иначе тянулась бы вместе с полосой.
 */
export function useProgressScrub(options: {
  groupRef: RefObject<Konva.Group | null>
  itemW: number
  draggable: boolean
  /** Доля полосы 0..1 — куда перемотать. */
  seekRatio: (ratio: number) => void
}): (e: Konva.KonvaEventObject<any>) => void {
  const [scrubbing, setScrubbing] = useState(false)
  const scrubbingRef = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const ratioAt = (x: number, y: number): number | null => {
    const group = optionsRef.current.groupRef.current
    if (!group) return null
    const local = group.getAbsoluteTransform().copy().invert().point({ x, y })
    return Math.max(0, Math.min(1, local.x / optionsRef.current.itemW))
  }

  useEffect(() => {
    if (!scrubbing) return
    const handleMove = (e: MouseEvent | TouchEvent) => {
      const group = optionsRef.current.groupRef.current
      const stage = group?.getStage()
      if (!scrubbingRef.current || !stage) return
      const rect = stage.container().getBoundingClientRect()
      const point = 'touches' in e ? e.touches?.[0] : e
      if (!point) return
      const ratio = ratioAt(point.clientX - rect.left, point.clientY - rect.top)
      if (ratio !== null) optionsRef.current.seekRatio(ratio)
    }
    const handleUp = () => {
      scrubbingRef.current = false
      setScrubbing(false)
      optionsRef.current.groupRef.current?.draggable(optionsRef.current.draggable)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('touchmove', handleMove, { passive: false })
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('touchend', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('touchend', handleUp)
    }
  }, [scrubbing])

  return (e) => {
    e.cancelBubble = true
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
    scrubbingRef.current = true
    setScrubbing(true)
    const group = optionsRef.current.groupRef.current
    group?.draggable(false)
    const pos = group?.getStage()?.getPointerPosition()
    if (!pos) return
    const ratio = ratioAt(pos.x, pos.y)
    if (ratio !== null) optionsRef.current.seekRatio(ratio)
  }
}

/**
 * Клавиши выделенного плеера: пробел — играть/пауза, ←/→ — шаг, с Shift — на
 * секунду.
 *
 * ⚠️ Слушатель висит в CAPTURE-фазе и делает stopImmediatePropagation, то есть
 * перебивает всех. Пока открыт режим, который сам работает с клавишами, он
 * обязан молчать — иначе выделенный на холсте плеер съедает пробел и стрелки у
 * того, кто на самом деле на экране. Со сравнением это уже случилось однажды
 * («пробел не включал видео»), с таймлайном — второй раз. Добавляешь режим с
 * собственными хоткеями — впиши его сюда, иначе история повторится.
 */
export function useMediaPlayerHotkeys(options: {
  enabled: boolean
  onToggle: () => void
  onStep: (direction: 1 | -1, big: boolean) => void
}): void {
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!options.enabled) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = target && (
        ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(target.tagName) ||
        target.isContentEditable
      )
      if (isTyping) return
      if (document.querySelector('.settings-backdrop')) return
      if (getCompareSession()) return
      // не «есть ли цель», а «держит ли режим холст»: в презентации «холст»
      // (оверлей спрятан) плеер на доске обязан слушаться пробела и стрелок
      if (timelineBlocksCanvas()) return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopImmediatePropagation()
        optionsRef.current.onStep(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
      } else if (e.code === 'Space') {
        e.preventDefault()
        e.stopImmediatePropagation()
        optionsRef.current.onToggle()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [options.enabled])
}
