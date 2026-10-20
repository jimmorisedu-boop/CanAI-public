// Жесты несколькими пальцами поверх доски.
//
// Здесь только арифметика: сколько пальцев, далеко ли ушли, сколько держат —
// и что из этого следует. Такое проверяется без экрана, а на экране остаётся
// подписка на события (useBoardFingerGestures).
//
// Набор взят из привычек iPadOS и рисовалок, чтобы человеку не пришлось
// учить наш собственный язык:
//
//  • два пальца тапом — отменить, тремя — вернуть;
//  • два пальца удерживать — отменять подряд, тремя — возвращать подряд;
//  • три пальца влево/вправо — отменить/вернуть (системный жест iPadOS);
//  • три пальца вниз — меню копирования и вставки;
//  • четыре пальца тапом — убрать интерфейс с глаз и вернуть обратно.
//
// ⚠️ Два пальца — это ещё и щипок с панорамой доски, а три вниз легко спутать
// с тремя вбок. Поэтому решает не число пальцев само по себе, а ДВИЖЕНИЕ:
// пока пальцы стоят, это тап или удержание; поехали — жест уже другой.

/** Дальше этого касание считается движением, а не тапом. */
export const TAP_MAX_MOVE_PX = 12
/**
 * Насколько пальцы могут разъехаться, оставаясь тапом.
 *
 * ⚠️ Щипок почти не двигает ЦЕНТР касаний — пальцы расходятся от него в
 * разные стороны. То есть по одному центру мелкий щипок неотличим от
 * неподвижного тапа двумя пальцами, и доска молча отменяла бы действие
 * вместо того, чтобы приблизиться. Разлёт — второй, независимый признак.
 */
export const TAP_MAX_SPREAD_PX = 14
/**
 * Дольше этого — уже не тап: человек не «щёлкнул», а задержался.
 *
 * ⚠️ Срок считается от момента, когда лёг ПОСЛЕДНИЙ палец, до момента, когда
 * ушёл последний: пальцы не приземляются и не снимаются одновременно, и на
 * это разъезжание уходит заметная часть срока. Прежние 320 мс отбраковывали
 * обычный тап тремя пальцами (жалоба 09.09.2026 «плохо срабатывает тап двумя
 * пальцами и тремя»); до удержания (600 мс) запас всё равно остаётся.
 */
export const TAP_MAX_MS = 500
/** Сколько неподвижно держать, прежде чем начнётся повтор. */
export const HOLD_START_MS = 600
/**
 * Трём пальцам оставляем чуть больше времени на отпускание.
 *
 * Safari может прислать первый `touchend` заметно позже последнего
 * `touchstart`: ладонь снимается не синхронно, а система ещё успевает
 * классифицировать многопальцевый жест. Порог всё равно ниже удержания,
 * поэтому долгий жест уйдёт в `trackHold`, а не станет тапом.
 */
export const THREE_FINGER_TAP_MAX_MS = HOLD_START_MS - 20
/** Как часто повторять, пока держат. */
export const HOLD_REPEAT_MS = 220
/** Ход, после которого свайп считается состоявшимся. */
export const SWIPE_MIN_PX = 70
/**
 * Насколько вторая ось может «болтаться» у направленного свайпа.
 *
 * Палец не ездит по линейке: горизонтальный свайп всегда немного заваливается
 * вниз. Без допуска жест почти не срабатывал бы, с большим — «влево» и «вниз»
 * стали бы одним и тем же.
 */
export const SWIPE_MAX_TILT = 0.7

export type FingerAction = 'undo' | 'redo' | 'clipboard' | 'chrome'

/** Где сейчас рука: центр касаний и то, насколько пальцы разведены. */
export interface TouchShape {
  center: { x: number; y: number }
  spread: number
}

/** Центр касаний: жест считаем по нему, а не по первому попавшемуся пальцу. */
export function touchCenter(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } | null {
  if (points.length === 0) return null
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / points.length, y: y / points.length }
}

/** Центр плюс средний радиус: по первому видно панораму, по второму — щипок. */
export function touchShape(points: ReadonlyArray<{ x: number; y: number }>): TouchShape | null {
  const center = touchCenter(points)
  if (!center) return null
  let spread = 0
  for (const point of points) spread += Math.hypot(point.x - center.x, point.y - center.y)
  return { center, spread: spread / points.length }
}

/**
 * Короткое касание без движения.
 *
 * ⚠️ Одному пальцу здесь делать нечего: им выделяют объекты и возят холст.
 */
export function tapAction(fingers: number): FingerAction | null {
  if (fingers === 2) return 'undo'
  if (fingers === 3) return 'redo'
  if (fingers === 4) return 'chrome'
  return null
}

/**
 * Неподвижное удержание. Повторяется, пока пальцы на месте.
 *
 * ⚠️ Четыре пальца сюда НЕ входят: «убрать интерфейс» — переключатель, и
 * повторять его значит мигать экраном.
 */
export function holdAction(fingers: number): FingerAction | null {
  if (fingers === 2) return 'undo'
  if (fingers === 3) return 'redo'
  return null
}

/** Направленный свайп. Разбирается только у трёх пальцев. */
export function swipeAction(fingers: number, dx: number, dy: number): FingerAction | null {
  if (fingers !== 3) return null
  const horizontal = Math.abs(dx)
  const vertical = Math.abs(dy)
  if (horizontal >= SWIPE_MIN_PX && vertical <= horizontal * SWIPE_MAX_TILT) {
    return dx < 0 ? 'undo' : 'redo'
  }
  // Вниз — меню копирования; вверх не занято намеренно: у Safari там свои
  // системные жесты, и спорить с ними бессмысленно.
  if (vertical >= SWIPE_MIN_PX && dy > 0 && horizontal <= vertical * SWIPE_MAX_TILT) {
    return 'clipboard'
  }
  return null
}

/** Прежнее имя: свайп влево/вправо тремя пальцами. Оставлено для читателя. */
export function swipeVerdict(dx: number, dy: number): 'undo' | 'redo' | null {
  const action = swipeAction(3, dx, dy)
  return action === 'undo' || action === 'redo' ? action : null
}

export interface FingerSession {
  /** Сколько пальцев было на пике касания — по ним и решаем, что это за жест. */
  fingers: number
  from: { x: number; y: number }
  spread: number
  startedAt: number
  /** Насколько далеко центр уходил от начала — тап этого не прощает. */
  moved: number
  /** Насколько менялся разлёт пальцев — так узнаётся щипок. */
  spreadChange: number
  /** Пальцы уже снимают: дальше рука разъезжается, и движение не в счёт. */
  releasing: boolean
  /** Жест уже сработал: второй раз за одно касание не срабатываем. */
  fired: boolean
  /** Когда в последний раз сработало удержание. */
  repeatedAt: number | null
}

export function beginSession(
  fingers: number,
  shape: TouchShape,
  at: number,
): FingerSession | null {
  if (fingers < 2 || fingers > 4) return null
  return {
    fingers,
    from: shape.center,
    spread: shape.spread,
    startedAt: at,
    moved: 0,
    spreadChange: 0,
    releasing: false,
    fired: false,
    repeatedAt: null,
  }
}

/** Спокоен ли жест: пальцы стояли на месте и не расходились. */
export function sessionStill(session: FingerSession): boolean {
  // BoardCanvas резервирует последовательность с тремя/четырьмя указателями
  // под историю и не начинает в ней панорамирование. Даём этой зарезервированной
  // последовательности пережить обычный iPadOS jitter, сохраняя строгий порог
  // для двух пальцев (там всё ещё возможны панорама и щипок).
  const reservedMove = session.fingers >= 3 ? TAP_MAX_MOVE_PX * 2 : TAP_MAX_MOVE_PX
  const reservedSpread = session.fingers >= 3 ? TAP_MAX_SPREAD_PX * 2 : TAP_MAX_SPREAD_PX
  return session.moved <= reservedMove && session.spreadChange <= reservedSpread
}

/** Движение пальцев: возвращает жест, если он состоялся именно сейчас. */
export function trackMove(
  session: FingerSession,
  shape: TouchShape,
  at: number,
): FingerAction | null {
  // ⚠️ Пока рука снимается с экрана, её движение к жесту отношения не имеет:
  // центр оставшихся пальцев уезжает сам собой, и без этой отсечки тап тремя
  // пальцами всегда выглядел бы «сдвинутым».
  if (session.releasing) return null
  const dx = shape.center.x - session.from.x
  const dy = shape.center.y - session.from.y
  session.moved = Math.max(session.moved, Math.hypot(dx, dy))
  session.spreadChange = Math.max(session.spreadChange, Math.abs(shape.spread - session.spread))
  if (session.fired) return null
  const action = swipeAction(session.fingers, dx, dy)
  if (!action) return null
  // Срабатываем ОДИН раз за касание: иначе долгий свайп отматывал бы историю
  // до начала доски, пока палец едет.
  session.fired = true
  session.repeatedAt = at
  return action
}

/** Пальцы пошли с экрана. Считать движение с этого мига больше нельзя. */
export function beginRelease(session: FingerSession): void {
  session.releasing = true
}

/**
 * Тик удержания: раз в HOLD_REPEAT_MS, пока пальцы стоят.
 *
 * ⚠️ Двумя пальцами доску ещё и возят, и щиплют. Поэтому удержание
 * отменяется первым же заметным движением или разлётом: подвинул — значит
 * хотел не отмену.
 */
export function trackHold(session: FingerSession, at: number): FingerAction | null {
  if (session.releasing || !sessionStill(session)) return null
  const action = holdAction(session.fingers)
  if (!action) return null
  const since = session.repeatedAt ?? session.startedAt + HOLD_START_MS - HOLD_REPEAT_MS
  if (at - since < HOLD_REPEAT_MS) return null
  if (at - session.startedAt < HOLD_START_MS) return null
  session.fired = true
  session.repeatedAt = at
  return action
}

/** Отпустили пальцы. Тап засчитывается, только если ничего уже не сработало. */
export function endSession(session: FingerSession, at: number): FingerAction | null {
  if (session.fired) return null
  if (!sessionStill(session)) return null
  const tapWindow = session.fingers === 3 ? THREE_FINGER_TAP_MAX_MS : TAP_MAX_MS
  if (at - session.startedAt > tapWindow) return null
  return tapAction(session.fingers)
}
