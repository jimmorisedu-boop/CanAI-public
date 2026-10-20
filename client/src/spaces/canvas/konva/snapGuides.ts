import type Konva from 'konva'
import type { CanvasStore } from './canvasStore'
import { snapMovingBoxes, snapResizedBox, type SnapBox } from './snapMath'

// Смарт-гайды (как в Figma): при перетаскивании объект прилипает краями и
// центром к краям/центрам других объектов, и рисуются направляющие. Порог —
// в экранных пикселях (делим на масштаб), чтобы «липкость» не зависела от зума.
const SNAP_PX = 6

// onDragMove: правит позицию ноды (прилипание) и кладёт направляющие в стор.
//
// `ownPlaces` — перенос с копией (Alt, см. altDragCopy): исходники остаются
// на своих местах, значит копия вправе липнуть и к ним. Так и ставят ровный
// ряд: потащил копию вбок — она держит линию исходника.
export function applySnapGuides(
  store: CanvasStore,
  id: string,
  node: Konva.Node,
  options: { ownPlaces?: boolean } = {},
): void {
  const item = store.getItem(id) || store.getPending().find((p) => p.id === id)
  if (!item) return
  const threshold = SNAP_PX / store.getCamera().scale

  // Насколько схваченный объект уже уехал от своего места в сторе. Тот же
  // сдвиг у всех, кто едет вместе с ним (см. moveGroupDrag), поэтому по нему
  // и достраивается общая рамка группы.
  const dx = node.x() - item.x
  const dy = node.y() - item.y

  const selected = store.getSelectedIds()
  const all = [...store.getItems(), ...store.getPending()]
  // Едет вся выделенная группа, если схваченный объект в неё входит. К самим
  // себе не липнем — иначе группа прилипала бы к собственным краям.
  const movingIds = selected.has(id) && selected.size > 1 ? selected : new Set([id])
  const moving = all.filter((candidate) => movingIds.has(candidate.id))
  const others = options.ownPlaces ? all : all.filter((candidate) => !movingIds.has(candidate.id))

  // Все движимые сдвинуты на ОДИН И ТОТ ЖЕ вектор (см. moveGroupDrag), поэтому
  // их нынешние места достраиваются смещением схваченного.
  // Схваченный объект — ПЕРВЫМ: у крупного выделения якорями остаются только
  // он и общая рамка (см. snapMovingBoxes), и это должен быть именно тот
  // объект, за который тянут.
  const source = moving.length > 0
    ? [item, ...moving.filter((candidate) => candidate.id !== id)]
    : [item]
  const boxes: SnapBox[] = source.map((candidate) => ({
    x: candidate.x + dx,
    y: candidate.y + dy,
    w: candidate.w,
    h: candidate.h,
  }))

  // Якорем считается и общая рамка группы, и каждый объект в ней — какой
  // ближе, тот и липнет (см. snapMovingBoxes: там записано, почему оба).
  const snap = snapMovingBoxes(boxes, others, threshold)
  if (snap.dx || snap.dy) node.position({ x: node.x() + snap.dx, y: node.y() + snap.dy })
  store.setGuides(snap.guides)
}

export function clearGuides(store: CanvasStore): void {
  store.setGuides([])
}

/**
 * Смарт-гайды при ИЗМЕНЕНИИ РАЗМЕРА (просьба 09.09.2026).
 *
 * ⚠️ Раньше направляющие жили только у переноса, и подогнать картинку по краю
 * соседней приходилось на глаз — хотя выравнивают материал чаще именно
 * размером. Правило то же, что у переноса, но липнет только тот край, который
 * человек и правда двигает: см. snapResizedBox.
 *
 * Работает при ОДНОМ выделенном объекте: у пачки Transformer тянет общую рамку
 * и раскладывает её по объектам сам, и вмешиваться в это прилипанием — значит
 * ломать взаимные пропорции.
 *
 * Возвращает исправленные размеры, если прилипло, — вызывающий применяет их к
 * ноде вместе со своим пересчётом scale.
 */
export function applyResizeSnapGuides(
  store: CanvasStore,
  id: string,
  box: SnapBox,
  preserveAspectRatio = false,
): SnapBox {
  const origin = store.getItem(id) || store.getPending().find((p) => p.id === id)
  if (!origin) return box
  const threshold = SNAP_PX / store.getCamera().scale
  const others = [...store.getItems(), ...store.getPending()].filter((candidate) => candidate.id !== id)
  const snapped = snapResizedBox(box, origin, others, threshold, { preserveAspectRatio })
  store.setGuides(snapped.guides)
  return snapped.box
}
