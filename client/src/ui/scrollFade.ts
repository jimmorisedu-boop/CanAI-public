import { useEffect, type RefObject } from 'react'

// Строка, которая едет вбок без полосы прокрутки.
//
// Полоса под рядом маленьких «пилюль» выглядит поломкой (жалоба 02.10.2026
// «появилась ненужная полоса прокрутки»), но и убрать её молча нельзя: за
// краем могут остаться параметры, которые уйдут в оплаченную генерацию.
// Поэтому край, за которым что-то есть, «тает», а колесо мыши возит строку.

export type FadeEdges = 'none' | 'start' | 'end' | 'both'

/** Доли пикселя при дробном масштабе экрана — ещё не переполнение. */
const SLACK = 1

/** С какой стороны за краем осталось содержимое. */
export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): FadeEdges {
  const overflow = scrollWidth - clientWidth
  if (!(overflow > SLACK)) return 'none'
  const start = scrollLeft > SLACK
  const end = scrollLeft < overflow - SLACK
  if (start && end) return 'both'
  if (start) return 'start'
  return end ? 'end' : 'none'
}

/**
 * На сколько сдвинуть строку по обычному (вертикальному) колесу; null — колесо
 * не наше. Берём только то, с чем браузер не справится сам: вбок (тачпад,
 * Shift+колесо) он прокрутит и без нас, а Ctrl+колесо — это масштаб страницы.
 */
export function wheelShift(
  event: { deltaX: number; deltaY: number; ctrlKey: boolean; shiftKey: boolean },
  overflow: number,
): number | null {
  if (!(overflow > SLACK) || event.ctrlKey || event.shiftKey) return null
  if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return null
  return event.deltaY
}

function syncFade(element: HTMLElement): void {
  const next = fadeEdges(element.scrollLeft, element.clientWidth, element.scrollWidth)
  if (element.dataset.fade !== next) element.dataset.fade = next
}

/** Ставит строке `data-fade` (какой край тает) и возит её колесом. */
export function useScrollFade(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const update = () => syncFade(element)
    const onWheel = (event: WheelEvent) => {
      const shift = wheelShift(event, element.scrollWidth - element.clientWidth)
      if (shift === null) return
      event.preventDefault()
      element.scrollLeft += shift
      // Событие scroll приходит только с кадром; край меняем сразу.
      update()
    }
    element.addEventListener('scroll', update, { passive: true })
    // React вешает wheel пассивно — отменить прокрутку страницы оттуда нельзя.
    element.addEventListener('wheel', onWheel, { passive: false })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    // Шрифт догружается после первой отрисовки, и ширина подписей меняется.
    void document.fonts?.ready.then(update).catch(() => {})
    return () => {
      element.removeEventListener('scroll', update)
      element.removeEventListener('wheel', onWheel)
      observer?.disconnect()
      delete element.dataset.fade
    }
  }, [ref, enabled])

  // После КАЖДОЙ отрисовки: набор «пилюль» меняется вместе с моделью, а размер
  // самой строки при этом прежний — наблюдатель за ней промолчал бы.
  useEffect(() => {
    if (enabled && ref.current) syncFade(ref.current)
  })
}
