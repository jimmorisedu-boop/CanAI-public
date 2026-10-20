// Масштаб ИНТЕРФЕЙСА планшета — щипок по панелям.
//
// ⚠️ Это не зум страницы. Safari умеет приближать её щипком, но уменьшить
// МЕНЬШЕ ста процентов не даёт: страница уже вписана в ширину экрана, и
// уменьшать ей некуда. Со стороны это выглядит так, будто интерфейс только
// растёт и не сжимается (жалоба 09.09.2026: «когда делается щипок на
// интерфейсе, интерфейс не только увеличивался, но и уменьшался»). Поэтому
// масштаб свой: щипок по панелям меняет размер САМИХ панелей, а зум Safari на
// них глушится.
//
// ⚠️ Доска в этом не участвует: у неё свой щипок и свои мировые координаты.
// Смысл ровно в том, чтобы ужать панели и отдать освободившееся место доске.

/**
 * ⚠️ Ниже единицы цели пальца становятся меньше сорока четырёх точек — того
 * порога, ниже которого по всему планшетному интерфейсу опускаться нельзя. Это
 * единственное исключение, и оно осознанное: уменьшает человек САМ и ради
 * места на доске. Дальше 0.5 (то есть 22px на цель) не пускаем — это уже
 * заметное уменьшение, а ещё ниже промахи начинаются слишком часто.
 */
export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 1.4
export const UI_SCALE_DEFAULT = 1
/** Ключ в хранилище браузера: масштаб — свойство ЭТОГО устройства, не доски. */
export const UI_SCALE_KEY = 'canai-tablet-ui-scale'
/** Щипок короче этого не считаем: пальцы дрожат, а масштаб дёргаться не должен. */
export const UI_SCALE_MIN_SPREAD_PX = 24

export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_DEFAULT
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value))
}

/**
 * Новый масштаб по ходу щипка: во сколько раз развели пальцы, во столько же
 * меняется интерфейс. Считаем от масштаба НА НАЧАЛО жеста, а не от текущего, —
 * иначе изменения перемножались бы каждый кадр и рука улетала бы в упор.
 */
export function pinchedUiScale(base: number, startSpread: number, spread: number): number {
  if (!(startSpread >= UI_SCALE_MIN_SPREAD_PX) || !(spread > 0)) return clampUiScale(base)
  return clampUiScale(base * (spread / startSpread))
}

/** Округление до сотых: в стиль уходит короткое число, а не хвост из мантиссы. */
export function roundUiScale(value: number): number {
  return Math.round(clampUiScale(value) * 100) / 100
}

interface ScaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * ⚠️ Хранилище может бросить исключение (приватный режим, запрет на данные
 * сайта), и падать из-за размера интерфейса нельзя: тогда не откроется вообще
 * ничего. Не прочиталось — возвращаем переданный запасной масштаб (обычно
 * обычный единичный).
 */
export function readUiScale(
  storage: ScaleStorage | null | undefined,
  fallback = UI_SCALE_DEFAULT,
): number {
  const safeFallback = clampUiScale(fallback)
  // Optional storage is deliberately supported for private browsing and test
  // shells. Callers that keep a volatile value can still retain it here.
  if (!storage) return safeFallback
  try {
    const raw = storage.getItem(UI_SCALE_KEY)
    return raw === null || raw === undefined ? UI_SCALE_DEFAULT : clampUiScale(Number(raw))
  } catch {
    return safeFallback
  }
}

export function writeUiScale(storage: ScaleStorage | null | undefined, value: number): void {
  try {
    storage?.setItem(UI_SCALE_KEY, String(roundUiScale(value)))
  } catch {
    // Не сохранилось — масштаб просто не переживёт перезагрузку.
  }
}

/**
 * Щипок принадлежит интерфейсу, только если ВСЕ пальцы легли мимо доски.
 *
 * ⚠️ Один палец на доске означает щипок доски: там свой масштаб, и отбирать
 * его нельзя. Полноэкранные режимы (обрезка, сравнение, правка клипа) тоже
 * считаем своей территорией — они рисуют материал, а не панели.
 */
export interface PinchTarget {
  closest(selector: string): unknown
}

export function pinchTargetsChrome(targets: ReadonlyArray<PinchTarget | null | undefined>): boolean {
  if (targets.length < 2) return false
  return targets.every((target) => (
    typeof target?.closest === 'function'
    && !target.closest('.tablet-board')
    && !target.closest('.tablet-full')
    // Жесты выделения и редактирования принадлежат Safari, а не масштабу
    // панели. Это относится и к readOnly-полю, в котором читают промпт.
    && !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
  ))
}
