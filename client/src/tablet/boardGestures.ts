import { itemAabb, rectIntersects, type Bounds } from '../spaces/canvas/konva/geometry'
import { snapMovingBoxes } from '../spaces/canvas/konva/snapMath'
import type { CanvasItem, Placeholder } from '../spaces/canvas/konva/types'

// Жесты доски на планшете.
//
// Здесь только арифметика — её можно проверить без экрана, а на экране
// остаётся тонкая обвязка. Правила выбраны так, чтобы пальцу было
// естественно, а не так, как удобно коду:
//
//  • один палец по пустому месту — везём холст;
//  • один палец по объекту — везём объект (он же при этом выделяется);
//  • два пальца — масштаб и панорама одновременно;
//  • короткое касание без движения — выделить (повторное — снять);
//  • долгое нажатие — меню объекта.
//
// Порог движения в 8 пикселей взят не с потолка: палец на стекле почти
// никогда не стоит совершенно неподвижно, и без порога любое касание
// оказывалось бы перетаскиванием.

export const TAP_SLOP_PX = 8
export const LONG_PRESS_MS = 450

/** Максимальная пауза между двумя быстрыми касаниями одного объекта. */
export const DOUBLE_TAP_MAX_MS = 360
/** Допуск дрожания пальца между двумя касаниями, в экранных пикселях. */
export const DOUBLE_TAP_MAX_DISTANCE_PX = 24

export interface TapRecord {
  itemId: string
  at: Point
  timestamp: number
}

/**
 * Проверяет вторую половину double tap.
 *
 * Тестируем объект, время и расстояние одновременно: иначе два быстрых
 * касания по соседним карточкам открывали бы не ту картинку, а случайный
 * повторный tap после перемещения камеры выглядел бы как просмотр.
 */
export function isDoubleTap(previous: TapRecord | null, next: TapRecord): boolean {
  if (!previous || previous.itemId !== next.itemId) return false
  const elapsed = next.timestamp - previous.timestamp
  if (elapsed < 0 || elapsed > DOUBLE_TAP_MAX_MS) return false
  return Math.hypot(next.at.x - previous.at.x, next.at.y - previous.at.y) <= DOUBLE_TAP_MAX_DISTANCE_PX
}

export function shouldReleasePromptFocus(
  active: { tagName: string; inTabletPrompt: boolean } | null,
): boolean {
  if (!active?.inTabletPrompt) return false
  return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT'
}

export interface Point {
  x: number
  y: number
}

export interface Camera {
  x: number
  y: number
  scale: number
}

export function screenToWorld(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale }
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y }
}

export interface PinchGeometry {
  center: Point
  distance: number
}

export function pinchGeometry(points: readonly Point[]): PinchGeometry | null {
  const [first, second] = points
  if (!first || !second) return null
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    // Ноль здесь означал бы деление на ноль при масштабировании — на стекле
    // два пальца вполне могут оказаться в одной точке.
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
  }
}

export const MIN_SCALE = 0.05
export const MAX_SCALE = 8

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Масштаб к точке: под пальцами остаётся то же место доски. */
export function zoomAt(camera: Camera, pointer: Point, nextScale: number): Camera {
  const scale = clampScale(nextScale)
  const world = screenToWorld(camera, pointer)
  return { x: pointer.x - world.x * scale, y: pointer.y - world.y * scale, scale }
}

/** Щипок: центр жеста может ещё и ехать, поэтому это не просто зум. */
export function pinchTo(
  start: { camera: Camera; center: Point; distance: number },
  current: PinchGeometry,
): Camera {
  const scale = clampScale(start.camera.scale * current.distance / start.distance)
  const world = screenToWorld(start.camera, start.center)
  return { x: current.center.x - world.x * scale, y: current.center.y - world.y * scale, scale }
}

export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x + dx, y: camera.y + dy }
}

/** Экранное смещение пальца в координаты масштабированного world-слоя. */
export function screenDeltaToWorld(delta: Point, scale: number): Point {
  return { x: delta.x / scale, y: delta.y / scale }
}

export function movedFar(from: Point, to: Point, slop: number = TAP_SLOP_PX): boolean {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > slop
}

// Всё, что лежит на доске, укладывается в этот прямоугольник: и объекты,
// и заглушки генерации. Общего типа у них нет, а геометрия одна.
type Boxed = Pick<CanvasItem, 'id' | 'x' | 'y' | 'w' | 'h' | 'rotation'>

function boxOf(item: Boxed) {
  return itemAabb(item as unknown as CanvasItem)
}

export interface DragSnapResult {
  /** Итоговый общий сдвиг выделения в мировых координатах. */
  delta: Point
  /** [x1, y1, x2, y2] в мировых координатах доски. */
  guides: number[][]
}

/**
 * Магнит для DOM-канваса планшета.
 *
 * `rawDelta` уже повторяет путь пальца в мировых координатах. Мы лишь добавляем
 * короткую поправку до ближайшего края/центра, поэтому вся группа продолжает
 * двигаться одним вектором и не меняет взаимное расположение объектов.
 */
export function snapDragToContent(
  items: readonly Boxed[],
  movingIds: readonly string[],
  grabbedId: string,
  rawDelta: Point,
  scale: number,
): DragSnapResult {
  const movingSet = new Set(movingIds)
  const moving = items.filter((item) => movingSet.has(item.id))
  const grabbed = moving.find((item) => item.id === grabbedId)
  const ordered = grabbed ? [grabbed, ...moving.filter((item) => item.id !== grabbedId)] : moving
  const movedBoxes = ordered.map((item) => {
    const box = boxOf(item)
    return { ...box, x: box.x + rawDelta.x, y: box.y + rawDelta.y }
  })
  const otherBoxes = items.filter((item) => !movingSet.has(item.id)).map(boxOf)
  // Порог задаётся в экранных пикселях: на далёком и близком зуме магнит
  // ощущается одинаково, как и на основном Konva-канвасе.
  const threshold = 8 / Math.max(0.05, scale)
  const snap = snapMovingBoxes(movedBoxes, otherBoxes, threshold)
  return {
    delta: { x: rawDelta.x + snap.dx, y: rawDelta.y + snap.dy },
    guides: snap.guides,
  }
}

/**
 * Что под пальцем.
 *
 * Идём с конца: последний объект списка нарисован сверху, и попадать палец
 * должен именно в него. Заглушки генерации участвуют наравне с объектами —
 * по ним тоже нажимают (отмена, «показать»).
 */
export function hitTest(items: readonly Boxed[], world: Point): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    const box = boxOf(item)
    if (world.x >= box.x && world.x <= box.x + box.w && world.y >= box.y && world.y <= box.y + box.h) {
      return item.id
    }
  }
  return null
}

/** Прямоугольник экрана в мировых координатах — для отсечения невидимого. */
export function viewportBounds(camera: Camera, viewport: { w: number; h: number }, padRatio = 0.5): Bounds {
  const padX = (viewport.w * padRatio) / camera.scale
  const padY = (viewport.h * padRatio) / camera.scale
  const topLeft = screenToWorld(camera, { x: 0, y: 0 })
  return {
    x: topLeft.x - padX,
    y: topLeft.y - padY,
    w: viewport.w / camera.scale + padX * 2,
    h: viewport.h / camera.scale + padY * 2,
  }
}

/**
 * Что рисовать.
 *
 * На доске бывают сотни картинок, и планшет не должен держать в памяти все
 * разом: вкладка Safari вылетает по памяти раньше, чем кончается терпение.
 * Рисуем то, что в кадре, плюс запас в пол-экрана — тот же приём, что у
 * культинга на компьютере.
 */
export function visibleOnScreen<T extends Boxed>(
  items: readonly T[],
  camera: Camera,
  viewport: { w: number; h: number },
  alwaysVisible: ReadonlySet<string> = new Set(),
): T[] {
  // ⚠️ Нулевой замер окна — это НЕ «ничего не видно».
  //
  // Размер приходит от ResizeObserver, и он бывает нулевым: пока идёт первая
  // раскладка, при повороте, в раздельном экране, в свёрнутой вкладке. С
  // отсечением по такому размеру доска рисует пустоту — а пустой холст человек
  // читает как «мой материал пропал» (поймано живым прогоном). Лишние узлы в
  // разметке стоят несравнимо меньше.
  if (viewport.w < 2 || viewport.h < 2) return [...items]
  const bounds = viewportBounds(camera, viewport)
  return items.filter((item) => alwaysVisible.has(item.id) || rectIntersects(boxOf(item), bounds))
}

/** Вписать всё в экран — «показать доску целиком». */
export function fitCamera(
  items: readonly Boxed[],
  viewport: { w: number; h: number },
  padding = 48,
): Camera {
  if (items.length === 0) return { x: viewport.w / 2, y: viewport.h / 2, scale: 1 }
  const boxes = items.map(boxOf)
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  const scale = clampScale(Math.min(
    2,
    Math.min(
      (viewport.w - padding * 2) / Math.max(1, right - left),
      (viewport.h - padding * 2) / Math.max(1, bottom - top),
    ),
  ))
  return {
    x: viewport.w / 2 - ((left + right) / 2) * scale,
    y: viewport.h / 2 - ((top + bottom) / 2) * scale,
    scale,
  }
}

/** Показать один объект крупно — по нему подъезжаем после генерации. */
export function focusCamera(
  item: Boxed,
  viewport: { w: number; h: number },
  padding = 64,
): Camera {
  return fitCamera([item], viewport, padding)
}

export type BoardItem = CanvasItem | Placeholder

/** Заглушку от объекта отличает `status`: у готового объекта его нет. */
export function isPlaceholder(item: BoardItem): item is Placeholder {
  return 'status' in item
}

/** Крупный просмотр относится к готовому фото/видео, а не к заглушке или тексту. */
export function isViewerItem(item: BoardItem | undefined): item is CanvasItem & { kind: 'image' | 'video'; src: string } {
  return Boolean(item && !isPlaceholder(item) && (item.kind === 'image' || item.kind === 'video') && item.src)
}
