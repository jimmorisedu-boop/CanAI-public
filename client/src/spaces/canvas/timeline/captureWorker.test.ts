import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CanvasStore } from '../konva/canvasStore'
import { FrameCaptureQueue } from './frameCaptureQueue'
import { makeFrameCaptureWork } from './captureWorker'

// Раздел 11/19 ТЗ: «view zoom не меняет width/height capture canvas» и
// «provenance = frozen requested time». worker — модуль браузерный (frameBlob,
// upload, canvasStore), юнит-тестом без DOM не прогнать, поэтому инварианты
// запираем иструктурным чтением исходника — тот же приём, что у
// timelineBarLayout.test.ts. Если кто-то передаст zoom/canvas в захват или
// запишет живое currentTime вместо frozen — тест упадёт.

function workerCode(): string {
  // Судим по КОДУ, а не по комментариям: в пояснении «замороженное время, а не
  // живой currentTime» слово currentTime встречается намеренно.
  const src = readFileSync(new URL('./captureWorker.ts', import.meta.url), 'utf8')
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('захват не получает zoom: native pixels зависят только от декодера клипа', () => {
  const worker = workerCode()
  // В рабочем коде нет ни viewport, ни zoom, ни scale: значит, размер кадра
  // берётся из самого клипа (frameBlob), а не из CSS-размера превью.
  for (const forbidden of ['viewport', 'zoom', '.scale', 'getBoundingClientRect', 'clientWidth', 'clientHeight']) {
    assert.ok(!worker.includes(forbidden), `в captureWorker появился ${forbidden} — zoom попал в захват`)
  }
})

test('provenance пишется с ЗАМОРОЖЕННЫМ временем, а не живым currentTime', () => {
  const worker = workerCode()
  assert.match(worker, /decode\(src,\s*ctx\.frozenTime/, 'декодер использует замороженное время')
  assert.ok(!worker.includes('currentTime'), 'в захвате не читается живой currentTime')
})

test('provenance сохраняется штатным item-mutation: metadata-поле, не URL/base64', () => {
  const worker = workerCode()
  const types = readFileSync(new URL('../konva/types.ts', import.meta.url), 'utf8')
  assert.match(worker, /timelineCapture/, 'worker пишет происхождение кадра')
  assert.match(types, /timelineCapture\?:/, 'поле необязательное — старые проекты открываются')
  assert.doesNotMatch(worker, /toDataURL|base64/, 'запрещено класть кадр base64')
})

test('декодер клипа — это frameBlob через существующий commit, а не отдельный API', () => {
  const worker = workerCode()
  assert.match(worker, /frameBlob/, 'захват поверх существующего декодера видео')
  assert.match(worker, /captureFrameToCanvas/, 'а постановка на холст — через существующий commit')
})

// ⚠️ Поведение, а не форма исходника: рабочий обязан вернуть очереди АДРЕС
// готового кадра. Раньше он отдавал один itemId, очередь клала в запись
// `resultUrl: undefined`, и полка вечно крутила спиннер у готового кадра, а
// «Скачать» и клавиша D не находили файла. Хвост проходит настоящий
// CanvasStore и настоящую очередь, подменён только декодер видео (нужен DOM).

const CLIP = {
  id: 'clip', kind: 'video' as const, x: 0, y: 0, w: 320, h: 180,
  src: '/media/clip.mp4', naturalWidth: 1920, naturalHeight: 1080,
}

function boardWithClip(): CanvasStore {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, items: [CLIP], camera: { x: 0, y: 0, scale: 1 } })
  return store
}

const fakeDecode = async () => ({ blob: new Blob(['frame'], { type: 'image/png' }), width: 1920, height: 1080 })

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('очередь получает адрес готового кадра: resultUrl равен src объекта на доске', async () => {
  const store = boardWithClip()
  const queue = new FrameCaptureQueue()
  const work = makeFrameCaptureWork(store, CLIP, {
    upload: async () => ({ url: '/media/frame-3-25.png', mime: 'image/png' }),
    decode: fakeDecode,
  })
  queue.enqueue({ itemId: CLIP.id, src: CLIP.src }, 3.25, work)
  await settle()

  const record = queue.getRecords()[0]
  assert.equal(record.phase, 'saved')
  assert.ok(record.resultItemId, 'у записи есть id объекта')
  assert.equal(record.resultUrl, '/media/frame-3-25.png', 'адрес доехал до записи')
  assert.equal(record.resultUrl, store.getItem(record.resultItemId!)?.src, 'и это именно src объекта')
  assert.equal(store.getItem(record.resultItemId!)?.timelineCapture?.time, 3.25, 'происхождение — замороженное время')
})

test('декодер получает замороженное время, а не что-то иное', async () => {
  const store = boardWithClip()
  const asked: number[] = []
  const work = makeFrameCaptureWork(store, CLIP, {
    upload: async () => ({ url: '/media/f.png', mime: 'image/png' }),
    decode: async (_src, time) => { asked.push(time); return fakeDecode() },
  })
  const queue = new FrameCaptureQueue()
  queue.enqueue({ itemId: CLIP.id, src: CLIP.src }, 7.5, work)
  await settle()
  assert.deepEqual(asked, [7.5])
})

test('у клипа без файла работа падает словами, а не пустым результатом', async () => {
  const store = boardWithClip()
  const work = makeFrameCaptureWork(store, { ...CLIP, src: undefined }, {
    upload: async () => ({ url: '/media/f.png', mime: 'image/png' }),
    decode: fakeDecode,
  })
  const queue = new FrameCaptureQueue()
  queue.enqueue({ itemId: CLIP.id }, 1, work)
  await settle()
  const record = queue.getRecords()[0]
  assert.equal(record.phase, 'error')
  assert.equal(record.error, 'Clip has no file')
})
