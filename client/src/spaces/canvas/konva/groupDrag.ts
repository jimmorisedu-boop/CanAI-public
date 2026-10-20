import type { CanvasStore } from './canvasStore'

export interface DragNode {
  id(): string
  x(): number
  y(): number
  position(next: { x: number; y: number }): unknown
}

interface DragOrigin {
  id: string
  node: DragNode | null
  x: number
  y: number
  /**
   * Размеры и поворот на момент захвата — их шлёт кадр жеста коллегам.
   *
   * ⚠️ Раньше они брались из стора НА КАЖДОМ КАДРЕ: `new Map(getSelectableItems())`
   * строила карту ВСЕХ объектов доски, а Konva зовёт dragmove на сыром
   * mousemove — сто с лишним раз в секунду. На доске из полутора сотен
   * объектов это сотни тысяч записей в секунду впустую: за время переноса
   * размеры не меняются. Локальная доска такой работы не делает вовсе, и
   * отсюда «сетевая медленнее локальной» (жалоба 08.09.2026).
   */
  w: number
  h: number
  rotation?: number
}

/**
 * Сколько ждать между кадрами жеста.
 *
 * ⚠️ Сервер команды принимает не больше двадцати кадров в секунду и ЛИШНИЕ
 * ВЫБРАСЫВАЕТ (PREVIEW_WSS_LIMIT). Konva же зовёт dragmove на сыром
 * mousemove — сто с лишним раз в секунду, то есть четыре пятых работы
 * уходило в никуда: сборка кадра, JSON и отправка. Плавности от них не
 * прибавлялось — их не видел никто.
 */
export const GESTURE_FRAME_MS = 50
export interface GroupDragSession {
  leader: DragNode
  leaderX: number
  leaderY: number
  origins: DragOrigin[]
  /** Когда последний раз ушёл кадр жеста — см. GESTURE_FRAME_MS. */
  previewSentAt: number
}

// ⚠️ Инвариант группового переноса: состав и исходные координаты берём из
// модели доски, а не из набора смонтированных Konva-нод. Во время culling или
// React-перерисовки выбранная нода может на один кадр отсутствовать/вернуться
// на старую позицию. Если в этот момент считать каждую ноду отдельно, часть
// выделения остаётся на месте и уже выстроенный ряд разъезжается.
export function beginGroupDrag(store: CanvasStore, leaderId: string, nodes: DragNode[]): GroupDragSession {
  const selected = store.getSelectedIds()
  const movingIds = selected.has(leaderId) && selected.size > 1
    ? selected
    : new Set([leaderId])
  const nodesById = new Map(nodes.map((node) => [node.id(), node]))
  const itemsById = new Map(store.getSelectableItems().map((item) => [item.id, item]))
  const leader = nodesById.get(leaderId)
  if (!leader) throw new Error('Dragged object not found')
  const origins = [...movingIds].flatMap((id): DragOrigin[] => {
    const node = nodesById.get(id) ?? null
    const item = itemsById.get(id)
    if (item) {
      return [{
        id, node, x: item.x, y: item.y, w: item.w, h: item.h,
        ...('rotation' in item ? { rotation: item.rotation } : {}),
      }]
    }
    return node ? [{ id, node, x: node.x(), y: node.y(), w: 0, h: 0 }] : []
  })
  return { leader, leaderX: leader.x(), leaderY: leader.y(), origins, previewSentAt: 0 }
}

export function moveGroupDrag(session: GroupDragSession): void {
  const dx = session.leader.x() - session.leaderX
  const dy = session.leader.y() - session.leaderY
  for (const origin of session.origins) {
    if (!origin.node || origin.node === session.leader) continue
    origin.node.position({ x: origin.x + dx, y: origin.y + dy })
  }
}

export function cancelGroupDrag(session: GroupDragSession): void {
  for (const origin of session.origins) origin.node?.position({ x: origin.x, y: origin.y })
}

/**
 * Куда встанут объекты, если жест зафиксировать ПРЯМО СЕЙЧАС.
 *
 * Один вектор от лидера применяется ко ВСЕМ исходным координатам. Нельзя
 * сохранять x/y ведомых нод по отдельности: между dragmove и dragend React
 * может успеть перерисовать одну из них и разрушить взаимное расположение.
 *
 * ⚠️ Снимок отделён от записи, потому что запись бывает отложенной: на
 * сетевой доске фиксация ждёт аренду (см. commitGestureWithLease), а за это
 * время culling или перерисовка вернут ноду на прежнее место — и вектор,
 * посчитанный поздно, оказался бы нулевым.
 */
export function groupDragPositions(session: GroupDragSession): Array<{ id: string; x: number; y: number }> {
  const dx = session.leader.x() - session.leaderX
  const dy = session.leader.y() - session.leaderY
  return session.origins.map(({ id, x, y }) => ({ id, x: x + dx, y: y + dy }))
}

export function commitGroupDrag(store: CanvasStore, session: GroupDragSession): void {
  store.updatePositions(groupDragPositions(session))
}

/** Входит ли объект в текущий жест. */
export function isGroupDragMember(session: GroupDragSession, id: string): boolean {
  return session.origins.some((origin) => origin.id === id)
}

/**
 * Кто должен промолчать, когда группу записал dragend объекта `id`.
 *
 * ⚠️ Konva Transformer ведёт все выделенные ноды сам и шлёт dragend КАЖДОЙ.
 * Группу пишет первый пришедший — одним вектором и одним шагом истории.
 * Остальные обязаны промолчать: их личные координаты сняты в разные мгновения
 * жеста, и, лёгши поверх общего вектора, они разводят объекты. Прежде эти
 * dragend'ы писали себя через updateItem, и после переноса взаимные
 * расстояния менялись, а отмена возвращала объекты вразнобой.
 */
export function groupDragFollowers(session: GroupDragSession, id: string): string[] {
  return session.origins.map((origin) => origin.id).filter((other) => other !== id)
}
