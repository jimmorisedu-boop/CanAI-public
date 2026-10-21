import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useComparePlayer } from './useComparePlayer'
import { handleCompareFrameKey, stepCompareFrames } from './compareFrameStep'
import { api } from '../../../api'

const here = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => readFileSync(join(here, name), 'utf8')

// У ВИДЕО способов сравнения ровно ДВА — «Рядом» и «Штора» (решение
// пользователя 03.09.2026). Штора для видео обязана работать: без неё видно
// два кадра, но не видно, чем они отличаются в одной и той же точке.

test('видео сравнивается и рядом, и шторой', () => {
  const viewer = read('CompareViewer.tsx')
  assert.match(viewer, /\{hasVideo && \(\s*<div className="compare-modes" role="group" aria-label=\{t\('Layout'\)\}>/u,
    'переключатель раскладки есть только у видео')
  assert.match(viewer, /\['side-by-side', 'Side by side'\],\s*\['overlay', 'Curtain'\]/u, 'у видео наложение называется шторой')
  assert.match(viewer, /const overlayMode: OverlayMode = hasVideo \? 'wipe' : mode/u)
  // ⚠️ «Переключение» и «Разница» видео не показываются: первое отбирает
  // пробел у воспроизведения, второе смешивает несинхронные кадры в шум.
  assert.match(viewer, /layout === 'overlay' && !hasVideo && \(/u)
})

// У ФОТО раскладка одна — наложение (решение пользователя 11.09.2026: «при
// сравнении фото рядом не нужно»), и выбор, сделанный на видео, к картинке не
// переносится.
test('фото сравниваются только наложением', () => {
  const viewer = read('CompareViewer.tsx')
  assert.match(viewer, /const layout: CompareLayout = hasVideo \? layoutOverride \?\? compareLayout\(kinds\) : 'overlay'/u)
  assert.doesNotMatch(viewer, /'Наложением'/u, 'у фото нет переключателя раскладки')
})

// ⚠️ Пробел смотрит на ДЕЙСТВУЮЩИЙ режим: на картинках могли выбрать
// «Переключение», и при переходе к видео пробел уводил бы в подглядку вместо
// воспроизведения.
test('пробел и подсказка идут за действующим режимом, а не за прошлым выбором', () => {
  const viewer = read('CompareViewer.tsx')
  assert.doesNotMatch(viewer, /mode === 'toggle' && shownIsBaseline/u, 'остался прошлый выбор')
  assert.match(viewer, /overlayMode !== 'toggle'/u)
  assert.match(viewer, /layout !== 'overlay' \|\| hasVideo \?/u, 'у видео пробел — воспроизведение')
})

test('наложение умеет видео и ведёт оба слоя одним плеером', () => {
  const overlay = read('CompareOverlayView.tsx')
  assert.match(overlay, /<video/u, 'видео в наложении рисуется')
  assert.match(overlay, /useComparePlayer\(/u, 'слои идут одним плеером')
  // Разойдись они на полсекунды — штора покажет разницу таймкодов, а не работы.
  assert.doesNotMatch(overlay, /syncPlan\(/u, 'синхронизация живёт в useComparePlayer')
})

test('панели не пишут синхронизацию видео у себя', () => {
  const panels = read('ComparePanelsView.tsx')
  assert.match(panels, /useComparePlayer\(/u)
  assert.doesNotMatch(panels, /syncPlan\(/u, 'синхронизация живёт в useComparePlayer')
  assert.match(panels, /<ComparePlayer\b/u, 'полосу плеера рисует общий компонент')
  assert.doesNotMatch(panels, /className="compare-scrub"/u, 'своей разметки плеера быть не должно')
})

// Раскладку «рядом» можно выбрать и для двух картинок — пустая полоса
// перемотки под ними ничего не значит.
test('плеер показывается только когда есть что играть', () => {
  for (const name of ['ComparePanelsView.tsx', 'CompareOverlayView.tsx']) {
    assert.match(read(name), /\{videoCount > 0 && \(\s*<ComparePlayer/u, name)
  }
})

test('покадровый шаг плеера останавливает оба видео и синхронно переходит на следующий кадр', () => {
  const videos = [
    { duration: 2, currentTime: 0.2, paused: false, readyState: 1, pause() { this.paused = true }, getAttribute() { return '/media/short.mp4' } },
    { duration: 5, currentTime: 0.4, paused: false, readyState: 1, pause() { this.paused = true }, getAttribute() { return '/media/long.mp4' } },
  ]
  let step: ((frames: number) => void) | undefined
  function Probe() {
    const player = useComparePlayer({ current: videos as HTMLVideoElement[] }, 'test')
    step = player.stepFrames
    return null
  }
  renderToStaticMarkup(React.createElement(Probe))
  step?.(1)
  // Без метаданных FPS используется тот же запасной шаг 25 fps, что в таймлайне.
  // Ведёт второй, более длинный ролик: с кадра 10 на середину кадра 11.
  assert.deepEqual(videos.map((video) => video.currentTime), [0.46, 0.46])
  assert.deepEqual(videos.map((video) => video.paused), [true, true])
})

function videoAt(currentTime: number, duration = 3) {
  return { currentTime, duration, readyState: 1, paused: false, pause() { this.paused = true } }
}

function keyEvent(options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'd', code: 'KeyD', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    target: null, isComposing: false, defaultPrevented: false,
    preventDefault() { Object.assign(this, { defaultPrevented: true }) },
    stopPropagation() {}, ...options,
  } as KeyboardEvent
}

for (const [code, key, shiftKey, expected] of [
  ['KeyA', 'a', false, 0.98], ['KeyD', 'd', false, 1.06],
  ['KeyA', 'Ф', true, 0.62], ['KeyD', 'В', true, 1.42],
] as const) {
  test(`${code}, shift=${shiftKey}: клавиша меняет кадры, включая русскую раскладку`, () => {
    const video = videoAt(1)
    const event = keyEvent({ code, key, shiftKey })
    handleCompareFrameKey(event, (frames) => stepCompareFrames([video], frames, () => 25) !== null)
    assert.equal(video.currentTime, expected)
    assert.equal(video.paused, true)
    assert.equal(event.defaultPrevented, true)
  })
}

test('разные FPS: ведущий — самый длинный ролик, второе видео получает то же время', () => {
  const short = videoAt(0.1, 1)
  const long = videoAt(0.5, 3)
  stepCompareFrames([short, long], 1, (video) => video === long ? 24 : 60)
  assert.equal(long.currentTime, 0.5625)
  assert.equal(short.currentTime, long.currentTime)
  assert.equal(short.paused, true)
  assert.equal(long.paused, true)
})

test('дробные 30000/1001 fps не округляются до 30, десять кадров считаются по реальной частоте', () => {
  const video = videoAt(0)
  stepCompareFrames([video], 10, () => 30000 / 1001)
  assert.ok(Math.abs(video.currentTime - 0.35035) < 1e-12)
  stepCompareFrames([video], -10, () => 30000 / 1001)
  assert.equal(video.currentTime, 0)
})

test('одиночное видео в паре с картинкой шагает от текущего кадра после произвольной перемотки', () => {
  const video = videoAt(0.219)
  stepCompareFrames([video], -1, () => 25)
  assert.equal(video.currentTime, 0.18)
  stepCompareFrames([video], 10, () => 25)
  assert.equal(video.currentTime, 0.58)
})

for (const [time, frames, expected] of [[0, -1, 0], [0.04, -10, 0], [0.96, 1, 0.98], [0.92, 10, 0.98], [1, -1, 0.94]] as const) {
  test(`границы: ${time} с, ${frames} кадров → ${expected} с без зацикливания`, () => {
    const video = videoAt(time, 1)
    stepCompareFrames([video], frames, () => 25)
    assert.equal(video.currentTime, expected)
  })
}

test('короткий ролик замирает в конце и возвращается синхронно при обратном шаге', () => {
  const short = videoAt(0.8, 1)
  const long = videoAt(0.8, 3)
  stepCompareFrames([short, long], 10, () => 25)
  assert.deepEqual([short.currentTime, long.currentTime], [1, 1.22])
  stepCompareFrames([short, long], -10, () => 25)
  assert.deepEqual([short.currentTime, long.currentTime], [0.82, 0.82])
})

test('повторные нажатия не теряют кадры на ошибке дробного округления', () => {
  const video = videoAt(0, 10)
  for (let index = 0; index < 100; index++) stepCompareFrames([video], 1, () => 30000 / 1001)
  assert.ok(Math.abs(video.currentTime - 3.35335) < 1e-12)
  for (let index = 0; index < 100; index++) stepCompareFrames([video], -1, () => 30000 / 1001)
  assert.equal(video.currentTime, 0)
})

test('браузер округляет currentTime до микросекунд: Shift+A от последнего кадра шагает ровно на десять', () => {
  const video = videoAt(2.958333, 3)
  stepCompareFrames([video], -10, () => 24)
  assert.equal(video.currentTime, 2.5625)
})

test('WebM 24fps с миллисекундными PTS: десятый кадр действительно виден после Shift+D', () => {
  const video = videoAt(0)
  // В контейнере время десятого кадра 0.417, а 10/24 = 0.416666… —
  // seek на математическую границу ещё показывает кадр 9 (0.375).
  const timestamps = [0, 0.042, 0.083, 0.125, 0.167, 0.208, 0.25, 0.292, 0.333, 0.375, 0.417, 0.458]
  stepCompareFrames([video], 10, () => 24)
  assert.equal(timestamps.findLastIndex((time) => time <= video.currentTime), 10)
})

for (const fps of [undefined, 0, -1, NaN, Infinity]) {
  test(`неизвестный или невалидный FPS ${fps}: запасной шаг таймлайна 25 fps`, () => {
    const video = videoAt(0)
    stepCompareFrames([video], 1, () => fps)
    assert.equal(video.currentTime, 0.06)
  })
}

for (const options of [
  { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true },
  { code: 'ArrowRight' }, { code: 'KeyF', key: 'a' },
  { target: { tagName: 'INPUT' } }, { target: { tagName: 'TEXTAREA' } }, { target: { tagName: 'SELECT' } },
  { target: { tagName: 'SPAN', isContentEditable: true } },
]) {
  test(`покадровые клавиши не мешают вводу и чужим сочетаниям: ${JSON.stringify(options)}`, () => {
    const video = videoAt(1)
    const event = keyEvent(options as Partial<KeyboardEvent>)
    assert.equal(handleCompareFrameKey(event, (frames) => stepCompareFrames([video], frames, () => 25) !== null), false)
    assert.equal(video.currentTime, 1)
    assert.equal(video.paused, false)
    assert.equal(event.defaultPrevented, options.defaultPrevented ?? false)
  })
}

test('удержание D на кнопке плеера продолжает листать кадры', () => {
  const video = videoAt(1)
  const event = keyEvent({ repeat: true, target: { tagName: 'BUTTON' } as HTMLElement })
  handleCompareFrameKey(event, (frames) => stepCompareFrames([video], frames, () => 25) !== null)
  assert.equal(video.currentTime, 1.06)
})

test('без готового видео клавиша не захватывается и время не ломается', () => {
  const pending = { ...videoAt(0), duration: NaN, readyState: 0 }
  for (const videos of [[], [pending]]) {
    const event = keyEvent()
    assert.equal(handleCompareFrameKey(event, (frames) => stepCompareFrames(videos, frames, () => 25) !== null), false)
    assert.equal(event.defaultPrevented, false)
  }
  assert.equal(pending.currentTime, 0)
})

test('FPS локального видео запрашивается через локальный media route', async (t) => {
  const globals = globalThis as unknown as { window?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }
  const previous = globals.window
  globals.window = { setTimeout, clearTimeout }
  t.after(() => { if (previous) globals.window = previous; else delete globals.window })
  let requested = ''
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested = String(url)
    return new Response(JSON.stringify({ duration: 3, fps: 24, hasAudio: false }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal((await api.probeVideo('/media/ast_video.mp4?v=2')).fps, 24)
  assert.equal(requested, '/api/media/probe-video')
})

test('звук локального видео отделяется через локальный media route', async (t) => {
  const globals = globalThis as unknown as { window?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }
  const previous = globals.window
  globals.window = { setTimeout, clearTimeout }
  t.after(() => { if (previous) globals.window = previous; else delete globals.window })
  const requested: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(String(url))
    return new Response(JSON.stringify({ url: '/media/audio.mp3', mime: 'audio/mpeg' }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  await api.extractAudio('/media/ast_video.mp4?v=2')
  await api.extractAudio('/media/video.mp4')
  assert.deepEqual(requested, [
    '/api/media/extract-audio',
    '/api/media/extract-audio',
  ])
})
