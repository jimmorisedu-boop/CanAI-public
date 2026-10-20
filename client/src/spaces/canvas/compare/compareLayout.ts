// Раскладка режима сравнения. Пользователь её НЕ выбирает — она следует из
// типов сравниваемых объектов (решение пользователя 2026-08-06):
//   все картинки          → наложение (одна рамка: штора, подглядка, разница)
//   есть хоть одно видео  → рядом (панели с общим зумом и общим плеером)
// Наложение на движении бессмысленно: кадры расходятся сами по себе, и штора
// показывает не разницу моделей, а разницу таймкодов.

export type CompareKind = 'image' | 'video'

export type CompareLayout = 'overlay' | 'side-by-side'

// Сравниваем ПАРАМИ — исходник и один кандидат (решение пользователя
// 2026-08-06). Три кадра рядом мельчат до бесполезности, а весь смысл
// сравнения в размере. Остальные кандидаты листаются ←/→.
export const MAX_PANELS = 2

/**
 * Раскладка по умолчанию.
 *
 * ⚠️ Это именно УМОЛЧАНИЕ, а не запрет: у видео «рядом» удобнее для движения,
 * но наложение со шторой — единственный способ увидеть, что изменилось в
 * КАДРЕ. Раньше выбора не было вовсе, и на видео штора была недоступна.
 */
export function compareLayout(kinds: CompareKind[]): CompareLayout {
  return kinds.some((kind) => kind === 'video') ? 'side-by-side' : 'overlay'
}

// Человеческая подпись для плашки набора: пользователь должен узнать, что
// получится, ДО того как нажал «Сравнить».
export function layoutHint(kinds: CompareKind[]): string {
  if (kinds.length === 0) return 'Choose what to compare'
  return compareLayout(kinds) === 'overlay'
    ? 'compare as overlay'
    : 'compare side by side'
}

export type Size = { width: number; height: number }
export type Box = { x: number; y: number; width: number; height: number }

// Вписать кадр в рамку целиком (letterbox). Сохраняет пропорции, центрирует.
// Нулевые/битые размеры не должны рушить просмотрщик — отдаём всю рамку.
export function fitBox(natural: Size, frame: Size): Box {
  const { width: nw, height: nh } = natural
  if (!(nw > 0) || !(nh > 0) || !(frame.width > 0) || !(frame.height > 0)) {
    return { x: 0, y: 0, width: Math.max(0, frame.width), height: Math.max(0, frame.height) }
  }
  const scale = Math.min(frame.width / nw, frame.height / nh)
  const width = nw * scale
  const height = nh * scale
  return {
    x: (frame.width - width) / 2,
    y: (frame.height - height) / 2,
    width,
    height,
  }
}

// Общая рамка для наложения: ОБА кадра занимают один и тот же прямоугольник,
// иначе при разных пропорциях они висят по-разному и штора режет не то, а
// «Разница» сравнивает несовпадающие пиксели. Прямоугольник берём по
// пропорциям исходника, кандидат вписывается в него же (object-fit: contain).
export function overlayFrame(baseline: Size, frame: Size): Box {
  return fitBox(baseline, frame)
}

// Позиция шторы в процентах. Курсор ведёт её без зажатой кнопки — приём из
// ComparisonSlider пользователя (там `e.buttons === 0` тоже двигает).
export function wipePercent(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 50
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
  return (x / rect.width) * 100
}

// clip-path для верхнего слоя: показываем его слева от шторы.
export function wipeClipPath(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent))
  return `inset(0 ${100 - clamped}% 0 0)`
}

export type ZoomView = { scale: number; x: number; y: number }

// Куда встанет коробка после зума. Зум применяем РАЗМЕРОМ, а не
// transform: scale — иначе браузер растягивает уже отрисованный слой и
// картинка мылится, а пользователю нужно видеть полное разрешение. При явном
// размере источник пересэмплируется из оригинального битмапа.
export function zoomedBox(box: Box, frame: Size, zoom: ZoomView): Box {
  const width = box.width * zoom.scale
  const height = box.height * zoom.scale
  const centerX = frame.width / 2
  const centerY = frame.height / 2
  return {
    x: centerX + (box.x - centerX) * zoom.scale + zoom.x,
    y: centerY + (box.y - centerY) * zoom.scale + zoom.y,
    width,
    height,
  }
}

// Штора рисуется в ЭКРАННЫХ координатах рамки, а обрезается картинка. Доля
// считается от УЖЕ зумленной коробки — без этого линия и срез разъезжались
// при зуме (жалоба «штора плохо работает при зуме»).
export function wipeFractionInBox(percent: number, screenBox: Box, frame: Size): number {
  if (!(screenBox.width > 0)) return 1
  const wipeX = (Math.min(100, Math.max(0, percent)) / 100) * frame.width
  const fraction = (wipeX - screenBox.x) / screenBox.width
  return Math.min(1, Math.max(0, fraction))
}

// Натуральный размер объекта: у старых досок его может не быть — тогда берём
// размер на холсте, пропорции там те же.
export function naturalSize(item: {
  naturalWidth?: number
  naturalHeight?: number
  w: number
  h: number
}): Size {
  const width = item.naturalWidth && item.naturalWidth > 0 ? item.naturalWidth : item.w
  const height = item.naturalHeight && item.naturalHeight > 0 ? item.naturalHeight : item.h
  return { width, height }
}

// Какие объекты показать сейчас. При наложении на экране всегда пара
// «исходник + текущий кандидат»; рядом — исходник и следующие за ним, но не
// больше MAX_PANELS. Остальное листается стрелками.
export function visibleSlice<T>(
  baseline: T,
  candidates: T[],
  cursor: number,
  layout: CompareLayout,
): T[] {
  if (candidates.length === 0) return [baseline]
  const safeCursor = wrapCursor(cursor, candidates.length)
  if (layout === 'overlay') return [baseline, candidates[safeCursor]]
  const room = MAX_PANELS - 1
  const window: T[] = []
  for (let offset = 0; offset < Math.min(room, candidates.length); offset++) {
    window.push(candidates[wrapCursor(safeCursor + offset, candidates.length)])
  }
  return [baseline, ...window]
}

// Листание по кругу: с последнего кандидата стрелка вправо ведёт на первого.
export function wrapCursor(cursor: number, length: number): number {
  if (length <= 0) return 0
  return ((cursor % length) + length) % length
}
