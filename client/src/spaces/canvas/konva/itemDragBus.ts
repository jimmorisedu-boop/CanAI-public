/**
 * Смещение текущего жеста перетаскивания — для HTML-панелей поверх холста.
 *
 * ⚠️ Пока объект тащат, стор о переезде НЕ знает: двигается только нода Konva,
 * а позиция фиксируется на отпускании (иначе каждый кадр жеста стал бы шагом
 * отмены). Панель над объектом при этом считает своё место по стору — и
 * оставалась на старом, догоняя объект лишь в конце. Со стороны это выглядит
 * как «иконки двигаются с запозданием» (жалоба 07.09.2026).
 *
 * Поэтому смещение уезжает мимо React, прямой шиной: подписчик кладёт его в
 * `style.transform` и едет с объектом кадр в кадр. Тот же приём, что у меток
 * обсуждения (`annotationCameraBus`).
 */

export interface CanvasDragOffset {
  /** Кого тащат: панель следует только за своим объектом. */
  ids: readonly string[]
  /** Смещение в МИРОВЫХ координатах: на экранные его переводит подписчик,
   *  у которого под рукой актуальный масштаб. */
  dx: number
  dy: number
}

type Listener = (offset: CanvasDragOffset | null) => void

const listeners = new Set<Listener>()
let current: CanvasDragOffset | null = null

export function publishCanvasDrag(offset: CanvasDragOffset | null): void {
  current = offset
  for (const listener of [...listeners]) listener(offset)
}

export function getCanvasDrag(): CanvasDragOffset | null {
  return current
}

export function subscribeCanvasDrag(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Насколько сдвинуть панель, следящую за этими объектами. */
export function dragOffsetFor(
  offset: CanvasDragOffset | null,
  ids: readonly string[],
): { dx: number; dy: number } {
  if (!offset) return { dx: 0, dy: 0 }
  return ids.some((id) => offset.ids.includes(id)) ? { dx: offset.dx, dy: offset.dy } : { dx: 0, dy: 0 }
}
