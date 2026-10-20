import type { PointerEvent as ReactPointerEvent } from 'react'

// Перетаскивание в правке клипа: ручки входа/выхода, стыки резов, рамка
// кадрирования, сама головка. Общий приём один, и он держит два правила.

/**
 * Слушаем ОКНО, а не сам элемент, и захват указателя считаем необязательным.
 * Тяга стыка вниз по замыслу уводит указатель далеко от метки — на элементе
 * события там уже не появляются. А если setPointerCapture почему-то не
 * сработает (так и вышло при проверке), жест обязан продолжать работать, а не
 * умирать молча: захват здесь ускорение, а не условие.
 *
 * Возвращает функцию «оборвать жест» — размонтирование посреди перетаскивания
 * не должно оставлять слушателей на окне.
 */
export function beginPointerDrag(
  event: ReactPointerEvent,
  onMove: (moveEvent: PointerEvent) => void,
  onDone: () => void,
): () => void {
  event.preventDefault()
  event.stopPropagation()
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // Захвата не будет — слушатели на окне справятся и без него.
  }
  let live = true
  const finish = () => {
    if (!live) return
    live = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    onDone()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  return finish
}
