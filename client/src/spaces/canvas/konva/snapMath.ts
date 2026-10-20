// Арифметика смарт-гайдов, отдельно от Konva: правило «к чему липнуть»
// проверяется тестами, а applySnapGuides остаётся тонкой обвязкой.

export interface SnapBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapResult {
  /** На сколько сдвинуть перетаскиваемое, чтобы прилипло. */
  dx: number
  dy: number
  /** Направляющие для отрисовки: [x1, y1, x2, y2] в мировых координатах. */
  guides: number[][]
}

interface AxisHit {
  d: number
  line: number
  from: number
  to: number
}

/** Ближайшее совпадение по каждой оси для ОДНОЙ рамки. */
function bestHits(
  box: SnapBox,
  others: readonly SnapBox[],
  threshold: number,
): { x: AxisHit | null; y: AxisHit | null } {
  let bestX: AxisHit | null = null
  let bestY: AxisHit | null = null

  for (const other of others) {
    for (const target of [other.x, other.x + other.w / 2, other.x + other.w]) {
      for (const anchor of [box.x, box.x + box.w / 2, box.x + box.w]) {
        const d = target - anchor
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) {
          bestX = {
            d,
            line: target,
            from: Math.min(other.y, box.y),
            to: Math.max(other.y + other.h, box.y + box.h),
          }
        }
      }
    }
    for (const target of [other.y, other.y + other.h / 2, other.y + other.h]) {
      for (const anchor of [box.y, box.y + box.h / 2, box.y + box.h]) {
        const d = target - anchor
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) {
          bestY = {
            d,
            line: target,
            from: Math.min(other.x, box.x),
            to: Math.max(other.x + other.w, box.x + box.w),
          }
        }
      }
    }
  }

  return { x: bestX, y: bestY }
}

function toResult(x: AxisHit | null, y: AxisHit | null): SnapResult {
  const guides: number[][] = []
  if (x) guides.push([x.line, x.from, x.line, x.to])
  if (y) guides.push([y.from, y.line, y.to, y.line])
  return { dx: x?.d ?? 0, dy: y?.d ?? 0, guides }
}

/** Сверх этого числа выделенных якорями остаются только общая рамка и
 *  схваченный объект — см. оговорку внутри snapMovingBoxes. */
export const MAX_ITEM_ANCHORS = 12

/**
 * Куда прилипает НАБОР движимых рамок. Рамки приходят уже сдвинутыми — там,
 * где они сейчас под курсором.
 *
 * ⚠️ Якорей ДВА ВИДА, и это снимает противоречие, на котором выравнивание
 * ломалось дважды:
 *
 *   1. Общий прямоугольник всей группы. Без него тянешь стопку за среднюю
 *      картинку — направляющая показывает, что прилипла ОНА, а стопка встаёт
 *      мимо (жалоба 18.08.2026).
 *   2. Каждый движимый объект по отдельности. Без него направляющие почти
 *      перестают появляться: общий прямоугольник — фигура, которой на доске
 *      нет, и на разноразмерном материале его края почти ни с чем не
 *      совпадают. Замер на доске из восьми генераций разных пропорций: у
 *      одного объекта направляющая видна в 31% положений, у двух — в 11%
 *      (жалоба 26.08.2026; после починки 31% и 33%).
 *
 * Побеждает БЛИЖАЙШЕЕ совпадение, и по каждой оси отдельно. Направляющая
 * рисуется ровно для того якоря, который прилип, — то есть человек видит
 * именно то, что произойдёт. Вся группа при этом сдвигается на один и тот же
 * вектор, взаимные расстояния не меняются.
 */
export function snapMovingBoxes(
  /** Движимые рамки, СХВАЧЕННАЯ первой: на неё человек и смотрит. */
  moving: readonly SnapBox[],
  others: readonly SnapBox[],
  threshold: number,
): SnapResult {
  if (moving.length === 0) return { dx: 0, dy: 0, guides: [] }
  const union = unionBox(moving)
  // ⚠️ У крупного выделения якорями остаются только общая рамка и схваченный
  // объект. Это не экономия ради экономии: якорей N+1, и на доске из 1500
  // объектов при 300 выделенных полный перебор стоил 27 мс — а зовут это на
  // КАЖДОЕ движение мыши, не раз в кадр (Konva вешает драг на сырые
  // mousemove/touchmove и сразу шлёт dragmove, без rAF). Тонкое выравнивание
  // на пачке из сотен объектов всё равно не делают; а на «нескольких
  // единицах», ради которых починка и делалась, ограничение не срабатывает
  // вовсе — оно начинается после MAX_ITEM_ANCHORS.
  const anchors = moving.length === 1
    ? moving
    : moving.length > MAX_ITEM_ANCHORS
      ? [union, moving[0]!]
      : [union, ...moving]

  // Отсекаем заведомо далёких соседей: любой якорь лежит внутри общей рамки,
  // значит цель может совпасть, только если её края попадают в рамку,
  // расширенную на порог.
  //
  // ⚠️ Проверка идёт по КАЖДОЙ оси отдельно (`||`, не `&&`) и с запасом ровно
  // в порог: липнет каждая ось сама по себе, поэтому объект далеко внизу всё
  // равно даёт вертикальную направляющую, если совпадает по горизонтали, а
  // сосед сразу за рамкой — ещё в пределах прилипания.
  //
  // Выигрыш даёт КОМПАКТНОЕ выделение на большой доске (замер, 1500 объектов:
  // пятеро рядом — 0.14 мс против 0.43 без отсечения). На выделении, растянутом
  // через всю доску, отсекать нечего и проверка стоит лишнего (0.22 против
  // 0.09) — там работает потолок якорей выше.
  const near = others.filter((other) => (
    (other.x <= union.x + union.w + threshold && other.x + other.w >= union.x - threshold)
    || (other.y <= union.y + union.h + threshold && other.y + other.h >= union.y - threshold)
  ))

  let bestX: AxisHit | null = null
  let bestY: AxisHit | null = null
  for (const anchor of anchors) {
    const { x, y } = bestHits(anchor, near, threshold)
    if (x && (!bestX || Math.abs(x.d) < Math.abs(bestX.d))) bestX = x
    if (y && (!bestY || Math.abs(y.d) < Math.abs(bestY.d))) bestY = y
  }
  return toResult(bestX, bestY)
}

/** Общий прямоугольник нескольких объектов. Пустой список — пустая рамка. */
export function unionBox(boxes: readonly SnapBox[]): SnapBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const box of boxes) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.w)
    bottom = Math.max(bottom, box.y + box.h)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export interface ResizeSnapResult {
  /** Куда встанет рамка после прилипания. */
  box: SnapBox
  /** Направляющие для отрисовки: [x1, y1, x2, y2] в мировых координатах. */
  guides: number[][]
}

export interface ResizeSnapOptions {
  /**
   * Transformer картинок/видео уже даёт пропорциональную рамку. Если
   * смарт-гайд сместит только один край, он не имеет права менять
   * соотношение сторон. В таком случае прилипание отменяется целиком.
   */
  preserveAspectRatio?: boolean
}

function sameAspectRatio(first: SnapBox, second: SnapBox): boolean {
  const left = first.w * second.h
  const right = first.h * second.w
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-6
}

/**
 * Куда прилипает рамка, которой МЕНЯЮТ РАЗМЕР.
 *
 * ⚠️ Это не то же самое, что перенос, и потому считается отдельно. При
 * переносе едет вся рамка, и поправка у неё одна на все края; при изменении
 * размера часть краёв стоит на месте — их трогать нельзя, иначе объект поедет
 * вслед за ручкой, за которую не тянут. Поэтому липнет только тот край,
 * который человек и правда двигает: сравниваем с рамкой на момент захвата и
 * считаем движущимся всё, что от неё отличается.
 *
 * Центр в якорях не участвует намеренно: при растяжении он ползёт сам собой, и
 * прилипание к нему выглядело бы случайным рывком.
 */
export function snapResizedBox(
  box: SnapBox,
  /** Рамка на момент начала жеста — по ней и видно, какие края поехали. */
  origin: SnapBox,
  others: readonly SnapBox[],
  threshold: number,
  options: ResizeSnapOptions = {},
): ResizeSnapResult {
  const moved = {
    left: Math.abs(box.x - origin.x) > 0.01,
    right: Math.abs(box.x + box.w - (origin.x + origin.w)) > 0.01,
    top: Math.abs(box.y - origin.y) > 0.01,
    bottom: Math.abs(box.y + box.h - (origin.y + origin.h)) > 0.01,
  }
  const near = others.filter((other) => (
    (other.x <= box.x + box.w + threshold && other.x + other.w >= box.x - threshold)
    || (other.y <= box.y + box.h + threshold && other.y + other.h >= box.y - threshold)
  ))

  // Ищем ближайшую цель для КАЖДОГО движущегося края отдельно: у левого и
  // правого поправки разные, общего вектора здесь нет.
  const best = (edge: number, targets: readonly number[]): { d: number; line: number } | null => {
    let hit: { d: number; line: number } | null = null
    for (const target of targets) {
      const d = target - edge
      if (Math.abs(d) <= threshold && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, line: target }
    }
    return hit
  }
  const xTargets = near.flatMap((other) => [other.x, other.x + other.w / 2, other.x + other.w])
  const yTargets = near.flatMap((other) => [other.y, other.y + other.h / 2, other.y + other.h])

  let { x, y, w, h } = box
  const guides: number[][] = []
  const span = (from: number, to: number): [number, number] => [Math.min(from, to), Math.max(from, to)]

  const left = moved.left ? best(x, xTargets) : null
  const right = moved.right ? best(x + w, xTargets) : null
  // Обе стороны сразу не двигают: ручка тянет одну. Если совпало и там и там,
  // берём ближайшую — она и есть та, за которую держатся.
  const horizontal = left && right ? (Math.abs(left.d) <= Math.abs(right.d) ? 'left' : 'right') : left ? 'left' : right ? 'right' : null
  if (horizontal === 'left' && left) {
    x += left.d
    w -= left.d
    const [from, to] = span(y, y + h)
    guides.push([left.line, from, left.line, to])
  } else if (horizontal === 'right' && right) {
    w += right.d
    const [from, to] = span(y, y + h)
    guides.push([right.line, from, right.line, to])
  }

  const top = moved.top ? best(y, yTargets) : null
  const bottom = moved.bottom ? best(y + h, yTargets) : null
  const vertical = top && bottom ? (Math.abs(top.d) <= Math.abs(bottom.d) ? 'top' : 'bottom') : top ? 'top' : bottom ? 'bottom' : null
  if (vertical === 'top' && top) {
    y += top.d
    h -= top.d
    const [from, to] = span(x, x + w)
    guides.push([from, top.line, to, top.line])
  } else if (vertical === 'bottom' && bottom) {
    h += bottom.d
    const [from, to] = span(x, x + w)
    guides.push([from, bottom.line, to, bottom.line])
  }

  const snappedBox = { x, y, w, h }
  if (options.preserveAspectRatio && !sameAspectRatio(box, snappedBox)) {
    return { box, guides: [] }
  }
  return { box: snappedBox, guides }
}
