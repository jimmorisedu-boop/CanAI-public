import { useEffect, useRef } from 'react'

/**
 * Обработчик нажатий на окне, который читает СВЕЖЕЕ состояние, а подписывается
 * один раз. Раньше оверлей переподписывался на каждый timeupdate: в зависимости
 * эффекта стояли session и frames, а это новые объекты на каждый рендер — то
 * есть при воспроизведении окно снимало и вешало слушатель по четыре раза в
 * секунду, и между снятием и повешением нажатие могло пройти мимо.
 */
export function useWindowKeydown(handler: (event: KeyboardEvent) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => latest.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
