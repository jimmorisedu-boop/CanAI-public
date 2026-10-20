import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundedImageLoadScheduler, loadImageWithRetry } from './media.js'

test('планировщик облачных картинок не запускает больше N запросов одновременно', () => {
  const scheduler = new BoundedImageLoadScheduler(2)
  let active = 0
  let peak = 0
  const finishers: Array<() => void> = []
  const stops = Array.from({ length: 5 }, () => scheduler.schedule((complete, registerCancel) => {
    active += 1
    peak = Math.max(peak, active)
    const finish = () => {
      active -= 1
      complete()
    }
    finishers.push(finish)
    registerCancel(finish)
  }))

  assert.equal(scheduler.activeCount, 2)
  assert.equal(scheduler.queuedCount, 3)
  assert.equal(peak, 2)

  finishers.shift()?.()
  finishers.shift()?.()
  finishers.shift()?.()
  finishers.shift()?.()
  finishers.shift()?.()
  assert.equal(active, 0)
  assert.equal(scheduler.activeCount, 0)
  assert.equal(scheduler.queuedCount, 0)
  for (const stop of stops) stop()
})

test('отмена queued-запроса не занимает слот и не стартует после освобождения', () => {
  const scheduler = new BoundedImageLoadScheduler(1)
  let started = 0
  let releaseFirst: (() => void) | undefined
  scheduler.schedule((complete, registerCancel) => {
    started += 1
    releaseFirst = complete
    registerCancel(complete)
  })
  const stopQueued = scheduler.schedule(() => { started += 1 })

  assert.equal(started, 1)
  assert.equal(scheduler.queuedCount, 1)
  stopQueued()
  assert.equal(scheduler.queuedCount, 0)
  releaseFirst?.()
  assert.equal(started, 1)
  assert.equal(scheduler.activeCount, 0)
})

test('изображение доски восстанавливается после краткого обрыва сервера без перемонтирования', async () => {
  const primary = '/api/cloud-assets/preview/ast_recovery?w=512'
  const fallback = '/api/cloud-assets/assets/ast_recovery'
  const requested: string[] = []
  const originalImage = globalThis.Image
  let stop: (() => void) | undefined
  let loaded = false

  class FakeImage {
    crossOrigin = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(value: string) {
      requested.push(value)
      queueMicrotask(() => {
        if (requested.length < 3) this.onerror?.()
        else this.onload?.()
      })
    }
  }

  try {
    globalThis.Image = FakeImage as unknown as typeof Image
    stop = loadImageWithRetry(primary, fallback, () => { loaded = true }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assert.equal(loaded, true)
    assert.deepEqual(requested, [primary, fallback, primary])
  } finally {
    stop?.()
    globalThis.Image = originalImage
  }
})

test('после ухода объекта с экрана отложенная повторная загрузка отменяется', async () => {
  const requested: string[] = []
  const originalImage = globalThis.Image

  class FakeImage {
    crossOrigin = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(value: string) {
      requested.push(value)
      queueMicrotask(() => this.onerror?.())
    }
  }

  try {
    globalThis.Image = FakeImage as unknown as typeof Image
    const stop = loadImageWithRetry('/api/cloud-assets/assets/ast_gone', undefined, () => {}, () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.deepEqual(requested, ['/api/cloud-assets/assets/ast_gone'])
  } finally {
    globalThis.Image = originalImage
  }
})

test('загруженное изображение отдаётся из кэша без второго запроса', async () => {
  const src = '/api/cloud-assets/preview/ast_cache?w=256'
  const requested: string[] = []
  const originalImage = globalThis.Image
  let loaded = 0

  class FakeImage {
    crossOrigin = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(value: string) {
      requested.push(value)
      queueMicrotask(() => this.onload?.())
    }
  }

  try {
    globalThis.Image = FakeImage as unknown as typeof Image
    const stopFirst = loadImageWithRetry(src, undefined, () => { loaded += 1 }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    stopFirst()
    const stopSecond = loadImageWithRetry(src, undefined, () => { loaded += 1 }, () => {})
    stopSecond()
    assert.deepEqual(requested, [src])
    assert.equal(loaded, 2)
  } finally {
    globalThis.Image = originalImage
  }
})

/**
 * ⚠️ Картинки сетевой доски грузились в порядке появления объектов на доске:
 * человек смотрел в центр, а загружались края и то, что за кадром (пункт 3.5,
 * находка Ф-5). Очередь берёт следующей ближайшую к центру кадра — и считает
 * это в момент выбора: камера за время очереди могла уехать.
 */
test('очередь картинок берёт следующей ближайшую к центру кадра', () => {
  const scheduler = new BoundedImageLoadScheduler(1)
  const order: string[] = []
  const finishers: Array<() => void> = []
  let focus = { x: 0, y: 0 }
  const task = (name: string, x: number) => scheduler.schedule((complete) => {
    order.push(name)
    finishers.push(complete)
  }, () => (x - focus.x) ** 2)
  task('first', 5000)
  task('far', 900)
  task('near', 10)
  task('middle', 300)
  finishers.shift()!()
  assert.deepEqual(order, ['first', 'near'])
  // Камера уехала вправо — теперь ближе дальняя.
  focus = { x: 1000, y: 0 }
  finishers.shift()!()
  assert.deepEqual(order, ['first', 'near', 'far'])
  // Задача интерфейса (без точки на доске) идёт вне очереди холста.
  scheduler.schedule((complete) => { order.push('ui'); finishers.push(complete) })
  finishers.shift()!()
  assert.deepEqual(order, ['first', 'near', 'far', 'ui'])
  finishers.shift()!()
  finishers.shift()!()
  assert.deepEqual(order, ['first', 'near', 'far', 'ui', 'middle'])
})

test('СТОРОЖ: фигуры сообщают свой центр, холст — центр кадра и шлёт прогрев', async () => {
  const { readFile } = await import('node:fs/promises')
  const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')
  for (const name of ['ImageItem.tsx', 'GifItem.tsx']) {
    assert.match(await read(name), /useImageEl\(shownSrc, item\.src, \{ x: item\.x \+ item\.w \/ 2, y: item\.y \+ item\.h \/ 2 \}\)/u, name)
  }
  const canvas = await read('KonvaCanvas.tsx')
  assert.match(canvas, /setImageLoadFocus\(/u)
  assert.match(canvas, /sendPrewarm\(entries\)/u)
})
