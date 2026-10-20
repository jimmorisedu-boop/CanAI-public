import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameCaptureQueue } from './frameCaptureQueue'
import {
  NO_SELECTION,
  captureOutcome,
  selectedFrameId,
  selectionAfterCapture,
  selectionOf,
} from './frameSelection'

const SRC = { itemId: 'clip', assetId: 'ast_1', src: '/media/a.mp4' }
const instant = async () => ({ itemId: 'item', url: '/media/f.png' })
const never = () => new Promise<never>(() => {})

test('исход съёмки различает «поставили» и «такой уже есть»', () => {
  const queue = new FrameCaptureQueue()
  const first = captureOutcome(queue.enqueue(SRC, 2, never))
  const again = captureOutcome(queue.enqueue(SRC, 2, never))
  assert.equal(first.kind, 'queued')
  assert.equal(again.kind, 'duplicate')
  assert.equal(again.record.id, first.record.id, 'дубль отдаёт ту же запись')
})

test('новый снятый кадр становится выбранным', () => {
  const queue = new FrameCaptureQueue()
  const outcome = captureOutcome(queue.enqueue(SRC, 1, never))
  const selection = selectionAfterCapture(queue, outcome)
  assert.equal(selectedFrameId(selection, queue, queue.getRecords()), outcome.record.id)
})

test('следующий кадр забирает выбор у предыдущего', () => {
  const queue = new FrameCaptureQueue()
  const a = captureOutcome(queue.enqueue(SRC, 1, never))
  const b = captureOutcome(queue.enqueue(SRC, 5, never))
  let selection = selectionAfterCapture(queue, a)
  selection = selectionAfterCapture(queue, b)
  assert.equal(selectedFrameId(selection, queue, queue.getRecords()), b.record.id)
})

test('дубль выбирает уже существующую запись, а не новую', () => {
  const queue = new FrameCaptureQueue()
  const a = captureOutcome(queue.enqueue(SRC, 1, never))
  const b = captureOutcome(queue.enqueue(SRC, 5, never))
  // выбрали второй, потом снова щёлкнули в то же время, что и у первого
  let selection = selectionAfterCapture(queue, b)
  const dup = captureOutcome(queue.enqueue(SRC, 1, never))
  assert.equal(dup.kind, 'duplicate')
  selection = selectionAfterCapture(queue, dup)
  assert.equal(selectedFrameId(selection, queue, queue.getRecords()), a.record.id)
  assert.equal(queue.getRecords().length, 2, 'новых записей дубль не плодит')
})

test('drop выбранного снимает выбор, drop другого его не трогает', () => {
  const queue = new FrameCaptureQueue()
  const a = captureOutcome(queue.enqueue(SRC, 1, never))
  const b = captureOutcome(queue.enqueue(SRC, 5, never))
  const selection = selectionAfterCapture(queue, b)

  queue.drop(a.record.id)
  assert.equal(selectedFrameId(selection, queue, queue.getRecords()), b.record.id, 'чужой drop выбор не снимает')

  queue.drop(b.record.id)
  assert.equal(selectedFrameId(selection, queue, queue.getRecords()), null, 'drop выбранного снимает выбор')
})

test('новая очередь (другой клип) сбрасывает выбор', () => {
  const oldQueue = new FrameCaptureQueue()
  const outcome = captureOutcome(oldQueue.enqueue(SRC, 1, never))
  const selection = selectionAfterCapture(oldQueue, outcome)

  const newQueue = new FrameCaptureQueue()
  // у новой очереди есть свои записи, но выбор прошлого клипа к ним не липнет
  newQueue.enqueue({ itemId: 'other' }, 1, never)
  assert.equal(selectedFrameId(selection, newQueue, newQueue.getRecords()), null)
})

test('ручной выбор: запись, снятие выбора и несуществующий id', async () => {
  const queue = new FrameCaptureQueue()
  const a = captureOutcome(queue.enqueue(SRC, 1, instant))
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(selectedFrameId(NO_SELECTION, queue, queue.getRecords()), null, 'по умолчанию ничего не выбрано')
  assert.equal(selectedFrameId(selectionOf(queue, a.record.id), queue, queue.getRecords()), a.record.id)
  assert.equal(selectedFrameId(selectionOf(queue, null), queue, queue.getRecords()), null, 'select(null) снимает выбор')
  assert.equal(selectedFrameId(selectionOf(queue, 'fc-нет-такого'), queue, queue.getRecords()), null)
})
