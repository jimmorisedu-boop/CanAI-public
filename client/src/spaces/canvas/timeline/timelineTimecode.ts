// Таймкод правки клипа: `00:10.60` — минуты, секунды, сотые. Один формат на
// транспорт, полку кадров и сообщения строки состояния: человек сверяет их
// глазами, и «10.6 с» в одном месте против «0:10.60» в другом заставляли бы
// каждый раз проверять, о том ли моменте речь.

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Секунды → `ММ:СС.сс`.
 *
 * ⚠️ Округляем ОДИН раз, до сотых, и дальше работаем с целыми: раздельное
 * округление секунд и сотых давало «00:59.100» и «00:60.00» на границах.
 * Отрицательное и нечисловое показываем нулём — таймкод не должен ронять
 * вёрстку из-за мусора на входе.
 */
export function timecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const hundredths = Math.round(safe * 100)
  const minutes = Math.floor(hundredths / 6000)
  const rest = hundredths % 6000
  return `${pad(minutes)}:${pad(Math.floor(rest / 100))}.${pad(rest % 100)}`
}
