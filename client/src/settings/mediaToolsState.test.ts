import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaToolsView, shouldPollMediaTools } from './mediaToolsState.js'

test('своя копия и системный ffmpeg — разные состояния, а не одно «готово»', () => {
  const own = mediaToolsView({ state: 'ready', source: 'runtime' })
  assert.equal(own.tone, 'ok')
  assert.equal(own.action, null, 'скачивать нечего')

  // На машине разработчика системный найдётся сам. Если не сказать об этом,
  // легко собрать дистрибутив, в котором компонента нет вовсе, — и обнаружить
  // это уже у покупателя.
  const system = mediaToolsView({ state: 'ready', source: 'system' })
  assert.equal(system.tone, 'ok')
  assert.equal(system.label, 'System')
  assert.ok(system.action, 'предложить свою копию всё равно надо')
  assert.match(system.note ?? '', /another computer/i)
})

test('пока идёт закачка, кнопки нет, а процент виден', () => {
  const view = mediaToolsView({ state: 'downloading', percent: 42 })
  assert.equal(view.label, '42%')
  assert.equal(view.action, null)
  assert.equal(view.busy, true)
  assert.match(view.note ?? '', /40 MB/)
})

test('ошибка показывает причину и даёт повторить', () => {
  const view = mediaToolsView({ state: 'failed', message: 'Не удалось скачать ffmpeg (HTTP 502)' })
  assert.equal(view.tone, 'danger')
  assert.equal(view.note, 'Не удалось скачать ffmpeg (HTTP 502)')
  assert.equal(view.action, 'Try again')
})

test('неподдержанная система не предлагает кнопку, которая ничего не сделает', () => {
  const view = mediaToolsView({ state: 'unsupported' })
  assert.equal(view.action, null)
  assert.equal(view.tone, 'warn')
})

test('отсутствие компонента объясняет, зачем он нужен', () => {
  const view = mediaToolsView({ state: 'missing' })
  assert.equal(view.action, 'Download')
  assert.match(view.note ?? '', /audio|video/i)
})

test('опрос идёт только во время закачки', () => {
  assert.equal(shouldPollMediaTools({ state: 'downloading', percent: 3 }), true)
  assert.equal(shouldPollMediaTools({ state: 'ready', source: 'runtime' }), false)
  assert.equal(shouldPollMediaTools({ state: 'missing' }), false)
  assert.equal(shouldPollMediaTools({ state: 'failed', message: 'x' }), false)
  assert.equal(shouldPollMediaTools(null), false)
})

// ⚠️ «Нет сборки для этой системы» и «файла нет в папке» — РАЗНЫЕ беды, и
// советы у них разные. На macOS ffmpeg работает, он просто должен был приехать
// вместе с приложением; предлагать там «Скачать» — звать к кнопке, которая
// ничего не сделает.
test('нескачиваемая сборка не предлагает кнопку, а объясняет', () => {
  const view = mediaToolsView({ state: 'missing', downloadable: false })
  assert.equal(view.action, null, 'кнопки быть не должно')
  assert.match(view.note ?? '', /ships with the app/)
  assert.doesNotMatch(view.note ?? '', /install ffmpeg/, 'это не «поставьте сами»')
})

test('там, где качать есть откуда, всё как было', () => {
  for (const state of [{ state: 'missing' as const }, { state: 'missing' as const, downloadable: true }]) {
    const view = mediaToolsView(state)
    assert.equal(view.action, 'Download')
    assert.equal(view.label, 'Not installed')
  }
})
