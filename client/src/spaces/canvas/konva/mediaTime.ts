/**
 * Время плеера на холсте «м:сс.сс» — одно на видео и GIF.
 *
 * ⚠️ Сотые считаем от ЦЕЛОГО числа миллисекунд: в дробях `1.2 % 1` даёт
 * 0.19999…, и GIF длиной 1,2 с показывался как «0:01.19» (поймано живой
 * проверкой плеера GIF 22.09.2026). Отбрасываем, а не округляем: время на
 * плашке не должно забегать вперёд кадра, который виден.
 */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00'
  const hundredthsTotal = Math.floor(Math.round(Math.max(0, seconds) * 1000) / 10)
  const mins = Math.floor(hundredthsTotal / 6000)
  const secs = Math.floor(hundredthsTotal / 100) % 60
  const hundredths = hundredthsTotal % 100
  return `${mins}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}
