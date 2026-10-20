import assert from 'node:assert/strict'
import test from 'node:test'
import {
  autoOptionLabel,
  autoRefusalText,
  kindLabel,
  refSetSummary,
  tooFewText,
  tooManyText,
  tooManyTotalText,
  wrongKindText,
} from './smartModelMessages'

// Прежние отказы были собраны из кусков без склонения: «не больше 16
// изображений-референса», «не принимает изображений-референсы», «тип «video»».
// Числа теперь идут через ui/plural, а типы названы как на чипах дока.

const counts = (image = 0, video = 0, audio = 0) => ({ image, video, audio, text: 0 })

test('состав набора склоняется по числу', () => {
  assert.equal(refSetSummary(counts()), '')
  assert.equal(refSetSummary(counts(1)), '1 image')
  assert.equal(refSetSummary(counts(2)), '2 images')
  assert.equal(refSetSummary(counts(5)), '5 images')
  assert.equal(refSetSummary(counts(14)), '14 images')
  assert.equal(refSetSummary(counts(16)), '16 images')
  assert.equal(refSetSummary(counts(21)), '21 images')
  assert.equal(refSetSummary(counts(2, 1)), '2 images and 1 video')
  assert.equal(refSetSummary(counts(2, 1, 3)), '2 images, 1 video and 3 audio')
})

test('предел «не больше» согласован с числом', () => {
  const text = (max: number) => tooManyText('М', 'image', max, max + 1)
  assert.equal(text(1), 'Model “М” accepts no more than 1 image (selected: 2).')
  assert.equal(text(2), 'Model “М” accepts no more than 2 images (selected: 3).')
  assert.equal(text(5), 'Model “М” accepts no more than 5 images (selected: 6).')
  assert.equal(text(14), 'Model “М” accepts no more than 14 images (selected: 15).')
  assert.equal(text(16), 'Model “М” accepts no more than 16 images (selected: 17).')
  assert.equal(text(21), 'Model “М” accepts no more than 21 images (selected: 22).')
  assert.equal(tooManyText('М', 'video', 3, 4), 'Model “М” accepts no more than 3 video (selected: 4).')
  assert.equal(tooManyTotalText('М', 1, 2), 'Model “М” accepts no more than 1 reference per run (selected: 2).')
  assert.equal(tooManyTotalText('М', 12, 13), 'Model “М” accepts no more than 12 references per run (selected: 13).')
})

test('предел «не меньше» согласован с числом, а единственный недостающий назван прямо', () => {
  assert.equal(tooFewText('М', 'image', 2, 1), 'Model “М” needs at least 2 images (selected: 1).')
  assert.equal(tooFewText('М', 'image', 5, 2), 'Model “М” needs at least 5 images (selected: 2).')
  assert.equal(tooFewText('М', 'image', 1, 0), 'Model “М” needs a reference: image.')
  assert.equal(tooFewText('М', 'audio', 1, 0), 'Model “М” needs a reference: audio.')
})

test('generation types use the English dock labels', () => {
  assert.equal(kindLabel('image'), 'Image')
  assert.equal(kindLabel('video'), 'Video')
  assert.equal(kindLabel('audio'), 'Audio')
  assert.equal(wrongKindText('GPT Image 2', 'video'), 'Model “GPT Image 2” is not suitable for type “Video”.')
  for (const kind of ['image', 'video', 'audio'] as const) {
    assert.doesNotMatch(autoRefusalText(kind, counts(3)), /«(?:image|video|audio)»/u)
  }
})

test('отказ «Авто» различает набор и его отсутствие', () => {
  assert.equal(
    autoRefusalText('video', counts(12)),
    'No model for type “Video” supports this set: 12 images. Remove some references or choose a model manually.',
  )
  assert.equal(
    autoRefusalText('audio', counts()),
    'No model for type “Audio” runs without references. Add a reference or choose a model manually.',
  )
})

test('подпись пункта «Авто»: модель названа только у выбранного', () => {
  assert.equal(autoOptionLabel({ selected: false, modelName: 'GPT Image 2' }), 'Auto')
  assert.equal(autoOptionLabel({ selected: true, modelName: 'GPT Image 2' }), 'Auto · GPT Image 2')
  assert.equal(autoOptionLabel({ selected: true, modelName: null }), 'Auto · no model')
  // пока каталог не загружен, говорить «нет модели» рано
  assert.equal(autoOptionLabel({ selected: true, modelName: null, catalogReady: false }), 'Auto')
})
