import assert from 'node:assert/strict'
import test from 'node:test'
import { publicFfmpegState, shouldStartFfmpegDownload } from './mediaToolsRoutes.js'

test('системный ffmpeg не отменяет загрузку своей копии', () => {
  // Найденный в системе ffmpeg — это ещё не портативность: он останется на
  // этой машине. Пока проверка была «нашёлся хоть какой-нибудь», кнопка
  // «Скачать свою копию» на такой машине молча не делала ничего.
  assert.equal(shouldStartFfmpegDownload({ state: 'ready', source: 'system', tools: { ffmpeg: 'a', ffprobe: 'b' } }), true)
  assert.equal(shouldStartFfmpegDownload({ state: 'ready', source: 'runtime', tools: { ffmpeg: 'a', ffprobe: 'b' } }), false)
})

test('повторное нажатие во время закачки не начинает вторую', () => {
  assert.equal(shouldStartFfmpegDownload({ state: 'downloading', percent: 30 }), false)
})

test('после ошибки повторить можно, а на чужой системе — нечего', () => {
  assert.equal(shouldStartFfmpegDownload({ state: 'failed', message: 'HTTP 502' }), true)
  assert.equal(shouldStartFfmpegDownload({ state: 'missing' }), true)
  assert.equal(shouldStartFfmpegDownload({ state: 'unsupported' }), false)
})

test('наружу уходит состояние без путей к файлам', () => {
  const ready = publicFfmpegState({ state: 'ready', source: 'runtime', tools: { ffmpeg: 'C:/app/ffmpeg.exe', ffprobe: 'C:/app/ffprobe.exe' } })
  assert.deepEqual(ready, { state: 'ready', source: 'runtime' })
  assert.equal(JSON.stringify(ready).includes('C:/app'), false, 'пути к файлам наружу не нужны')

  assert.deepEqual(publicFfmpegState({ state: 'downloading', percent: 7 }), { state: 'downloading', percent: 7 })
  assert.deepEqual(publicFfmpegState({ state: 'failed', message: 'HTTP 502' }), { state: 'failed', message: 'HTTP 502' })
  // downloadable подставляется по текущей системе, поэтому здесь сверяем
  // только сам статус: иначе тест был бы зелёным на Windows и красным на маке.
  assert.equal(publicFfmpegState({ state: 'missing' }).state, 'missing')
})

// На macOS сборка приезжает вместе с приложением, качать её неоткуда. Без
// этого признака панель настроек рисовала бы кнопку «Скачать», которая ничего
// не делает, — та же беда, что была с cloudflared.
test('состояние говорит, есть ли откуда качать', () => {
  assert.deepEqual(publicFfmpegState({ state: 'missing' }, true), { state: 'missing', downloadable: true })
  assert.deepEqual(publicFfmpegState({ state: 'missing' }, false), { state: 'missing', downloadable: false })

  // Готовое состояние признак не несёт — там уже нечего решать.
  assert.deepEqual(
    publicFfmpegState({ state: 'ready', tools: { ffmpeg: 'a', ffprobe: 'b' }, source: 'runtime' }, false),
    { state: 'ready', source: 'runtime' },
  )
})
