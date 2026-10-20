import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { filmstripCellCount, filmstripCellTimes } from './useFilmstrip'
import {
  FILMSTRIP_CELL_HEIGHT,
  FILMSTRIP_MAX_CELLS,
  FILMSTRIP_MIN_CELLS,
  filmstripCaptureOrder,
  filmstripCellSize,
  filmstripCoverRect,
} from './filmstripMath'
import { startFilmstripJob } from './filmstripJob'

// ── чистые функции ──────────────────────────────────────────────────────────

test('число ячеек: сколько кадров по пропорции помещается в ширину, зажато в 6…40', () => {
  // дорожка 1080×60, кадр 16:9 → ячейка 106.7 px → 10 штук
  assert.equal(filmstripCellCount(1080, 60, 16 / 9), 10)
  // квадратные кадры (1:1) на той же дорожке — 18
  assert.equal(filmstripCellCount(1080, 60, 1), 18)
  // узкая дорожка не опускается ниже пола, широкая не уходит за потолок
  assert.equal(filmstripCellCount(120, 60, 16 / 9), FILMSTRIP_MIN_CELLS)
  assert.equal(filmstripCellCount(6000, 40, 16 / 9), FILMSTRIP_MAX_CELLS)
})

test('число ячеек: нули и мусор — 0, а не пол', () => {
  assert.equal(filmstripCellCount(0, 60, 16 / 9), 0)
  assert.equal(filmstripCellCount(1080, 0, 16 / 9), 0)
  assert.equal(filmstripCellCount(1080, 60, 0), 0)
  assert.equal(filmstripCellCount(Number.NaN, 60, 16 / 9), 0)
  assert.equal(filmstripCellCount(1080, Number.NaN, 16 / 9), 0)
  assert.equal(filmstripCellCount(1080, 60, Number.NaN), 0)
  assert.equal(filmstripCellCount(-10, 60, 16 / 9), 0)
  assert.equal(filmstripCellCount(Number.POSITIVE_INFINITY, 60, 16 / 9), 0)
})

test('времена ячеек: середина каждой, под x% дорожки — кадр из x% клипа', () => {
  const times = filmstripCellTimes(10, 4)
  assert.deepEqual(times, [1.25, 3.75, 6.25, 8.75])
  // монотонно и строго внутри клипа
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] > times[i - 1])
  assert.ok(times.every((time) => time > 0 && time < 10))
  // середина ячейки i — это (i + 0.5) / count доли длительности
  const many = filmstripCellTimes(37.5, 25)
  many.forEach((time, i) => assert.ok(Math.abs(time - ((i + 0.5) / 25) * 37.5) < 1e-9))
})

test('времена ячеек: не дальше конца клипа и не раньше нуля', () => {
  // у клипа короче миллисекунды «duration − 0.001» ушло бы в минус
  assert.deepEqual(filmstripCellTimes(0.0005, 3), [0, 0, 0])
  // одна ячейка на весь клип — его середина
  assert.deepEqual(filmstripCellTimes(8, 1), [4])
  for (const time of filmstripCellTimes(2, 40)) assert.ok(time >= 0 && time <= 2 - 0.001)
})

test('времена ячеек: нет длительности или числа — пусто, а не NaN', () => {
  assert.deepEqual(filmstripCellTimes(0, 5), [])
  assert.deepEqual(filmstripCellTimes(-3, 5), [])
  assert.deepEqual(filmstripCellTimes(Number.NaN, 5), [])
  assert.deepEqual(filmstripCellTimes(10, 0), [])
  assert.deepEqual(filmstripCellTimes(10, Number.NaN), [])
})

test('порядок съёмки: сначала редкая сетка, потом уплотнение, каждая ячейка — раз', () => {
  for (const count of [1, 2, 3, 6, 10, 24, 25, 40]) {
    const order = filmstripCaptureOrder(count)
    assert.equal(order.length, count, `${count}: все ячейки`)
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i), `${count}: без повторов`)
  }
  // 24 ячейки: сперва 0 и 16, потом 8, потом четвёрки
  assert.deepEqual(filmstripCaptureOrder(24).slice(0, 6), [0, 16, 8, 4, 12, 20])
  assert.deepEqual(filmstripCaptureOrder(6), [0, 4, 2, 1, 3, 5])
  assert.deepEqual(filmstripCaptureOrder(0), [])
  assert.deepEqual(filmstripCaptureOrder(Number.NaN), [])
})

test('порядок съёмки: на любом этапе пустоты рассеяны, а не собраны в хвосте', () => {
  // после первой трети ячеек ни один пробел между снятыми не больше четверти плёнки
  const count = 40
  const done = filmstripCaptureOrder(count).slice(0, Math.ceil(count / 3)).sort((a, b) => a - b)
  for (let i = 1; i < done.length; i += 1) assert.ok(done[i] - done[i - 1] <= count / 4 + 1)
})

test('размер ячейки: высота постоянная, ширина по пропорции кадра', () => {
  assert.deepEqual(filmstripCellSize(16 / 9), { width: Math.round(FILMSTRIP_CELL_HEIGHT * 16 / 9), height: FILMSTRIP_CELL_HEIGHT })
  assert.equal(filmstripCellSize(1).width, FILMSTRIP_CELL_HEIGHT)
  assert.equal(filmstripCellSize(9 / 16).width, Math.round(FILMSTRIP_CELL_HEIGHT * 9 / 16))
  // непонятная пропорция не ломает ячейку — берётся 16:9
  assert.deepEqual(filmstripCellSize(0), filmstripCellSize(16 / 9))
  assert.deepEqual(filmstripCellSize(Number.NaN), filmstripCellSize(16 / 9))
})

test('вписывание cover: ячейка заполнена целиком, лишнее срезано поровну', () => {
  // вертикальный клип 1080×1920 в ячейку 16:9: срезаем сверху и снизу
  const portrait = filmstripCoverRect(1080, 1920, 160, 90)!
  assert.equal(portrait.sx, 0)
  assert.equal(portrait.sw, 1080)
  assert.ok(Math.abs(portrait.sh - 1080 * 90 / 160) < 1e-9)
  assert.ok(Math.abs(portrait.sy - (1920 - portrait.sh) / 2) < 1e-9, 'поровну сверху и снизу')
  // широкий клип 21:9 в ячейку 16:9: срезаем по бокам
  const wide = filmstripCoverRect(2100, 900, 160, 90)!
  assert.equal(wide.sy, 0)
  assert.equal(wide.sh, 900)
  assert.ok(Math.abs(wide.sw - 900 * 160 / 90) < 1e-9)
  assert.ok(Math.abs(wide.sx - (2100 - wide.sw) / 2) < 1e-9)
  // та же пропорция — ничего не срезаем
  assert.deepEqual(filmstripCoverRect(1920, 1080, 160, 90), { sx: 0, sy: 0, sw: 1920, sh: 1080 })
  // кадр без размеров (метаданных ещё нет) — рисовать нечего
  assert.equal(filmstripCoverRect(0, 0, 160, 90), null)
  assert.equal(filmstripCoverRect(Number.NaN, 1080, 160, 90), null)
})

// ── сборка плёнки на подмене <video> ────────────────────────────────────────
// Браузера в тесте нет, поэтому document, видео и canvas подменены. Проверяется
// главное обещание: ячейки приходят по мере готовности, остановка действует
// СРАЗУ (ни одной лишней перемотки), сбой и опоздавшая ячейка не роняют плёнку.

class FakeVideo extends EventTarget {
  muted = false
  playsInline = false
  crossOrigin: string | null = null
  preload = ''
  src = ''
  readyState = 0
  seeking = false
  videoWidth = 1920
  videoHeight = 1080
  seeks: number[] = []
  loads = 0
  pauses = 0
  /** Сколько слушателей сейчас висит: после остановки не должно остаться ни одного. */
  listeners = 0
  /** Что делать на перемотку: по умолчанию кадр готов сразу. */
  onSeek: (time: number, video: FakeVideo) => void = (_time, video) => { video.finishSeek() }
  private position = 0
  get currentTime(): number { return this.position }
  set currentTime(value: number) {
    this.position = value
    this.seeks.push(value)
    this.onSeek(value, this)
  }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners += 1
    super.addEventListener(...args)
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners -= 1
    super.removeEventListener(...args)
  }
  load(): void { this.loads += 1 }
  pause(): void { this.pauses += 1 }
  removeAttribute(name: string): void { if (name === 'src') this.src = '' }
  /** Метаданные пришли. */
  metadata(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('loadedmetadata'))
  }
  /** Кадр после перемотки готов (асинхронно, как у настоящего видео). */
  finishSeek(): void {
    setImmediate(() => {
      this.readyState = 2
      this.dispatchEvent(new Event('seeked'))
    })
  }
}

interface Rig {
  video: FakeVideo
  draws: unknown[][]
  restore(): void
}

function installFakeDom(): Rig {
  const video = new FakeVideo()
  const draws: unknown[][] = []
  let encoded = 0
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args: unknown[]) => { draws.push(args) } }),
    toDataURL: (type: string) => `data:${type};cell-${encoded++}`,
  }
  const previous = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => (tag === 'video' ? video : canvas),
  }
  return {
    video,
    draws,
    restore() {
      ;(globalThis as { document?: unknown }).document = previous
    },
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
/** Пропустить несколько тактов: перемотки идут через setImmediate. */
async function flushMany(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush()
}

function startJob(rig: Rig, count: number, extra: Partial<{ aspect: number }> = {}) {
  const cells: Array<{ index: number; url: string }> = []
  let failed = 0
  const times = filmstripCellTimes(60, count)
  const job = startFilmstripJob({
    src: '/media/clip.mp4',
    times,
    aspect: extra.aspect ?? 16 / 9,
    onCell: (index, url) => { cells.push({ index, url }) },
    onFailed: () => { failed += 1 },
  })
  return { job, cells, times, failed: () => failed }
}

test('сборка: отдельное видео как раньше — без звука, inline, anonymous CORS, свой файл', () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 6)
    assert.equal(rig.video.muted, true)
    assert.equal(rig.video.playsInline, true)
    assert.equal(rig.video.crossOrigin, 'anonymous')
    assert.equal(rig.video.src, '/media/clip.mp4')
    run.job.stop()
  } finally {
    rig.restore()
  }
})

test('сборка: ячейки приходят по одной, в порядке сетки, каждая из своего времени', async () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 6)
    await flush()
    assert.equal(rig.video.seeks.length, 0, 'до метаданных перемоток нет')
    rig.video.metadata()
    await flushMany(30)

    const order = filmstripCaptureOrder(6)
    assert.deepEqual(run.cells.map((cell) => cell.index), order, 'порядок — редкая сетка, потом уплотнение')
    assert.deepEqual(rig.video.seeks, order.map((index) => run.times[index]), 'каждая ячейка снята из своего времени')
    assert.ok(run.cells.every((cell) => cell.url.startsWith('data:image/jpeg')), 'ячейка — отдельный JPEG')
    assert.equal(new Set(run.cells.map((cell) => cell.url)).size, 6, 'каждая со своей картинкой')
    assert.equal(run.failed(), 0)
    // кадр вписан с обрезкой в ячейку: drawImage(video, sx, sy, sw, sh, 0, 0, w, h)
    const { width, height } = filmstripCellSize(16 / 9)
    assert.deepEqual(rig.draws[0].slice(5), [0, 0, width, height])
    // и видео освобождено, когда всё снято
    assert.equal(rig.video.src, '')
    assert.ok(rig.video.loads >= 2, 'load() после снятия src')
  } finally {
    rig.restore()
  }
})

test('остановка: прежняя сборка замолкает сразу — ни одной лишней перемотки', async () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 12)
    rig.video.metadata()
    await flushMany(3)
    const doneBefore = run.cells.length
    assert.ok(doneBefore >= 1, 'часть ячеек успела')

    // следующая перемотка зависает — как на медленном сервере
    rig.video.onSeek = () => {}
    await flushMany(5)
    const seeksAtStop = rig.video.seeks.length
    const cellsAtStop = run.cells.length
    run.job.stop()
    await flushMany(10)

    assert.equal(rig.video.seeks.length, seeksAtStop, 'после stop() перемоток нет')
    assert.equal(run.cells.length, cellsAtStop, 'и ячейки больше не приходят')
    assert.equal(rig.video.src, '', 'видео освобождено')
    assert.ok(rig.video.pauses >= 1)
    // зависшая перемотка оборвана сразу, а не дожидается своего срока в 4 секунды
    assert.equal(rig.video.listeners, 0, 'ожидание кадра снято вместе со слушателями')
    assert.equal(run.failed(), 0, 'остановка — не сбой')
  } finally {
    rig.restore()
  }
})

test('остановка до метаданных: перемоток нет вовсе, сбоя нет', async () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 8)
    run.job.stop()
    // метаданные приходят уже после остановки — не должны ничего запустить
    rig.video.metadata()
    await flushMany(10)
    assert.equal(rig.video.seeks.length, 0)
    assert.equal(run.cells.length, 0)
    assert.equal(run.failed(), 0)
    assert.equal(rig.video.src, '')
    assert.equal(rig.video.listeners, 0, 'ожидание метаданных снято')
  } finally {
    rig.restore()
  }
})

test('опоздавшая ячейка остаётся пустой, остальные снимаются', async () => {
  const rig = installFakeDom()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const order = filmstripCaptureOrder(6)
    const stuckTime = filmstripCellTimes(60, 6)[order[1]]
    // вторая по порядку ячейка перематывается вечно
    rig.video.onSeek = (time, video) => { if (time !== stuckTime) video.finishSeek() }
    const run = startJob(rig, 6)
    rig.video.metadata()
    await flushMany(6)
    assert.deepEqual(run.cells.map((cell) => cell.index), [order[0]], 'остановились на зависшей')

    mock.timers.tick(4000)
    await flushMany(20)
    const indexes = run.cells.map((cell) => cell.index)
    assert.ok(!indexes.includes(order[1]), 'зависшая ячейка осталась пустой')
    assert.deepEqual(indexes, order.filter((index) => index !== order[1]), 'остальные сняты в порядке')
    assert.equal(run.failed(), 0, 'плёнка не падает из-за одной ячейки')
  } finally {
    mock.timers.reset()
    rig.restore()
  }
})

test('ошибка загрузки: сообщаем о сбое один раз, ячеек нет', async () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 6)
    rig.video.dispatchEvent(new Event('error'))
    await flushMany(5)
    assert.equal(run.failed(), 1)
    assert.equal(run.cells.length, 0)
    assert.equal(rig.video.src, '', 'после сбоя видео тоже освобождено')
  } finally {
    rig.restore()
  }
})

test('ошибка чтения посреди съёмки: готовые ячейки остаются, сбой отмечен', async () => {
  const rig = installFakeDom()
  try {
    let seekNumber = 0
    rig.video.onSeek = (_time, video) => {
      seekNumber += 1
      if (seekNumber === 3) setImmediate(() => video.dispatchEvent(new Event('error')))
      else video.finishSeek()
    }
    const run = startJob(rig, 6)
    rig.video.metadata()
    await flushMany(20)
    assert.equal(run.cells.length, 2, 'две ячейки успели до сбоя')
    assert.equal(run.failed(), 1)
  } finally {
    rig.restore()
  }
})

test('ошибка, пришедшая после остановки, сбоем не считается', async () => {
  const rig = installFakeDom()
  try {
    const run = startJob(rig, 6)
    run.job.stop()
    // браузер после снятия src сам шлёт error — это не наша беда
    rig.video.dispatchEvent(new Event('error'))
    await flushMany(5)
    assert.equal(run.failed(), 0)
  } finally {
    rig.restore()
  }
})
