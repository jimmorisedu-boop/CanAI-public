// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { faceModelsLicenses, faceModelsView, shouldPollFaceModels } from './faceModelsState'

// Формулировки проверяем тестом, а не глазами в модалке: это единственное
// место, где человек узнаёт, что качается, сколько весит и куда уходят снимки.

test('пока состояние неизвестно, кнопки нет', () => {
  const view = faceModelsView(null)
  assert.equal(view.action, null)
  assert.equal(view.busy, true)
})

test('не установлено — предлагаем скачать и честно называем вес', () => {
  const view = faceModelsView({ state: 'missing', models: [] })
  assert.equal(view.action, 'Download')
  assert.match(view.note ?? '', /38 MB/)
  // Без моделей сравнение обязано работать как раньше — это и сказано.
  assert.match(view.note ?? '', /previous behavior/)
})

test('готово — сказано, что считает этот компьютер', () => {
  // Речь о лицах живых людей: человек вправе знать, что наружу ничего не идёт.
  const view = faceModelsView({ state: 'ready', models: [] })
  assert.equal(view.action, null)
  assert.match(view.note ?? '', /images are not uploaded/)
})

test('во время закачки показываем процент и не даём жать снова', () => {
  const view = faceModelsView({ state: 'downloading', percent: 42, models: [] })
  assert.equal(view.label, '42%')
  assert.equal(view.busy, true)
  assert.equal(view.action, null)
})

test('сбой объясняется и даёт повторить', () => {
  const view = faceModelsView({ state: 'failed', message: 'Сеть недоступна', models: [] })
  assert.equal(view.action, 'Try again')
  assert.equal(view.note, 'Сеть недоступна')
  assert.equal(view.tone, 'danger')
})

test('опрашиваем только во время закачки', () => {
  assert.equal(shouldPollFaceModels({ state: 'downloading', models: [] }), true)
  assert.equal(shouldPollFaceModels({ state: 'ready', models: [] }), false)
  assert.equal(shouldPollFaceModels(null), false)
})

test('лицензии видно в настройках — приложение продаётся', () => {
  const line = faceModelsLicenses({
    state: 'ready',
    models: [
      { name: 'face_detection_yunet_2023mar.onnx', license: 'MIT' },
      { name: 'face_recognition_sface_2021dec.onnx', license: 'Apache 2.0' },
    ],
  })
  assert.match(line ?? '', /MIT/)
  assert.match(line ?? '', /Apache 2\.0/)
  assert.doesNotMatch(line ?? '', /\.onnx/)
})
