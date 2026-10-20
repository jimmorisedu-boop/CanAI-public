import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameCaptureQueue, type CaptureRunContext } from './frameCaptureQueue'

const SRC = { itemId: 'item-1', assetId: 'ast_9', src: '/media/a.mp4' }

function deferred() {
  let resolve!: (v: { itemId?: string; url?: string }) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<{ itemId?: string; url?: string }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('queue: кадр идёт по фазам до saved', async () => {
  const q = new FrameCaptureQueue()
  const phases: string[] = []
  const d = deferred()
  const work = async (ctx: CaptureRunContext) => {
    ctx.emitPhase('seeking')
    ctx.emitPhase('encoding')
    ctx.emitPhase('uploading')
    await d.promise
    return { itemId: 'new-item', url: '/media/f.png' }
  }
  const sub: string[] = []
  // подписка ДО enqueue, чтобы увидеть фазы, посланные внутри первого тика
  q.subscribe((r) => sub.push(r[0]?.phase ?? 'empty'))
  const { duplicate } = q.enqueue(SRC, 3.25, work)
  assert.equal(duplicate, false)
  d.resolve({ itemId: 'new-item', url: '/media/f.png' })
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.getRecords()[0]
  assert.equal(rec.phase, 'saved')
  assert.equal(rec.resultItemId, 'new-item')
  // очередь сообщала о фазах в правильном порядке
  assert.ok(sub.includes('queued'))
  assert.ok(sub.includes('seeking'))
  assert.ok(sub.includes('uploading'))
  assert.equal(sub[sub.length - 1], 'saved')
})

test('collect: два одинаковых запроса — один кадр (дубль)', async () => {
  const q = new FrameCaptureQueue()
  let count = 0
  const d = deferred()
  const work = async () => { count += 1; await d.promise; return { itemId: 'x' } }
  const first = q.enqueue(SRC, 5, work)
  const second = q.enqueue(SRC, 5, work)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(count, 1, 'работа выполнилась один раз')
  d.resolve({ itemId: 'x' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords().length, 1)
})

test('соседние времена не склеиваются в один кадр', async () => {
  const q = new FrameCaptureQueue()
  const d1 = deferred(); const d2 = deferred()
  const w1 = async () => { await d1.promise; return { itemId: 'a' } }
  const w2 = async () => { await d2.promise; return { itemId: 'b' } }
  q.enqueue(SRC, 1.0123, w1)
  q.enqueue(SRC, 1.0124, w2)
  assert.equal(q.getRecords().length, 2)
  d1.resolve({ itemId: 'a' }); d2.resolve({ itemId: 'b' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords().length, 2)
  assert.equal(q.getRecords()[0].resultItemId, 'a')
  assert.equal(q.getRecords()[1].resultItemId, 'b')
})

test('ошибка помечает запись error и не ломает очередь', async () => {
  const q = new FrameCaptureQueue()
  const work = async () => { throw new Error('сеть упала') }
  q.enqueue(SRC, 1, work)
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.getRecords()[0]
  assert.equal(rec.phase, 'error')
  assert.equal(rec.error, 'сеть упала')
})

test('отмена до ack уводит в cancelled и не создаёт результат', async () => {
  const q = new FrameCaptureQueue()
  const d = deferred()
  const work = async () => { await d.promise; return { itemId: 'y' } }
  const { record } = q.enqueue(SRC, 7, work)
  q.cancel(record.id)
  assert.equal(q.getRecords()[0].phase, 'cancelled')
  d.resolve({ itemId: 'y' })
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.getRecords()[0]
  assert.equal(rec.phase, 'cancelled')
  assert.equal(rec.resultItemId, undefined)
})

test('retry после error создаёт новую попытку того же ключа без дубля', async () => {
  const q = new FrameCaptureQueue()
  const d = deferred()
  let attempts = 0
  const work = async (ctx: CaptureRunContext) => {
    attempts += 1
    if (attempts === 1) throw new Error('первая попытка')
    await d.promise
    return { itemId: 'z' }
  }
  const first = q.enqueue(SRC, 9, work)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords()[0].phase, 'error')
  // Повторный enqueue того же ключа при наличии error-записи даёт новую запись
  const second = q.enqueue(SRC, 9, work)
  assert.equal(second.duplicate, false)
  assert.equal(second.record.phase, 'queued')
  d.resolve({ itemId: 'z' })
  await new Promise((r) => setTimeout(r, 10))
  const saved = q.getRecords().filter((r) => r.phase === 'saved')
  assert.equal(saved.length, 1)
  assert.ok(attempts >= 2)
})

test('замороженное время: ctx.frozenTime — то, что было на клике, а не живое после await', async () => {
  const q = new FrameCaptureQueue()
  // Эмуляция живого currentTime: «палец съехал» к 99, пока работала очередь —
  // но запись и контекст обязаны держать момент клика (3.25).
  let liveTime = 3.25
  const seenTime: number[] = []
  const d = deferred()
  const work = async (ctx: CaptureRunContext) => {
    liveTime = 99 // «видео доиграло до другого места, пока кадр снимался»
    seenTime.push(ctx.frozenTime)
    await d.promise
    return { itemId: 'frozen' }
  }
  q.enqueue(SRC, 3.25, work)
  void liveTime
  d.resolve({ itemId: 'frozen' })
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.getRecords()[0]
  assert.equal(rec.requestedTime, 3.25, 'в записи замороженное время клика')
  assert.deepEqual(seenTime, [3.25], 'работа видит замороженное время, а не liveTime=99')
  assert.equal(rec.phase, 'saved')
})

test('отмена во время encoding/upload уводит в cancelled, результат не появляется', async () => {
  const q = new FrameCaptureQueue()
  const d = deferred()
  const work = async (ctx: CaptureRunContext) => {
    ctx.emitPhase('seeking')
    ctx.emitPhase('encoding')
    ctx.emitPhase('uploading')
    await d.promise
    return { itemId: 'late' }
  }
  const { record } = q.enqueue(SRC, 4, work)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords()[0].phase, 'uploading', 'дошла до upload-фазы')
  q.cancel(record.id)
  assert.equal(q.getRecords()[0].phase, 'cancelled', 'отмена сразу видна')
  d.resolve({ itemId: 'late' })
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.getRecords()[0]
  assert.equal(rec.phase, 'cancelled', 'поздний результат не перетирает отмену')
  assert.equal(rec.resultItemId, undefined)
})

test('после saved повторный retry запрещён', async () => {
  const q = new FrameCaptureQueue()
  const d = deferred()
  const work = async () => { await d.promise; return { itemId: 'saved-1' } }
  const { record } = q.enqueue(SRC, 1, work)
  d.resolve({ itemId: 'saved-1' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords()[0].phase, 'saved')
  q.retry(record.id, work)
  assert.equal(q.getRecords()[0].phase, 'saved', 'retry после saved запрещён')
})

test('unsubscribe: после снятия подписки изменения не приходят, но очередь живёт', async () => {
  const q = new FrameCaptureQueue()
  let calls = 0
  const unsubscribe = q.subscribe(() => { calls += 1 })
  unsubscribe()
  const before = calls
  const d = deferred()
  const work = async () => { await d.promise; return { itemId: 'u' } }
  q.enqueue(SRC, 4, work)
  d.resolve({ itemId: 'u' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, before, 'после unsubscribe подписчика не звали')
  assert.equal(q.getRecords()[0].phase, 'saved', 'но очередь сама выполнил работу')
})

test('collect + drop: день готовой записи и снятие подписки не роняют подписчиков', async () => {
  const q = new FrameCaptureQueue()
  const d = deferred()
  const work = async () => { await d.promise; return { itemId: 'drop-me' } }
  const { record } = q.enqueue(SRC, 2, work)
  d.resolve({ itemId: 'drop-me' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords().length, 1)
  q.drop(record.id)
  assert.equal(q.getRecords().length, 0, 'drop убирает запись с полки')
  // очередь после drop жива: новый кадр снимается
  const d2 = deferred()
  const work2 = async () => { await d2.promise; return { itemId: 'after' } }
  const { record: second } = q.enqueue(SRC, 2.5, work2)
  d2.resolve({ itemId: 'after' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(q.getRecords().length, 1)
  assert.equal(q.getRecords()[0].phase, 'saved')
  assert.equal(q.getRecords()[0].id, second.id)
})
// Отменённый кадр обязан уметь повториться, и поздние вести ПРЕЖНЕЙ попытки не
// имеют права портить новую: отмена не останавливает декодер на лету, он
// доживает свой await и ещё может сообщить фазу или результат.

test('отмена → повтор: опоздавшая прежняя попытка не затирает новую', async () => {
  const q = new FrameCaptureQueue()
  const first = deferred()
  const second = deferred()
  let firstCtx!: CaptureRunContext
  const firstWork = async (ctx: CaptureRunContext) => {
    firstCtx = ctx
    ctx.emitPhase('uploading')
    return first.promise
  }
  const secondWork = async (ctx: CaptureRunContext) => {
    ctx.emitPhase('seeking')
    return second.promise
  }

  const { record } = q.enqueue(SRC, 12, firstWork)
  await new Promise((r) => setTimeout(r, 5))
  q.cancel(record.id)
  assert.equal(q.getRecords()[0].phase, 'cancelled')

  q.retry(record.id, secondWork)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(q.getRecords()[0].phase, 'seeking', 'новая попытка идёт')

  // прежняя попытка докатывается: сообщает фазу и заканчивается
  firstCtx.emitPhase('encoding')
  assert.equal(q.getRecords()[0].phase, 'seeking', 'чужая фаза не перебивает новую попытку')
  first.resolve({ itemId: 'stale', url: '/media/stale.png' })
  await new Promise((r) => setTimeout(r, 5))
  const mid = q.getRecords()[0]
  assert.equal(mid.phase, 'seeking', 'конец прежней попытки не возвращает «отменён»')
  assert.equal(mid.resultItemId, undefined, 'и не приносит чужой результат')

  second.resolve({ itemId: 'fresh', url: '/media/fresh.png' })
  await new Promise((r) => setTimeout(r, 5))
  const done = q.getRecords()[0]
  assert.equal(done.phase, 'saved')
  assert.equal(done.resultItemId, 'fresh')
  assert.equal(done.resultUrl, '/media/fresh.png')
  assert.equal(q.getRecords().length, 1, 'повтор не плодит записей')
})

test('повтор после отмены можно снова отменить: опоздавший конец прежней попытки не снимает запуск', async () => {
  const q = new FrameCaptureQueue()
  const first = deferred()
  const second = deferred()
  const { record } = q.enqueue(SRC, 4, async () => first.promise)
  q.cancel(record.id)
  let secondAborted = false
  q.retry(record.id, async (ctx) => {
    ctx.signal.addEventListener('abort', () => { secondAborted = true })
    return second.promise
  })

  first.resolve({ itemId: 'stale' })
  await new Promise((r) => setTimeout(r, 5))
  // если бы конец прежней попытки забыл про новую, отменить её было бы нечем
  q.cancel(record.id)
  assert.equal(secondAborted, true, 'новая попытка получила сигнал отмены')
  assert.equal(q.getRecords()[0].phase, 'cancelled')
  second.resolve({ itemId: 'late' })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(q.getRecords()[0].phase, 'cancelled')
  assert.equal(q.getRecords()[0].resultItemId, undefined)
})

test('отмена → повтор → успех: запись снова saved и не дублируется', async () => {
  const q = new FrameCaptureQueue()
  const never = deferred()
  const { record } = q.enqueue(SRC, 6, async () => never.promise)
  q.cancel(record.id)
  q.retry(record.id, async () => ({ itemId: 'ok', url: '/media/ok.png' }))
  await new Promise((r) => setTimeout(r, 5))
  const records = q.getRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].phase, 'saved')
  assert.equal(records[0].requestedTime, 6, 'время запроса прежнее')
  assert.equal(records[0].id, record.id, 'тот же ключ записи')
})
