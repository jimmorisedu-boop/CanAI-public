import assert from 'node:assert/strict'
import test from 'node:test'
import { GifPlayer } from './gifPlayer'

// Жалоба 27.09.2026: «сетевая доска всё равно медленно» — десятки картинок
// висели серыми прямоугольниками. Замер в Chrome 152: пока в пути три и больше
// обычных fetch, браузер придерживает ВСЕ картинки и отпускает их раз в
// 15 секунд. Держали их загрузки GIF-плеера: медленные (оригинал с сервера
// команды через VPN) и брошенные (плеер закрыли до ответа — файл крупнее
// ~5 МБ браузер недокачивал и держал соединение минутами).

type Captured = { url: string; init: RequestInit | undefined; resolve: (value: unknown) => void }

const g = globalThis as Record<string, unknown>
g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) }
g.ImageDecoder = class {}
let calls: Captured[] = []
g.fetch = (url: string, init?: RequestInit) => new Promise((resolve) => {
  calls.push({ url, init, resolve })
})

test('плеер качает GIF с низким приоритетом — картинки доски его не ждут', () => {
  calls = []
  const player = new GifPlayer('/api/cloud-assets/assets/ast_gif')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.init?.priority, 'low')
  player.close()
})

test('закрытый плеер обрывает загрузку, а не бросает её недокачанной', async () => {
  calls = []
  const player = new GifPlayer('/media/big.gif')
  const signal = calls[0]!.init?.signal
  assert.ok(signal, 'у загрузки есть чем её оборвать')
  assert.equal(signal.aborted, false)
  player.close()
  assert.equal(signal.aborted, true, 'объект ушёл с экрана — соединение свободно')
})

test('ответ, пришедший уже после закрытия, отменяется, а не остаётся висеть', async () => {
  calls = []
  const player = new GifPlayer('/media/big.gif')
  let cancelled = false
  let read = false
  player.close()
  calls[0]!.resolve({
    ok: true,
    body: { cancel: async () => { cancelled = true } },
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0) },
  })
  assert.equal(await player.ready, false)
  assert.equal(cancelled, true, 'тело ответа отменено — браузер отпускает соединение')
  assert.equal(read, false, 'ненужный файл не дочитывается')
})

test('ответ с ошибкой тоже не остаётся непрочитанным', async () => {
  calls = []
  const player = new GifPlayer('/media/missing.gif')
  let cancelled = false
  calls[0]!.resolve({ ok: false, body: { cancel: async () => { cancelled = true } } })
  assert.equal(await player.ready, false)
  assert.equal(cancelled, true)
  player.close()
})
