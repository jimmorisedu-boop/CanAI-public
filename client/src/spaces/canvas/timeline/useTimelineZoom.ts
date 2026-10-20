import { useCallback, useMemo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useSharedZoom } from '../../../ui/useSharedZoom'
import { panLimits } from './timelineCanvasMath'

/**
 * Зум и панорама превью правки клипа поверх общего хука `useSharedZoom`.
 *
 * Трансформ висит на СЦЕНЕ (кадр вместе с рамкой кадрирования), а не на видео:
 * рамка задана долями сцены и едет вместе с кадром, разъехаться с ним не может.
 *
 * Что здесь чинилось (раньше зум был сломан):
 *  - пределы панорамы считались как «зажатое смещение нуля» и всегда давали
 *    {0, 0} — пан был зажат в центр. Теперь это настоящий коридор
 *    (`panLimits`), посчитанный от размеров БЕЗ масштаба: `offsetWidth` не
 *    включает transform, в отличие от getBoundingClientRect, который мерил
 *    уже приближённую сцену;
 *  - колесо приближало к центру, а не к курсору — включён `zoomToCursor`;
 *  - тащить приближённый кадр можно за пределы окна: указатель захватывается,
 *    иначе жест терялся, стоило выйти из окна просмотра.
 * Сравнение (compare) пользуется тем же хуком, но этих настроек не включает.
 */
export function useTimelineZoom(
  viewportRef: RefObject<HTMLDivElement>,
  stageRef: RefObject<HTMLDivElement>,
) {
  // Объект настроек обязан быть СТАБИЛЬНЫМ: хук пересобирает обработчики по
  // его ссылке, и новый объект на каждый рендер переподписывал бы колесо на
  // каждый кадр воспроизведения.
  const options = useMemo(() => ({
    zoomToCursor: true,
    bounds: (scale: number) => {
      const view = viewportRef.current
      const stage = stageRef.current
      if (!view || !stage || view.clientWidth <= 0 || view.clientHeight <= 0) return null
      return panLimits(
        scale,
        { width: view.clientWidth, height: view.clientHeight },
        { width: stage.offsetWidth, height: stage.offsetHeight },
      )
    },
  }), [viewportRef, stageRef])

  const { zoom, zoomed, reset, zoomToPoint, surfaceProps } = useSharedZoom(viewportRef, options)

  /** Панорама левой кнопкой. На вписанном кадре хук молчит (тащить нечего),
   *  поэтому обычный клик ничего не ломает. Рамка кадрирования ловит свои
   *  нажатия сама и гасит их — до панорамы они не доходят. */
  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    surfaceProps.onPointerDown(event)
    if (event.button !== 0 || !zoomed) return
    try {
      viewportRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // Захвата не будет — жест просто не переживёт выход за окно.
    }
  }, [surfaceProps, viewportRef, zoomed])

  /** Двойной клик: «вписано» ↔ 2× в точке клика. Это НЕ «100%»: натуральный
   *  размер нужен захвату и кропу отдельно, а жест просто приближает. */
  const toggleFullSize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    // Двойной клик по рамке кадрирования или её ручке — это работа с рамкой.
    if ((event.target as HTMLElement).closest('.tl-cmove, .tl-ch')) return
    const view = viewportRef.current?.getBoundingClientRect()
    if (!view) return
    if (zoomed) {
      reset()
      return
    }
    zoomToPoint(
      2,
      { x: event.clientX - view.left, y: event.clientY - view.top },
      { width: view.width, height: view.height },
    )
  }, [viewportRef, zoomed, reset, zoomToPoint])

  return {
    zoom,
    zoomed,
    reset,
    viewportProps: {
      ...surfaceProps,
      onPointerDown: startPan,
      onDoubleClick: toggleFullSize,
    },
  }
}
