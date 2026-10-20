import assert from 'node:assert/strict'
import test from 'node:test'
import { BoardBusyError, deliverCanvasJob, freeSpotFor, isCanvasTarget, placedItem } from './canvasDelivery.js'
import { claimBoard, resetBoardPresence, startPresenceWarmup } from './boardPresence.js'
import type { Job } from './jobs.js'

// Серверная доставка — подстраховка на случай «запустил и закрыл». Главное,
// что здесь проверяется: она не лезет к доске, за которой кто-то сидит, и
// ставит результат ровно туда, где стояла заглушка.

const SLOT = { id: 'slot-1', x: 100, y: 200, w: 400, h: 300, prompt: 'кот', modelId: 'nano-banana' }

function job(extra: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'image',
    prompt: 'кот в скафандре',
    refs: [],
    status: 'done',
    createdAt: 0,
    result: { url: '/media/a.png', mime: 'image/png', width: 1024, height: 512 },
    ...extra,
  } as Job
}

test('картинка встаёт на место заглушки и держит нижнюю кромку', () => {
  // Низ ряда обязан сохраниться: иначе результат прыгнет относительно соседей,
  // которые уже стоят в этом ряду.
  const item = placedItem(job(), SLOT, { width: 1024, height: 512 })
  assert.equal(item.kind, 'image')
  assert.equal(item.x, 100)
  assert.equal(item.w, 400)
  assert.equal(item.h, 200)
  assert.equal(item.y, 300)
  assert.equal(Number(item.y) + Number(item.h), SLOT.y + SLOT.h)
})

test('без измеренного размера остаются размеры заглушки', () => {
  // Пропорции заглушки посчитаны по той же модели, что и результат, — промах
  // будет небольшим, зато объект окажется на доске.
  const item = placedItem(job({ result: { url: '/media/a.mp4', mime: 'video/mp4' } }), SLOT, null)
  assert.equal(item.kind, 'video')
  assert.equal(item.w, 400)
  assert.equal(item.h, 300)
  assert.equal(item.naturalWidth, undefined)
})

test('звук становится плашкой по нижней кромке', () => {
  const item = placedItem(job({ result: { url: '/media/a.mp3', mime: 'audio/mpeg' } }), SLOT, null)
  assert.equal(item.kind, 'audio')
  assert.equal(item.w, 320)
  assert.equal(item.h, 96)
  assert.equal(item.y, SLOT.y + SLOT.h - 96)
})

test('у поставленного объекта есть id задачи — по нему видно, что он уже доставлен', () => {
  const item = placedItem(job(), SLOT, { width: 100, height: 100 })
  assert.equal(item.sourceJobId, 'job-1')
  assert.equal(item.modelId, 'nano-banana')
  assert.equal(item.prompt, 'кот')
})

test('занятую доску сервер не трогает', async () => {
  // Главное правило модуля: пока за доской кто-то сидит, результат ставит он.
  // Иначе два писателя дадут либо дубль, либо конфликтную копию.
  resetBoardPresence()
  claimBoard('доска', 'ipad-1', 'iPad')
  await assert.rejects(
    () => deliverCanvasJob(job(), { kind: 'canvas', projectId: 'доска', placeholderId: 'slot-1' }),
    BoardBusyError,
  )
  resetBoardPresence()
})

test('незавершённую или пустую задачу доставлять нечего', async () => {
  resetBoardPresence()
  const target = { kind: 'canvas' as const, projectId: 'доска', placeholderId: 'slot-1' }
  assert.equal(await deliverCanvasJob(job({ status: 'running' }), target), false)
  assert.equal(await deliverCanvasJob(job({ result: undefined }), target), false)
})

test('цель доски отличается от целей чата', () => {
  assert.equal(isCanvasTarget({ kind: 'canvas', projectId: 'p', placeholderId: 's' }), true)
  assert.equal(isCanvasTarget(undefined), false)
})

test('без заглушки результат всё равно ложится на доску', () => {
  // Оплаченное терять нельзя. Заглушки может не быть, если страницу закрыли
  // раньше, чем автосейв успел её записать (поймано живым прогоном: макрос
  // доработал, а встать было некуда).
  const spot = freeSpotFor(
    [{ x: 0, y: 100, w: 400, h: 300 }, { x: 500, y: 40, w: 200, h: 200 }],
    { width: 1000, height: 500 },
  )
  assert.equal(spot.x, 760)
  assert.equal(spot.y, 40)
  assert.equal(spot.w, 440)
  assert.equal(spot.h, 220)
})

test('на пустой доске место находится в начале координат', () => {
  const spot = freeSpotFor([], null)
  assert.equal(spot.x, 0)
  assert.equal(spot.y, 0)
})

test('после перезапуска сервер не ставит результат, пока вкладки не отметились', async () => {
  resetBoardPresence()
  startPresenceWarmup()
  await assert.rejects(
    () => deliverCanvasJob(job(), { kind: 'canvas', projectId: 'доска', placeholderId: 'slot-1' }),
    (error: unknown) => error instanceof BoardBusyError && /server just started/.test(error.message),
  )
  resetBoardPresence()
})
