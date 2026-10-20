// Порядок объектов «как читают»: сверху вниз, внутри ряда — слева направо.
//
// ⚠️ Зачем это вообще. Рамка выделения набирала объекты в порядке их появления
// в холсте (порядок создания), а человек смотрит на экран и ждёт, что первым
// будет левый. Номера референсов @1/@2 в промпте берутся ровно из этого
// порядка, поэтому «поменялись местами» — не косметика: промпт вида «перенеси
// с изображения 1 на изображение 2» получает объекты наоборот и даёт обратный
// результат за те же деньги (жалоба 27.08.2026).
//
// Осознанное исключение: выбор поштучно (клик, Shift+клик) порядок НЕ меняет —
// там человек назначил его сам, и переставлять за ним нельзя.

export interface OrderedBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** Ряды разбираются жадно: объект остаётся в текущем ряду, пока его середина
 *  по вертикали не ушла дальше половины меньшей высоты — так ряд не рассыпается
 *  от небольшой разницы в размерах, но следующая строка начинается честно. */
export function readingOrder<T extends OrderedBox>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const rows: T[][] = []
  let rowCenter = 0
  let rowHeight = 0

  for (const item of sorted) {
    const center = item.y + item.h / 2
    const row = rows[rows.length - 1]
    const sameRow = row !== undefined
      && Math.abs(center - rowCenter) <= Math.min(item.h, rowHeight) / 2
    if (sameRow) {
      row.push(item)
      // середина ряда — среднее по его объектам: так один высокий сосед не
      // утаскивает ряд за собой
      rowCenter = row.reduce((sum, entry) => sum + entry.y + entry.h / 2, 0) / row.length
      rowHeight = Math.max(rowHeight, item.h)
    } else {
      rows.push([item])
      rowCenter = center
      rowHeight = item.h
    }
  }

  return rows.flatMap((row) => [...row].sort((a, b) => (a.x - b.x) || (a.y - b.y)))
}
