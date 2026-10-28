import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePhase, FrameCaptureRecord } from './frameCaptureQueue'
import {
  frameStatusText,
  frameStatusTone,
  frameTransitionNotice,
  framesByTime,
  NO_FRAMES_MESSAGE,
  pickFrameTarget,
  STATUS_IDLE,
  statusLine,
} from './timelineStatus'

function record(over: Partial<FrameCaptureRecord> & { id: string }): FrameCaptureRecord {
  return {
    source: { itemId: 'clip' },
    requestedTime: 1,
    phase: 'saved',
    createdAt: 1,
    dedupKey: over.id,
    ...over,
  }
}

test('в покое строка говорит «Готово»', () => {
  assert.deepEqual(statusLine({ notice: null, records: [] }), { text: STATUS_IDLE, tone: 'idle' })
})

test('свежее сообщение перекрывает всё остальное и несёт тон и действие', () => {
  const run = () => {}
  const line = statusLine({
    notice: { kind: 'success', message: 'Звук отделён', action: { label: 'Отменить', run } },
    records: [record({ id: 'a', phase: 'uploading' })],
  })
  assert.equal(line.text, 'Звук отделён')
  assert.equal(line.tone, 'good')
  assert.equal(line.action?.label, 'Отменить')
  assert.equal(statusLine({ notice: { kind: 'error', message: 'x' }, records: [] }).tone, 'error')
  assert.equal(statusLine({ notice: { kind: 'info', tone: 'warn', message: 'x' }, records: [] }).tone, 'warn')
})

test('пока кадр в пути, строка не возвращается к «Готово»', () => {
  const one = statusLine({ notice: null, records: [record({ id: 'a', phase: 'encoding', requestedTime: 5.2 })] })
  assert.equal(one.text, 'Frame 00:05.20 — saving…')
  const two = statusLine({
    notice: null,
    records: [record({ id: 'a', phase: 'queued' }), record({ id: 'b', phase: 'seeking' }), record({ id: 'c' })],
  })
  assert.equal(two.text, 'Saving frames: 2…')
})

test('an upstream timeline error is English without rewriting the notice or its action', () => {
  const run = () => {}
  const notice = { kind: 'error' as const, message: 'Сервер недоступен', action: { label: 'Retry', run } }
  const line = statusLine({ notice, records: [] })
  assert.equal(line.text, 'The server is unavailable.')
  assert.equal(line.tone, 'error')
  assert.equal(line.action, notice.action)
  assert.equal(notice.message, 'Сервер недоступен')
})

test('итог снятия говорится словами: на холсте / не сохранился / отменён', () => {
  const saved = frameTransitionNotice('uploading', record({ id: 'a', requestedTime: 5.2 }))
  assert.equal(saved?.message, 'Frame 00:05.20 — on canvas')
  assert.equal(saved?.kind, 'success')
  const failed = frameTransitionNotice('seeking', record({ id: 'a', phase: 'error', error: 'нет связи', requestedTime: 5.2 }))
  assert.equal(failed?.message, 'Frame 00:05.20 — was not saved: Connection lost.')
  assert.equal(failed?.kind, 'error')
  assert.equal(frameTransitionNotice('queued', record({ id: 'a', phase: 'cancelled' }))?.message, 'Frame 00:01.00 — canceled')
  // фаза не менялась или кадр просто двинулся дальше по очереди — молчим
  assert.equal(frameTransitionNotice('saved', record({ id: 'a' })), null)
  assert.equal(frameTransitionNotice('queued', record({ id: 'a', phase: 'seeking' })), null)
})

test('G и D берут выбранный кадр, а без выбора — последний снятый сохранённый', () => {
  const records = [
    record({ id: 'early', requestedTime: 2, createdAt: 30, resultItemId: 'i1', resultUrl: '/u1' }),
    record({ id: 'late', requestedTime: 9, createdAt: 10, resultItemId: 'i2', resultUrl: '/u2' }),
  ]
  const noSelection = pickFrameTarget(records, null, 'show')
  assert.ok(noSelection.ok)
  // последний по ВРЕМЕНИ СНЯТИЯ, а не по положению в клипе
  assert.equal(noSelection.ok && noSelection.record.id, 'early')
  const selected = pickFrameTarget(records, 'late', 'download')
  assert.ok(selected.ok)
  assert.equal(selected.ok && selected.record.id, 'late')
  // выбранного уже нет (убрали с полки) — откат на последний сохранённый
  const orphan = pickFrameTarget(records, 'gone', 'show')
  assert.equal(orphan.ok && orphan.record.id, 'early')
})

test('на неготовом кадре клавиши ничего не делают, но объясняют почему', () => {
  const busy = [record({ id: 'a', phase: 'uploading', requestedTime: 3 })]
  const wait = pickFrameTarget(busy, 'a', 'show')
  assert.equal(wait.ok, false)
  assert.match(!wait.ok ? wait.notice.message : '', /still saving/u)

  const broken = pickFrameTarget([record({ id: 'a', phase: 'error', error: 'x' })], 'a', 'download')
  assert.equal(broken.ok, false)
  assert.equal(!broken.ok && broken.notice.kind, 'error')

  const noFile = pickFrameTarget([record({ id: 'a', resultItemId: 'i' })], 'a', 'download')
  assert.equal(noFile.ok, false)
  assert.match(!noFile.ok ? noFile.notice.message : '', /no file to download/u)

  const notOnBoard = pickFrameTarget([record({ id: 'a', resultUrl: '/u' })], 'a', 'show')
  assert.equal(notOnBoard.ok, false)

  const none = pickFrameTarget([], null, 'show')
  assert.equal(!none.ok && none.notice.message, 'No frames yet — press S')
  assert.equal(NO_FRAMES_MESSAGE, 'No frames yet — press S')
})

test('подписи карточки: сохраняю / сохранено / ошибка с причиной / отменён', () => {
  const phases: Array<[CapturePhase, string, string]> = [
    ['queued', 'Saving…', 'busy'],
    ['uploading', 'Saving…', 'busy'],
    ['saved', 'Saved', 'saved'],
    ['cancelled', 'Canceled', 'cancelled'],
    ['error', 'Error', 'error'],
  ]
  for (const [phase, text, tone] of phases) {
    const item = record({ id: phase, phase })
    assert.equal(frameStatusText(item), text)
    assert.equal(frameStatusTone(item), tone)
  }
  assert.equal(frameStatusText(record({ id: 'e', phase: 'error', error: 'нет связи' })), 'Error: Connection lost.')
})

test('кадры на полке идут в порядке клипа', () => {
  const sorted = framesByTime([
    record({ id: 'b', requestedTime: 9 }),
    record({ id: 'a', requestedTime: 2 }),
    record({ id: 'c', requestedTime: 2, createdAt: 5 }),
  ])
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'c', 'b'])
})
