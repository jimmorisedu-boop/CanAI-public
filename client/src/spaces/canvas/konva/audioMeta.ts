// Звук на холсте: у него нет натуральных размеров, поэтому фигура — плашка
// фиксированной высоты, которая тянется только по ширине (как текст боковыми
// ручками). Здесь всё, что нужно знать о её размерах и подписи, — чистые
// функции, чтобы это можно было проверить без DOM и без Konva.

export const AUDIO_ITEM_WIDTH = 320
export const AUDIO_ITEM_HEIGHT = 76
export const AUDIO_ITEM_MIN_WIDTH = 140

// «0:07», «1:23», «12:05». Часы не показываем: на холсте лежат дорожки к
// клипам, а не подкасты, и лишний ноль только съедает место.
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

// Имя дорожки в подписи. Расширение отрезаем — оно ничего не сообщает, а
// место занимает; безымянный файл получает честное «звук», а не пустоту.
export function audioTitle(name: string | undefined): string {
  const raw = (name ?? '').trim()
  if (!raw) return 'audio'
  const dot = raw.lastIndexOf('.')
  // dot === 0 значит, что имени нет вообще — файл называется одним расширением
  // («.mp3»). Показывать его подписью бессмысленно, честнее общее слово.
  const base = dot > 0 ? raw.slice(0, dot) : dot === 0 ? '' : raw
  return base.trim() || 'audio'
}
