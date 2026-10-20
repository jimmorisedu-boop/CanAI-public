import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getTimelinePresentation,
  getTimelineTarget,
  onTimelinePresentation,
  setTimelinePresentation,
  setTimelineTarget,
  timelineBlocksCanvas,
} from './timelineBus'

// Шина — состояние модуля, поэтому каждый тест возвращает её в исходное.
function reset(): void {
  setTimelineTarget(null)
  setTimelinePresentation('overlay')
}

// Хоткеи холста, плеер видео и перемотка звука спрашивают у шины одно:
// «режим держит клавиатуру?». Пока в презентации «холст» человек разглядывает
// снятый кадр на доске, ответ обязан быть «нет», хотя цель в шине ещё есть.

test('холст свободен, когда режима нет', () => {
  reset()
  assert.equal(getTimelineTarget(), null)
  assert.equal(timelineBlocksCanvas(), false)
})

test('в оверлее режим держит холст', () => {
  reset()
  setTimelineTarget('clip')
  assert.equal(timelineBlocksCanvas(), true)
  reset()
})

test('в презентации «холст» цель жива, а холст свободен', () => {
  reset()
  setTimelineTarget('clip')
  setTimelinePresentation('canvas')
  assert.equal(getTimelineTarget(), 'clip', 'сеанс не закрыт')
  assert.equal(timelineBlocksCanvas(), false, 'хоткеи холста работают')
  setTimelinePresentation('overlay')
  assert.equal(timelineBlocksCanvas(), true, 'вернули оверлей — холст снова занят')
  reset()
})

test('презентация без цели холст не держит', () => {
  reset()
  setTimelinePresentation('canvas')
  assert.equal(timelineBlocksCanvas(), false)
  reset()
})

test('закрытие режима возвращает презентацию и СООБЩАЕТ об этом подписчикам', () => {
  reset()
  const seen: string[] = []
  const off = onTimelinePresentation((value) => seen.push(value))
  setTimelineTarget('clip')
  setTimelinePresentation('canvas')
  setTimelineTarget(null)
  off()
  assert.equal(getTimelinePresentation(), 'overlay')
  // прежний код сбрасывал значение молча: холст оставался «на виду» под
  // следующим клипом, потому что подписчик так и не узнал о возврате
  assert.deepEqual(seen, ['canvas', 'overlay'])
  reset()
})

test('закрытие режима в оверлее лишних вестей не шлёт', () => {
  reset()
  const seen: string[] = []
  const off = onTimelinePresentation((value) => seen.push(value))
  setTimelineTarget('clip')
  setTimelineTarget(null)
  off()
  assert.deepEqual(seen, [])
})
